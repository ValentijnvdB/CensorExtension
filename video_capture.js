/**
 * video_capture.js – Frame capture from a source <video> element
 *
 * Two capture modes, selected automatically:
 *
 *   PLAYING (rVFC/rAF):
 *     Used when the source video is playing normally. Fires once per new
 *     frame via requestVideoFrameCallback (or rAF fallback), throttled to
 *     VIDEO_FPS_TARGET.
 *
 *   STEPPING (seek-step loop):
 *     Used when the source is paused — either during initial prebuffering or
 *     when the user has manually paused. Advances source.currentTime by
 *     1/VIDEO_FPS_TARGET per step, waits for the 'seeked' event to confirm
 *     the browser has landed at the new position, then captures the frame.
 *     Gated by VIDEO_MAX_IN_FLIGHT so we don't flood the backend.
 *
 * isStepping is a public flag read by VideoPipeline._onSeeked() to suppress
 * buffer flushes triggered by our own internal seeks.
 *
 * Emits: onFrame(frameNum: number, captureTime: number, bytes: ArrayBuffer)
 *   captureTime is source.currentTime at the moment of capture, used by the
 *   renderer to display frames in sync with the audio clock.
 */

class VideoCapture {
    /**
     * @param {HTMLVideoElement} sourceVideo
     * @param {function(frameNum, captureTime, bytes)} onFrame
     * @param {function(): boolean} isBufferFull
     *   Returns true when the renderer's buffer has enough frames and capture
     *   should stop stepping. Only consulted in stepping mode — in playing mode
     *   the rVFC cadence naturally limits output to the video's frame rate.
     */
    constructor(sourceVideo, onFrame, isBufferFull) {
        this._source       = sourceVideo;
        this._onFrame      = onFrame;
        this._isBufferFull = isBufferFull;
        this._frameNum  = 0;
        this._capturing = false;

        this._inFlightCount = 0;

        // rVFC / rAF state (playing mode)
        this._rafHandle     = null;
        this._lastVideoTime = -1;

        // Seek-step state (stepping mode)
        this._stepping        = false; // true while the seek-step loop is active
        this._stepPending     = false; // true while waiting for 'seeked' to fire
        this._stepQueued      = false; // true if a step was requested while one was in flight

        this._boundRvfcLoop    = this._rvfcLoop.bind(this);
        this._boundRafFallback = this._rafFallbackLoop.bind(this);

        // FPS instrumentation — ring buffer of dispatch timestamps (ms).
        this._dispatchTimestamps = [];
        this._lastFpsLog         = 0;

        // Switch modes when the source transitions between playing and paused.
        this._boundOnPause = () => { if (this._capturing) this._enterSteppingMode(); };
        this._boundOnPlay  = () => { if (this._capturing) this._enterPlayingMode(); };
        this._source.addEventListener("pause", this._boundOnPause);
        this._source.addEventListener("play",  this._boundOnPlay);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** True while the seek-step loop is advancing currentTime internally. */
    get isStepping() { return this._stepping; }

    start() {
        if (this._capturing) return;
        this._capturing = true;
        if (this._source.paused) {
            this._enterSteppingMode();
        } else {
            this._enterPlayingMode();
        }
    }

    stop() {
        this._capturing = false;
        this._cancelRafHandle();
        // Note: we do NOT abort an in-progress step tick here — the pending
        // 'seeked' listener is harmless and will self-cancel on next tick check.
    }

    reset() {
        this.stop();
        this._frameNum      = 0;
        this._inFlightCount = 0;
        this._lastVideoTime = -1;
        this._stepping      = false;
        this._stepPending   = false;
        this._stepQueued    = false;
    }

    /**
     * Called by VideoRenderer once a frame has been decoded and placed in the
     * buffer, decrementing the in-flight count and potentially unblocking the
     * next step.
     */
    frameCompleted() {
        this._inFlightCount = Math.max(0, this._inFlightCount - 1);

        if (!this._capturing) return;

        if (this._source.paused) {
            // Stepping mode: try to schedule the next step. _scheduleStep will
            // re-check isBufferFull and the in-flight gate itself.
            if (!this._stepping) {
                // Buffer may have drained below the full threshold — restart.
                this._enterSteppingMode();
            } else if (this._stepQueued) {
                this._stepQueued = false;
                this._scheduleStep();
            }
        } else {
            // Playing mode: a slot freed up — reschedule rVFC if it was stalled.
            if (this._rafHandle === null) {
                this._scheduleRvfc();
            }
        }
    }

    destroy() {
        this.stop();
        this._source.removeEventListener("pause", this._boundOnPause);
        this._source.removeEventListener("play",  this._boundOnPlay);
    }

    // ── Playing mode: rVFC / rAF ──────────────────────────────────────────────

    _enterPlayingMode() {
        this._stepping = false;
        this._scheduleRvfc();
    }

    _scheduleRvfc() {
        if (!this._capturing) return;
        if (this._source.paused) {
            // Video was paused between the mode switch and this call.
            this._enterSteppingMode();
            return;
        }
        if (this._inFlightCount >= VIDEO_MAX_IN_FLIGHT) return;
        if (this._rafHandle !== null) return;

        if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
            this._rafHandle = this._source.requestVideoFrameCallback(this._boundRvfcLoop);
        } else {
            this._rafHandle = requestAnimationFrame(this._boundRafFallback);
        }
    }

