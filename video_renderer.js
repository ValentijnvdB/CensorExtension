/**
 * video_renderer.js – Output canvas, frame buffer, and state machine
 *
 * State machine:
 *   IDLE → BUFFERING → PLAYING → BUFFERING (on seek / buffer starvation)
 *
 * The renderer never calls source.play() or source.pause(). Playback of the
 * source video is owned entirely by the user/player. We only observe events
 * and nudge source.currentTime for audio sync.
 *
 * Prebuffering: capture starts when the user presses play. We collect frames
 * for videoPrebufferSeconds before starting canvas playback, so the canvas
 * always has frames ready ahead of the display position.
 */

const RendererState = Object.freeze({
    IDLE:      "IDLE",
    BUFFERING: "BUFFERING",
    PLAYING:   "PLAYING",
});

const SYNC_THRESHOLD_S = 0.15;

class VideoRenderer {
    constructor(sourceVideo, outputCanvas, onNeedFrames) {
        this._source       = sourceVideo;
        this._canvas       = outputCanvas;
        this._ctx          = outputCanvas.getContext("2d");
        this._onNeedFrames = onNeedFrames;

        this._state     = RendererState.IDLE;
        this._seekId    = 0;

        this._buffer    = new Map(); // frameNum → ImageBitmap
        this._nextFrame = 0;

        this._rafHandle     = null;
        this._lastTickTime  = null;
        this._playStartTime = null;
        this._playStartSrcT = null;

        this._rttSamples        = [];
        this._frameDispatchTime = new Map();
        this._prebufferFrames   = 0;

        // Set true whenever the renderer itself calls source.play/pause,
        // so the pipeline ignores those non-user-initiated events.
        this.internalPlayback = false;

        // True if we paused the source video due to buffer starvation,
        // so we know to resume it when frames are ready again.
        this._sourcePausedByUs = false;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    get seekId() { return this._seekId; }
    get state()  { return this._state; }

    /** Called by VideoPipeline when the WS connects */
    start() {
        // Don't enter buffering yet — wait for the user to press play.
        // The canvas will just be blank/black until then.
        this._state = RendererState.IDLE;
    }

    /** Called by VideoPipeline when the WS drops */
    onWsClose() {
        this._state = RendererState.IDLE;
        this._stopPlaybackLoop();
    }

    recordFrameDispatch(frameNum) {
        this._frameDispatchTime.set(frameNum, performance.now());
    }

    receiveFrame(seekId, frameNum, bytes, onConsumed) {
        if (seekId !== this._seekId) {
            onConsumed();
            return;
        }

        const dispatched = this._frameDispatchTime.get(frameNum);
        if (dispatched !== undefined) {
            this._recordRtt(performance.now() - dispatched);
            this._frameDispatchTime.delete(frameNum);
        }

        createImageBitmap(new Blob([bytes])).then(bitmap => {
            onConsumed();
            this._buffer.set(frameNum, bitmap);
            if (this._state === RendererState.BUFFERING) {
                this._checkPrebuffer();
            }
        }).catch(err => {
            onConsumed();
            console.warn("[VideoCensor] Failed to decode frame", frameNum, err);
        });
    }

    onSeeked() {
        this._seekId++;
        this._nextFrame = 0;
        this._frameDispatchTime.clear();
        this._rttSamples = [];
        for (const [, bmp] of this._buffer) bmp.close();
        this._buffer.clear();
        this._stopPlaybackLoop();
        // Re-enter buffering — capture will restart via _onNeedFrames
        this._enterBuffering(false);
    }

    onPaused() {
        // User paused manually — clear our pause flag so we don't
        // resume the video when frames arrive; that's the user's call.
        this._sourcePausedByUs = false;
        this._stopPlaybackLoop();
        if (this._state === RendererState.PLAYING) {
            this._state = RendererState.BUFFERING;
            this._showBufferingOverlay(true);
        }
    }

    onResumed() {
        if (this._state === RendererState.IDLE || this._state === RendererState.BUFFERING) {
            this._enterBuffering(false);
        } else if (this._state === RendererState.PLAYING) {
            this._startPlaybackLoop();
        }
    }

    // ── State machine ─────────────────────────────────────────────────────────

    _enterBuffering(wasPlaying = false) {
        this._state = RendererState.BUFFERING;
        this._stopPlaybackLoop();

        const fps  = this._estimateFps();
        const secs = (typeof videoPrebufferSeconds !== "undefined") ? videoPrebufferSeconds : 3;
        this._prebufferFrames = Math.ceil(fps * secs);

        this._showBufferingOverlay(true);

        if (wasPlaying && !this._source.paused) {
            this.internalPlayback = true;
            this._sourcePausedByUs = true;
            this._source.pause();
            // We don't set internalPlayback to false until the event loop clears
            // to ensure the pipeline doesn't catch the 'pause' event as a user action.
            setTimeout(() => { this.internalPlayback = false; }, 0);
        }

        // This triggers this._capture.start() via the callback in VideoPipeline
        this._onNeedFrames();
    }

    _checkPrebuffer() {
        console.log("[VideoCensor] checkPrebuffer: buffer=", this._buffer.size, "/", this._prebufferFrames);
        if (this._buffer.size >= this._prebufferFrames) {
            this._enterPlaying();
        }
    }

    _enterPlaying() {
        this._state = RendererState.PLAYING;
        this._clearOverlay();

        this._lastTickTime  = null; // reset so first frame shows immediately
        this._playStartTime = performance.now();
        this._playStartSrcT = this._source.currentTime;

        // Resume the source video if we paused it during buffering.
        if (this._sourcePausedByUs) {
            this._sourcePausedByUs = false;
            this.internalPlayback = true;
            this._source.play()
                .then(() => { this.internalPlayback = false; })
                .catch(() => { this.internalPlayback = false; });
        }

        this._startPlaybackLoop();
    }

    // ── Playback loop ─────────────────────────────────────────────────────────

    _startPlaybackLoop() {
        if (this._rafHandle !== null) return;
        this._tick();
    }

    _stopPlaybackLoop() {
        if (this._rafHandle !== null) {
            cancelAnimationFrame(this._rafHandle);
            this._rafHandle = null;
        }
    }

    _tick() {
        this._rafHandle = requestAnimationFrame((now) => {
            this._rafHandle = null;
            if (this._state !== RendererState.PLAYING) return;

            const frameDuration = 1000 / VIDEO_FPS_TARGET;
            if (this._lastTickTime !== null) {
                const elapsed = now - this._lastTickTime;
                if (elapsed < frameDuration * 0.9) {
                    this._tick();
                    return;
                }
            }
            this._lastTickTime = now;

            // Find the specific frame index assigned by the capture unit
            const bitmap = this._buffer.get(this._nextFrame);

            if (bitmap) {
                // ... (drawing logic same as before) ...
                this._ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
                this._buffer.delete(this._nextFrame);
                this._nextFrame++; // Advance to the next EXPECTED dropped-frame index
                this._correctAudioSync();
            } else {
                // If we are missing a frame, check if a FUTURE frame exists.
                // If it does, we just skipped one; if not, we are starving.
                const hasFutureFrame = Array.from(this._buffer.keys()).some(k => k > this._nextFrame);
                if (hasFutureFrame) {
                    this._nextFrame++;
                } else {
                    this._enterBuffering(true);
                    return;
                }
            }

            this._tick();
        });
    }

    // ── Audio sync ────────────────────────────────────────────────────────────

    _correctAudioSync() {
        if (this._playStartTime === null) return;
        const fps             = this._estimateFps();
        const expectedSrcTime = this._playStartSrcT + (this._nextFrame - 1) / fps;
        const drift           = this._source.currentTime - expectedSrcTime;
        if (Math.abs(drift) > SYNC_THRESHOLD_S) {
            // Keep internalPlayback true until the 'seeked' event fires —
            // currentTime assignment fires 'seeked' asynchronously, so clearing
            // the flag synchronously would let the pipeline treat it as a user seek.
            this.internalPlayback = true;
            const onSyncSeeked = () => { this.internalPlayback = false; };
            this._source.addEventListener("seeked", onSyncSeeked, { once: true });
            this._source.currentTime = expectedSrcTime;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _recordRtt(rttMs) {
        this._rttSamples.push(rttMs);
        if (this._rttSamples.length > 30) this._rttSamples.shift();
    }

    _estimateFps() {
        return VIDEO_FPS_TARGET; // The renderer now operates at the throttled rate
    }

    _showBufferingOverlay(show) {
        if (!show) return;
        const w = this._canvas.width  || 320;
        const h = this._canvas.height || 180;
        this._ctx.fillStyle = "rgba(0,0,0,0.6)";
        this._ctx.fillRect(0, 0, w, h);
        this._ctx.fillStyle = "#ffffff";
        this._ctx.font = "16px sans-serif";
        this._ctx.textAlign = "center";
        this._ctx.textBaseline = "middle";
        this._ctx.fillText("Buffering…", w / 2, h / 2);
    }

    _clearOverlay() {
        // Draw the first buffered frame immediately so there's no black flash
        const bitmap = this._buffer.get(this._nextFrame);
        if (bitmap) {
            if (this._canvas.width !== bitmap.width || this._canvas.height !== bitmap.height) {
                this._canvas.width  = bitmap.width;
                this._canvas.height = bitmap.height;
            }
            this._ctx.drawImage(bitmap, 0, 0);
            // Don't consume it from the buffer — _tick will do that
        }
    }

    destroy() {
        this._stopPlaybackLoop();
        for (const [, bmp] of this._buffer) bmp.close();
        this._buffer.clear();
    }
}
