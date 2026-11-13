/**
 * video_capture.js – Frame capture from a source <video> element
 *
 * Captures the frames the source presents while it plays, via
 * requestVideoFrameCallback (or rAF as a fallback), on a fixed grid of
 * 1/videoTargetFps of media time. The source plays normally: the picture is
 * shown `videoDelaySeconds` later (VideoRenderer), which is the time the
 * backend gets to censor a frame. There is no seeking.
 *
 * At most videoMaxInFlight frames are on their way to and from the backend; a
 * due frame beyond that is skipped, so a slow backend gives a lower frame rate
 * instead of a growing queue.
 *
 * captureStill() captures the current frame once, for a paused video (start,
 * or a seek while paused).
 *
 * Seeks and frame numbers:
 *   Frame numbers never restart, so a frame from before a seek never shares a
 *   number with one after it. Each frame is tagged with the seekId at the
 *   moment it is captured (getSeekId()); a frame whose seekId is stale by the
 *   time it is encoded is dropped instead of sent.
 *
 * Emits: onFrame(frameNum: number, captureTime: number, bytes: ArrayBuffer, seekId: number)
 *   captureTime is the frame's time in ms on the renderer's timeline, which
 *   goes on across loops (toTimeline, see video_renderer.js).
 */

// rVFC's mediaTime is used when it is this close to currentTime (s). Firefox
// counts it on after a loop while currentTime starts over at 0.
const CAPTURE_MEDIA_TIME_TOLERANCE = 0.5;