    _rvfcLoop(now, metadata) {
        this._rafHandle = null;
        if (!this._capturing) return;

        const targetInterval = 1 / VIDEO_FPS_TARGET;
        const currentTime    = this._source.currentTime;

        if (this._lastVideoTime === -1 || (currentTime - this._lastVideoTime) >= targetInterval) {
            this._lastVideoTime = currentTime;
            this._captureCurrentFrame();
        }

        if (this._inFlightCount < VIDEO_MAX_IN_FLIGHT) {
            this._scheduleRvfc();
        }
    }

    _rafFallbackLoop() {
        this._rafHandle = null;
        if (!this._capturing) return;
        const vt = this._source.currentTime;
        if (vt !== this._lastVideoTime) {
            this._lastVideoTime = vt;
            this._captureCurrentFrame();
        }
        if (this._inFlightCount < VIDEO_MAX_IN_FLIGHT) {
            this._rafHandle = requestAnimationFrame(this._boundRafFallback);
        }
    }

    _cancelRafHandle() {
        if (this._rafHandle !== null) {
            if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
                this._source.cancelVideoFrameCallback(this._rafHandle);
            } else {
                cancelAnimationFrame(this._rafHandle);
            }
            this._rafHandle = null;
        }
    }

    // ── Stepping mode: seek-step loop ─────────────────────────────────────────

    _enterSteppingMode() {
        this._cancelRafHandle();
        this._stepping = true;
        this._scheduleStep();
    }

    _scheduleStep() {
        if (!this._capturing || !this._stepping) return;
        if (this._stepPending) return; // already waiting for 'seeked'

        // Stop stepping if the renderer's buffer is already full.
        // _enterSteppingMode() / frameCompleted() will restart us if more
        // frames are needed later (e.g. starvation or seek).
        if (this._isBufferFull()) {
            this._stepping = false;
            return;
        }

        if (this._inFlightCount >= VIDEO_MAX_IN_FLIGHT) {
            // Will be retried from frameCompleted()
            this._stepQueued = true;
            return;
        }

        this._stepPending = true;

        // Advance currentTime by one frame interval.
        const nextTime = this._source.currentTime + (1 / VIDEO_FPS_TARGET);
        const duration = this._source.duration;

        if (isFinite(duration) && nextTime > duration) {
            // Reached end of video — stop stepping.
            this._stepping    = false;
            this._stepPending = false;
            return;
        }

        // Wait for the browser to confirm it has seeked to (approximately)
        // the requested position before capturing.
        const onSeeked = () => {
            this._stepPending = false;
            if (!this._capturing || !this._stepping) return;

            // If the source started playing again (user hit play), hand off to
            // playing mode — it will take over from the current position.
            if (!this._source.paused) {
                this._stepping = false;
                this._enterPlayingMode();
                return;
            }

            this._captureCurrentFrame();

            // Schedule the next step (gated again by in-flight count).
            this._scheduleStep();
        };

        this._source.addEventListener("seeked", onSeeked, { once: true });
        this._source.currentTime = nextTime;
    }

    // ── Shared ────────────────────────────────────────────────────────────────

    _captureCurrentFrame() {
        const v = this._source;
        if (!v.videoWidth) return;

        // Record captureTime before any async work so it matches this exact frame.
        //
        // In PLAYING mode we use performance.now() (milliseconds) because
        // source.currentTime only updates at the video's native frame rate and
        // can repeat across multiple capture ticks at VIDEO_FPS_TARGET, making
        // ordering ambiguous. performance.now() is strictly monotonic with
        // sub-millisecond resolution, so every frame in playing mode gets a
        // unique, correctly-ordered timestamp.
        //
        // In STEPPING mode we use source.currentTime (seconds → ms) because
        // the seek-step loop explicitly sets currentTime to known positions —
        // that IS the meaningful ordering key, and performance.now() would
        // just reflect wall-clock dispatch order which could differ if seeks
        // resolve out of order.
        const captureTime = this._stepping
            ? v.currentTime * 1000   // seconds → ms, same unit as performance.now()
            : performance.now();
        const frameNum = this._frameNum++;

        this._inFlightCount++;

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width  = v.videoWidth;
        tempCanvas.height = v.videoHeight;
        tempCanvas.getContext("2d").drawImage(v, 0, 0);

        tempCanvas.toBlob((blob) => {
            if (!blob) {
                this._inFlightCount--;
                return;
            }
            blob.arrayBuffer().then(bytes => {
                this._recordDispatch();
                this._onFrame(frameNum, captureTime, bytes);
            });
        }, `image/${videoFrameFormat}`, frameCompressionLevel);
    }

    // ── FPS instrumentation ───────────────────────────────────────────────────

    _recordDispatch() {
        const now = performance.now();
        this._dispatchTimestamps.push(now);

        // Evict timestamps older than 10 seconds.
        const cutoff = now - 10_000;
        while (this._dispatchTimestamps.length > 0 && this._dispatchTimestamps[0] < cutoff) {
            this._dispatchTimestamps.shift();
        }

        // Log once per second.
        if (now - this._lastFpsLog >= 1_000) {
            this._lastFpsLog = now;
            const windowMs  = Math.min(now - (this._dispatchTimestamps[0] ?? now), 10_000);
            const avgFps    = windowMs > 0
                ? (this._dispatchTimestamps.length / (windowMs / 1_000)).toFixed(2)
                : "0.00";
            console.log(`[VideoCensor] send FPS (last 10 s): ${avgFps}`);
        }
    }
}