/**
 * video_renderer.js – Shows the censored frames a fixed delay behind the source
 *
 * Delay line: the hidden source video plays normally and VideoCapture sends its
 * frames to the backend as they are presented. The canvas shows the source's
 * picture `delay` seconds later, and AudioDelay delays its audio by the same
 * amount, so the backend has `delay` seconds to censor each frame:
 *
 *   display time = source.currentTime − (delay + audio output latency) × playbackRate
 *
 * The renderer never pauses or seeks the source. Pausing the source freezes
 * the display time (and AudioDelay freezes the audio), so they stay together.
 *
 * Each rAF tick draws the newest frame whose media time is ≤ the display time,
 * and never goes back to an older one. A frame that arrives after its time is
 * still drawn if it is newer than the one shown (late, but in order). When no
 * frame came for a while, the last one stays with a "Waiting for server…" note.
 *
 * flush() (a seek, or a new source) forgets every frame and starts a new
 * segment at the source's position: until the display time reaches it, the
 * canvas shows "Buffering…" (the display time is clamped to the segment
 * start, so the time shown in the control bar is the seek target).
 *
 * At the end of the video the source stops, but the last `delay` seconds
 * still have to be shown: onEnded() runs the display time on from there on
 * the wall clock (the audio plays out of the delay meanwhile).
 *
 * Frames are kept encoded and decoded shortly before they are due, so the
 * buffer holds about delay × fps small images instead of decoded bitmaps.
 */

const RENDER_DECODE_AHEAD_MS = 500;   // decode frames this long before they are due
const RENDER_LATE_MS         = 1000;  // no new frame for this long: "Waiting for server…"
const RENDER_STATS_MS        = 5000;  // log late frames at most this often
// A frame up to this much before a seek target can be the one shown there.
const RENDER_SEEK_TOLERANCE_MS = 250;