class VideoCapture {
    /**
     * @param {HTMLVideoElement} sourceVideo
     * @param {function(frameNum: number, captureTime: number, bytes: ArrayBuffer, seekId: number)} onFrame
     * @param {function(): number} getSeekId – the renderer's current seekId
     * @param {function(number): number} toTimeline – source time (s) → the renderer's timeline (s)
     */
    constructor(sourceVideo, onFrame, getSeekId, toTimeline = t => t) {
        this._source     = sourceVideo;
        this._onFrame    = onFrame;
        this._getSeekId  = getSeekId;
        this._toTimeline = toTimeline;

        this._frameNum      = 0;
        this._capturing     = false;
        this._inFlightCount = 0;
        this._handle        = null;   // rVFC or rAF handle
        this._lastVideoTime = -1;     // rAF fallback: last media time seen
        // Media time (s) the next capture is due; null = capture the next frame.
        this._nextDue       = null;

        this._useRvfc = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
        this._boundLoop = this._loop.bind(this);

        // Instrumentation: dispatch timestamps (ms) of the last 10 s, frames skipped.
        this._dispatchTimestamps = [];
        this._lastFpsLog         = 0;
        this._skipped            = 0;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Start capturing while the source plays. */
    start() {
        if (this._capturing) return;
        this._capturing = true;
        this._schedule();
    }

    stop() {
        this._capturing = false;
        this._cancel();
    }

    /**
     * Forget everything of the current seek. Frame numbers keep counting, and
     * frames still being encoded are dropped (their seekId is stale).
     */
    reset() {
        this._inFlightCount = 0;
        this._nextDue       = null;
        this._lastVideoTime = -1;
    }

    /** A frame came back from the backend (or failed). */
    frameCompleted() {
        this._inFlightCount = Math.max(0, this._inFlightCount - 1);
    }

    /** Capture the frame shown now, once (a paused source). */
    captureStill() {
        this._captureCurrentFrame(this._source.currentTime);
    }

    destroy() {
        this.stop();
    }

    // ── Loop ──────────────────────────────────────────────────────────────────

    _schedule() {
        if (!this._capturing || this._handle !== null) return;
        this._handle = this._useRvfc
            ? this._source.requestVideoFrameCallback(this._boundLoop)
            : requestAnimationFrame(this._boundLoop);
    }

    _cancel() {
        if (this._handle === null) return;
        if (this._useRvfc) this._source.cancelVideoFrameCallback(this._handle);
        else cancelAnimationFrame(this._handle);
        this._handle = null;
    }

    _loop(now, metadata) {
        this._handle = null;
        if (!this._capturing) return;

        // rVFC also fires for a frame shown by a seek while paused: those come
        // from captureStill(). The presented frame's own time; currentTime may
        // already be past it.
        if (!this._source.paused && !this._source.seeking) {
            let t = this._source.currentTime;
            const mediaTime = metadata?.mediaTime;
            if (mediaTime !== undefined && Math.abs(mediaTime - t) < CAPTURE_MEDIA_TIME_TOLERANCE) t = mediaTime;
            const isNew = this._useRvfc || t !== this._lastVideoTime;
            this._lastVideoTime = t;
            if (isNew && this._isDue(t)) {
                if (this._inFlightCount < videoMaxInFlight) this._captureCurrentFrame(t);
                else this._skipped++;
            }
        }
        this._schedule();
    }

    /**
     * Whether a frame at media time t (s) should be captured, keeping to
     * videoTargetFps on average. Captures are due on a fixed grid of
     * 1/videoTargetFps; "at least 1/fps since the last capture" would round
     * down to the source's frames (about 8 fps for a 24 or 25 fps source at 10).
     */
    _isDue(t) {
        const interval = 1 / videoTargetFps;
        // Start the grid here, also after a jump (a seek, or a stall longer than a frame).
        if (this._nextDue === null || t < this._nextDue - 2 * interval || t > this._nextDue + 2 * interval) {
            this._nextDue = t + interval;
            return true;
        }
        if (t + 0.001 < this._nextDue) return false;
        this._nextDue += interval;
        // Never more than one capture behind (e.g. a source slower than the target).
        if (this._nextDue <= t) this._nextDue = t + interval;
        return true;
    }

    // ── Capture ───────────────────────────────────────────────────────────────

    /** Capture the frame the source shows now; `time` is its media time in seconds. */
    _captureCurrentFrame(time) {
        const v = this._source;
        if (!v.videoWidth) return;

        const captureTime = this._toTimeline(time) * 1000;
        const frameNum    = this._frameNum++;
        const seekId      = this._getSeekId();

        this._inFlightCount++;

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width  = v.videoWidth;
        tempCanvas.height = v.videoHeight;
        tempCanvas.getContext("2d").drawImage(v, 0, 0);

        // A seek while encoding makes the frame stale: drop it. reset() already
        // set the in-flight count of the new seek, so it isn't decremented.
        const isStale = () => seekId !== this._getSeekId();

        tempCanvas.toBlob((blob) => {
            if (isStale()) return;
            if (!blob) {
                this.frameCompleted();
                return;
            }
            blob.arrayBuffer().then(bytes => {
                if (isStale()) return;
                this._recordDispatch();
                this._onFrame(frameNum, captureTime, bytes, seekId);
            });
        }, `image/${videoFrameFormat}`, frameCompressionLevel);
    }

    // ── FPS instrumentation ───────────────────────────────────────────────────

    _recordDispatch() {
        const now = performance.now();
        this._dispatchTimestamps.push(now);

        const cutoff = now - 10_000;
        while (this._dispatchTimestamps.length > 0 && this._dispatchTimestamps[0] < cutoff) {
            this._dispatchTimestamps.shift();
        }

        if (now - this._lastFpsLog >= 1_000) {
            this._lastFpsLog = now;
            const windowMs = Math.min(now - (this._dispatchTimestamps[0] ?? now), 10_000);
            const avgFps   = windowMs > 0
                ? (this._dispatchTimestamps.length / (windowMs / 1_000)).toFixed(2)
                : "0.00";
            console.log(`[VideoCensor] send FPS (last 10 s): ${avgFps}, skipped (in-flight limit): ${this._skipped}`);
        }
    }
}
