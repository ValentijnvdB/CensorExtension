/**
 * video_capture.js – Frame capture from a source <video> element
 *
 * Two capture modes:
 *   playing: requestVideoFrameCallback (or rAF fallback) — driven by the
 *            video's natural cadence, fires once per new frame.
 *   paused:  setTimeout loop at 1000/fps ms — keeps sending frames to the
 *            backend even when the source is paused due to buffer starvation,
 *            so the buffer can refill and playback can resume.
 *
 * We never seek the video ourselves.
 *
 * Emits: onFrame(frameNum: number, bytes: ArrayBuffer)
 */

class VideoCapture {
    constructor(sourceVideo, onFrame) {
        this._source    = sourceVideo;
        this._onFrame   = onFrame;
        this._frameNum  = 0;
        this._capturing = false;

        this._canvas = document.createElement("canvas");
        this._ctx    = this._canvas.getContext("2d");

        this._inFlightCount = 0;
        this._rafHandle     = null;   // rVFC / rAF handle (playing mode)
        this._timerHandle   = null;   // setTimeout handle (paused mode)
        this._lastVideoTime = -1;

        this._boundRvfcLoop    = this._rvfcLoop.bind(this);
        this._boundRafFallback = this._rafFallbackLoop.bind(this);
        this._boundPausedTick  = this._pausedTick.bind(this);

        // Switch modes automatically when the source video pauses/plays
        this._boundOnPause = () => { if (this._capturing) this._enterPausedMode(); };
        this._boundOnPlay  = () => { if (this._capturing) this._enterPlayingMode(); };
        this._source.addEventListener("pause", this._boundOnPause);
        this._source.addEventListener("play",  this._boundOnPlay);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    start() {
        if (this._capturing) return;
        this._capturing = true;
        if (this._source.paused) {
            this._enterPausedMode();
        } else {
            this._enterPlayingMode();
        }
    }

    stop() {
        this._capturing = false;
        this._cancelHandles();
    }

    reset() {
        this.stop();
        this._frameNum      = 0;
        this._inFlightCount = 0;
        this._lastVideoTime = -1;
    }

    get isStepping() { return false; }

    frameCompleted() {
        this._inFlightCount = Math.max(0, this._inFlightCount - 1);
        console.log("[VideoCensor] frameCompleted, inFlight=", this._inFlightCount, "paused=", this._source.paused, "rafHandle=", this._rafHandle, "timerHandle=", this._timerHandle);
        // Resume whichever loop was stalled due to back-pressure
        if (this._capturing && this._rafHandle === null && this._timerHandle === null) {
            console.log("[VideoCensor] ============================== RESUMING LOOP ======================");
            if (this._source.paused) {
                this._enterPausedMode();
            } else {
                this._enterPlayingMode();
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
        this._cancelTimerHandle(); // stop paused loop if running
        this._scheduleRvfc();
    }

    _scheduleRvfc() {
        if (!this._capturing) return;
        // CRITICAL: If the video is paused (even by the renderer),
        // rvfc/rAF will not fire. We must switch to the timer loop.
        if (this._source.paused) {
            this._enterPausedMode();
            return;
        }

        if (this._inFlightCount > (VIDEO_MAX_IN_FLIGHT || 10)) return;
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
        const currentTime = this._source.currentTime;

        // Only capture if the video has progressed by at least 1/FPS_TARGET seconds
        if (this._lastVideoTime === -1 || (currentTime - this._lastVideoTime) >= targetInterval) {
            this._lastVideoTime = currentTime;
            this._captureCurrentFrame();
        }

        if (this._inFlightCount <= VIDEO_MAX_IN_FLIGHT) {
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
        if (this._inFlightCount <= VIDEO_MAX_IN_FLIGHT) {
            this._rafHandle = requestAnimationFrame(this._boundRafFallback);
        }
    }

    // ── Paused mode: setTimeout loop ──────────────────────────────────────────

    _enterPausedMode() {
        console.log("[VideoCensor] capture: entering paused mode, inFlight=", this._inFlightCount);
        this._cancelRafHandle(); // stop rVFC if running
        this._schedulePausedTick();
    }

    _schedulePausedTick() {
        if (!this._capturing) return;
        if (this._inFlightCount > (VIDEO_MAX_IN_FLIGHT || 10)) return;
        if (this._timerHandle !== null) return;

        // Use a fixed high-frequency tick when buffering to refill quickly
        const fps = 25;
        this._timerHandle = setTimeout(this._boundPausedTick, 1000 / fps);
    }

    _pausedTick() {
        this._timerHandle = null;
        if (!this._capturing) return;

        this._captureCurrentFrame();

        if (this._source.paused) {
            this._schedulePausedTick();
        } else {
            this._enterPlayingMode();
        }
    }

    // ── Shared ────────────────────────────────────────────────────────────────

    _captureCurrentFrame() {
        const v = this._source;
        if (!v.videoWidth) return;

        // 1. Immediately increment in-flight count
        // This allows the next RVFC tick to proceed while this frame is encoding
        this._inFlightCount++;

        // 2. Use a "Pool" of canvases if needed, or draw immediately
        // If you draw to the same canvas repeatedly while toBlob is running,
        // you might get "smearing". It is safer to use a temporary canvas for the encoding.
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = v.videoWidth;
        tempCanvas.height = v.videoHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(v, 0, 0);

        const frameNum = this._frameNum++;

        // 3. Fire and Forget the encoding
        tempCanvas.toBlob((blob) => {
            if (!blob) {
                this._inFlightCount--;
                return;
            }
            blob.arrayBuffer().then(bytes => {
                // This frame is now TRULY in flight (on the wire)
                this._onFrame(frameNum, bytes);
                // Note: _inFlightCount is decremented in VideoRenderer.receiveFrame
            });
        }, `image/${videoFrameFormat}`, frameCompressionLevel);
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

    _cancelTimerHandle() {
        if (this._timerHandle !== null) {
            clearTimeout(this._timerHandle);
            this._timerHandle = null;
        }
    }

    _cancelHandles() {
        this._cancelRafHandle();
        this._cancelTimerHandle();
    }
}