class VideoRenderer {
    /**
     * @param {HTMLVideoElement}  sourceVideo
     * @param {HTMLCanvasElement} outputCanvas
     * @param {AudioDelay}        audio
     * @param {number}            delaySeconds – the same delay as `audio`'s
     */
    constructor(sourceVideo, outputCanvas, audio, delaySeconds) {
        this._source = sourceVideo;
        this._canvas = outputCanvas;
        this._ctx    = outputCanvas.getContext("2d");
        this._audio  = audio;
        this._delay  = delaySeconds;

        this._seekId = 0;

        // frameNum → { captureTime (media ms), bytes, bitmap: ImageBitmap|null, decoding }
        this._buffer = new Map();
        // frameNum → captureTime (media ms), recorded at dispatch
        this._captureTimeMap = new Map();

        this._segmentStart = sourceVideo.currentTime;   // seconds
        this._shownTime    = null;    // media ms of the frame on the canvas (this segment)
        this._overlay      = null;    // "buffering" | "late" | null — what is drawn over it
        this._tailStart    = null;    // performance.now() when the source ended
        this._tailFrom     = 0;       // display time (s) at that moment

        this._rafHandle = null;
        this._stats     = { received: 0, late: 0, lastLog: 0 };

        this._showOverlay("buffering");
        this._startLoop();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    get seekId() { return this._seekId; }

    /** True while the video plays. */
    get wantsPlayback() { return !this._source.paused; }

    /** The playback position shown, in seconds. */
    get displayTime() { return this._clock(); }

    /** A pause asked for by the control bar (VideoControls). */
    userPause() {
        if (!this._source.paused) this._source.pause();
    }

    /** Record a frame's media time (ms) when it is sent, for when it comes back. */
    recordFrameDispatch(frameNum, captureTime) {
        this._captureTimeMap.set(frameNum, captureTime);
    }

    /** A censored frame came back from the backend. */
    receiveFrame(seekId, frameNum, bytes) {
        if (seekId !== this._seekId) return;
        const captureTime = this._captureTimeMap.get(frameNum);
        this._captureTimeMap.delete(frameNum);
        if (captureTime === undefined) return;

        // Captured just before a seek landed (it shows the old position).
        if (captureTime < this._segmentStart * 1000 - RENDER_SEEK_TOLERANCE_MS) return;

        this._stats.received++;
        if (captureTime < this._clock() * 1000) this._stats.late++;

        // Older than what is shown already: never go back.
        if (this._shownTime !== null && captureTime <= this._shownTime) return;
        this._buffer.set(frameNum, { captureTime, bytes, bitmap: null, decoding: false });
    }

    /** The backend failed a frame: forget it. */
    forgetFrame(seekId, frameNum) {
        if (seekId === this._seekId) this._captureTimeMap.delete(frameNum);
    }

    /** Forget every frame and start a new segment at the source's position (a seek). */
    flush() {
        this._seekId++;
        this._captureTimeMap.clear();
        for (const entry of this._buffer.values()) entry.bitmap?.close();
        this._buffer.clear();
        this._segmentStart = this._source.currentTime;
        this._shownTime    = null;
        this._tailStart    = null;
        this._showOverlay("buffering");
        this._startLoop();
    }

    /** The source ended: show its last `delay` seconds on the wall clock. */
    onEnded() {
        if (this._tailStart !== null) return;
        this._tailFrom  = this._clock();
        this._tailStart = performance.now();
        this._startLoop();
    }

    destroy() {
        this._stopLoop();
        for (const entry of this._buffer.values()) entry.bitmap?.close();
        this._buffer.clear();
        this._captureTimeMap.clear();
    }

    // ── Clock ─────────────────────────────────────────────────────────────────

    /** The media time (s) to show now. */
    _clock() {
        return Math.max(this._segmentStart, this._rawClock());
    }

    /** _clock() without the clamp to the segment start (below it while buffering). */
    _rawClock() {
        const rate = this._source.playbackRate || 1;
        let t;
        if (this._tailStart !== null) {
            t = this._tailFrom + (performance.now() - this._tailStart) / 1000 * rate;
            const duration = this._source.duration;
            if (isFinite(duration)) t = Math.min(t, duration);
        } else {
            t = this._source.currentTime - (this._delay + this._audio.outputLatency) * rate;
        }
        return t;
    }

    // ── Loop ──────────────────────────────────────────────────────────────────

    _startLoop() {
        if (this._rafHandle !== null) return;
        this._rafHandle = requestAnimationFrame(() => this._tick());
    }

    _stopLoop() {
        if (this._rafHandle !== null) cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
    }

    _tick() {
        this._rafHandle = null;
        const now = this._clock() * 1000;

        // The audio plays while the shown time moves (not while buffering).
        this._audio.sync(now / 1000, this._isAdvancing() && this._rawClock() > this._segmentStart);

        // Newest decoded frame that is due; start decoding the ones due soon.
        let best = null, bestNum = null;
        for (const [frameNum, entry] of this._buffer) {
            if (entry.captureTime <= now + RENDER_DECODE_AHEAD_MS) this._decode(frameNum, entry);
            if (entry.captureTime <= now && entry.bitmap &&
                (best === null || entry.captureTime > best.captureTime)) {
                best = entry;
                bestNum = frameNum;
            }
        }

        if (best !== null) {
            // Drop it and everything older (also frames still decoding).
            for (const [frameNum, entry] of this._buffer) {
                if (entry.captureTime <= best.captureTime) {
                    if (frameNum !== bestNum) entry.bitmap?.close();
                    this._buffer.delete(frameNum);
                }
            }
            this._draw(best.bitmap);
            best.bitmap.close();
            this._shownTime = best.captureTime;
            this._overlay   = null;
        } else if (this._shownTime !== null && this._overlay === null &&
                   now - this._shownTime > RENDER_LATE_MS && this._isAdvancing()) {
            this._showOverlay("late");
        }

        this._logStats();
        this._rafHandle = requestAnimationFrame(() => this._tick());
    }

    /** Whether the display time moves (so a missing frame is the backend's fault). */
    _isAdvancing() {
        if (this._tailStart !== null) return this._clock() < this._source.duration;
        return !this._source.paused && this._source.readyState >= 3;
    }

    _decode(frameNum, entry) {
        if (entry.bitmap || entry.decoding) return;
        entry.decoding = true;
        const seekId = this._seekId;
        createImageBitmap(new Blob([entry.bytes])).then(bitmap => {
            // Shown past, dropped, or flushed meanwhile.
            if (seekId !== this._seekId || this._buffer.get(frameNum) !== entry) {
                bitmap.close();
                return;
            }
            entry.bitmap = bitmap;
            entry.bytes  = null;
        }).catch(err => {
            this._buffer.delete(frameNum);
            console.warn("[VideoCensor] Failed to decode frame", frameNum, err);
        });
    }

    _logStats() {
        const now = performance.now();
        if (now - this._stats.lastLog < RENDER_STATS_MS || !this._stats.received) return;
        if (this._stats.late) {
            console.warn(`[VideoCensor] ${this._stats.late} of ${this._stats.received} frames came after ` +
                `their time: the backend needs more than the ${this._delay}s delay, raise it or lower the FPS`);
        }
        this._stats = { received: 0, late: 0, lastLog: now };
    }

    // ── Drawing ───────────────────────────────────────────────────────────────

    _draw(bitmap) {
        if (this._canvas.width !== bitmap.width || this._canvas.height !== bitmap.height) {
            this._canvas.width  = bitmap.width;
            this._canvas.height = bitmap.height;
        }
        this._ctx.drawImage(bitmap, 0, 0);
    }

    /** Darken what is on the canvas and say why ("buffering" or "late"). */
    _showOverlay(kind) {
        this._overlay = kind;
        const w = this._canvas.width  || 320;
        const h = this._canvas.height || 180;
        const ctx = this._ctx;
        ctx.save();
        if (kind === "buffering") {
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fillRect(0, 0, w, h);
        }
        ctx.fillStyle    = "#ffffff";
        ctx.font         = `${Math.max(14, Math.round(h / 24))}px sans-serif`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        if (kind === "buffering") {
            ctx.fillText("Buffering…", w / 2, h / 2);
        } else {
            const text = "Waiting for server…";
            const pad  = 8;
            const tw   = ctx.measureText(text).width + 2 * pad;
            const th   = Math.max(14, Math.round(h / 24)) + 2 * pad;
            ctx.fillStyle = "rgba(0,0,0,0.6)";
            ctx.fillRect((w - tw) / 2, pad, tw, th);
            ctx.fillStyle = "#ffffff";
            ctx.fillText(text, w / 2, pad + th / 2);
        }
        ctx.restore();
    }
}
