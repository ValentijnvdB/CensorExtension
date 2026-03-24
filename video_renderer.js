/**
 * video_renderer.js – Output canvas, frame buffer, and state machine
 *
 * State machine:
 *   IDLE → BUFFERING → PLAYING → BUFFERING (on starvation or seek)
 *
 * BUFFERING:
 *   - Source video is paused internally (internalPlayback = true).
 *   - Canvas shows "Buffering…".
 *   - VideoCapture runs in seek-step mode, advancing currentTime forward.
 *   - On entry, _prebufferOrigin records the currentTime at which buffering
 *     started so we can snap back once the buffer is full.
 *   - Exits to PLAYING when buffer.size >= prebufferFrames.
 *
 * PLAYING:
 *   - Source plays freely — audio is the clock.
 *   - rAF tick finds the frame with the largest captureTime <= source.currentTime
 *     and draws it; all older frames are discarded.
 *   - VideoCapture runs in rVFC mode.
 *   - Transitions back to BUFFERING when the buffer is empty (starvation).
 *
 * User pause during PLAYING:
 *   - Source is already paused by the user; canvas freezes.
 *   - Capture keeps running in seek-step mode to fill the buffer.
 *   - On resume: if buffer already full → PLAYING directly, else → BUFFERING.
 *
 * Audio sync:
 *   The canvas follows source.currentTime — no nudging of currentTime needed.
 *   The "largest captureTime <= currentTime" selection in _tick() provides
 *   natural sync at zero cost.
 */

const RendererState = Object.freeze({
    IDLE:      "IDLE",
    BUFFERING: "BUFFERING",
    PLAYING:   "PLAYING",
});

class VideoRenderer {
    constructor(sourceVideo, outputCanvas, onNeedFrames) {
        this._source       = sourceVideo;
        this._canvas       = outputCanvas;
        this._ctx          = outputCanvas.getContext("2d");
        this._onNeedFrames = onNeedFrames;

        this._state  = RendererState.IDLE;
        this._seekId = 0;

        // frameNum → { bitmap: ImageBitmap, captureTime: number }
        this._buffer    = new Map();
        this._nextFrame = 0; // lowest frameNum not yet displayed

        this._rafHandle = null;

        // captureTime recorded at dispatch, looked up when frame returns.
        // frameNum → captureTime (number, seconds)
        this._captureTimeMap = new Map();

        this._prebufferFrames = 0;
        // source.currentTime at the start of a BUFFERING phase — we snap back
        // here when transitioning to PLAYING so audio starts at the right place.
        this._prebufferOrigin = null;

        // Set true whenever the renderer itself calls source.play/pause so the
        // pipeline ignores those non-user-initiated events.
        this.internalPlayback = false;

        // True if we paused the source due to buffering/starvation.
        this._sourcePausedByUs = false;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    get seekId() { return this._seekId; }
    get state()  { return this._state; }

    /** Returns true when the buffer has reached the prebuffer target. */
    isBufferFull() {
        return this._buffer.size >= this._prebufferFrames;
    }

    /** Called by VideoPipeline when the WS connects. */
    start() {
        this._state = RendererState.IDLE;
    }

    /** Called by VideoPipeline when the WS drops. */
    onWsClose() {
        this._state = RendererState.IDLE;
        this._stopPlaybackLoop();
    }

    /**
     * Record the captureTime for a frame at the moment it is dispatched to
     * the backend, so it is available when the processed frame returns.
     */
    recordFrameDispatch(frameNum, captureTime) {
        this._captureTimeMap.set(frameNum, captureTime);
    }

    /**
     * Called by VideoPipeline when a processed frame arrives from the server.
     * onConsumed() must be called exactly once — it decrements the capture
     * in-flight count.
     */
    receiveFrame(seekId, frameNum, bytes, onConsumed) {
        if (seekId !== this._seekId) {
            onConsumed();
            return;
        }

        const captureTime = this._captureTimeMap.get(frameNum);
        this._captureTimeMap.delete(frameNum);

        createImageBitmap(new Blob([bytes])).then(bitmap => {
            onConsumed();
            this._buffer.set(frameNum, {
                bitmap,
                captureTime: captureTime ?? 0,
            });
            if (this._state === RendererState.BUFFERING) {
                this._checkPrebuffer();
            }
        }).catch(err => {
            onConsumed();
            console.warn("[VideoCensor] Failed to decode frame", frameNum, err);
        });
    }

    /** Called by VideoPipeline on a user-initiated seek. */
    onSeeked() {
        this._seekId++;
        this._nextFrame = 0;
        this._captureTimeMap.clear();
        for (const [, { bitmap }] of this._buffer) bitmap.close();
        this._buffer.clear();
        this._stopPlaybackLoop();
        this._enterBuffering();
    }

    /** Called by VideoPipeline on a user-initiated pause. */
    onPaused() {
        // Clear our ownership flag — the user paused, not us.
        // We must NOT resume the source when the buffer refills.
        this._sourcePausedByUs = false;
        this._stopPlaybackLoop();
        // Keep state as-is; capture will keep stepping to fill the buffer.
        // If we were PLAYING, stay logically in a "paused-playing" sub-state
        // that onResumed() will recover from.
    }

    /** Called by VideoPipeline on a user-initiated play/resume. */
    onResumed() {
        if (this._state === RendererState.IDLE) {
            this._enterBuffering();
            return;
        }
        if (this._state === RendererState.BUFFERING) {
            // Still buffering — the capture loop is already running; nothing to do.
            return;
        }
        if (this._state === RendererState.PLAYING) {
            // Was playing, user paused then resumed.
            if (this._buffer.size >= this._prebufferFrames) {
                this._startPlaybackLoop();
            } else {
                this._enterBuffering();
            }
        }
    }

    destroy() {
        this._stopPlaybackLoop();
        for (const [, { bitmap }] of this._buffer) bitmap.close();
        this._buffer.clear();
    }

    // ── State machine ─────────────────────────────────────────────────────────

    _enterBuffering() {
        this._state = RendererState.BUFFERING;
        this._stopPlaybackLoop();

        const fps  = VIDEO_FPS_TARGET;
        const secs = (typeof videoPrebufferSeconds !== "undefined") ? videoPrebufferSeconds : 3;
        this._prebufferFrames = Math.ceil(fps * secs);

        // Record where we are so we can snap back when PLAYING starts.
        this._prebufferOrigin = this._source.currentTime;

        this._showBufferingOverlay();

        // Pause the source if it isn't already — capture will seek-step forward
        // from here to fill the buffer.
        if (!this._source.paused) {
            this.internalPlayback  = true;
            this._sourcePausedByUs = true;
            // Clear internalPlayback once the pause event has actually fired,
            // not just after one event-loop tick, to avoid a race where a
            // bounce 'play' event slips through before the pause lands.
            this._source.addEventListener("pause", () => {
                this.internalPlayback = false;
            }, { once: true });
            this._source.pause();
        }

        // Signal the pipeline to start capture (capture will see source.paused
        // and enter stepping mode automatically).
        this._onNeedFrames();
    }

    _checkPrebuffer() {
        if (this._buffer.size >= this._prebufferFrames) {
            this._enterPlaying();
        }
    }

    _enterPlaying() {
        this._state = RendererState.PLAYING;

        // Mark internalPlayback now and keep it true across the entire
        // pause → snap-back seek → play sequence. It is only cleared once
        // source.play() resolves (or rejects), ensuring the pipeline ignores
        // every event we generate in between.
        this.internalPlayback = true;

        if (this._prebufferOrigin !== null) {
            const target = this._prebufferOrigin;
            this._prebufferOrigin = null;

            const onSnapped = () => {
                // internalPlayback stays true — _finishEnterPlaying will
                // clear it only after play() settles.
                this._finishEnterPlaying();
            };
            this._source.addEventListener("seeked", onSnapped, { once: true });
            this._source.currentTime = target;
            return;
        }

        this._finishEnterPlaying();
    }

    _finishEnterPlaying() {
        this._clearOverlay();

        if (this._sourcePausedByUs) {
            this._sourcePausedByUs = false;
            this._source.play()
                .then(() => { this.internalPlayback = false; })
                .catch((err) => {
                    this.internalPlayback = false;
                    console.warn("[VideoCensor] source.play() failed:", err);
                });
        } else {
            // Source is already playing (e.g. user resumed before us) or we
            // didn't pause it — nothing to do, clear the flag immediately.
            this.internalPlayback = false;
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
        this._rafHandle = requestAnimationFrame(() => {
            this._rafHandle = null;
            if (this._state !== RendererState.PLAYING) return;

            const now = this._source.currentTime;

            // Find the best frame to display: among all frames whose captureTime
            // is <= now (i.e. due to be shown), pick the one with the highest
            // frameNum. frameNum is a strictly monotonic counter assigned at
            // capture time, so it is always the correct ordering key.
            // captureTime alone is not reliable because two frames captured in
            // the same rVFC tick can share the same value, and Map iteration
            // order (insertion order) does not equal capture order when the
            // backend returns frames out of order.
            let bestFrameNum    = null;
            let bestCaptureTime = -Infinity;

            for (const [frameNum, { captureTime }] of this._buffer) {
                if (captureTime <= now) {
                    if (bestFrameNum === null || frameNum > bestFrameNum) {
                        bestFrameNum    = frameNum;
                        bestCaptureTime = captureTime;
                    }
                }
            }

            if (bestFrameNum !== null) {
                // Discard all frames with a lower frameNum — they are older and
                // will never be shown.
                for (const [frameNum, { bitmap }] of this._buffer) {
                    if (frameNum < bestFrameNum) {
                        bitmap.close();
                        this._buffer.delete(frameNum);
                    }
                }

                // Draw the chosen frame.
                const { bitmap } = this._buffer.get(bestFrameNum);
                if (this._canvas.width !== bitmap.width || this._canvas.height !== bitmap.height) {
                    this._canvas.width  = bitmap.width;
                    this._canvas.height = bitmap.height;
                }
                this._ctx.drawImage(bitmap, 0, 0);
                bitmap.close();
                this._buffer.delete(bestFrameNum);
                this._nextFrame = bestFrameNum + 1;
            } else {
                // No frame is ready for the current playback position.
                // Check whether we have any future frames at all.
                if (this._buffer.size === 0) {
                    // Completely empty — starvation.
                    this._prebufferOrigin = now;
                    this._enterBuffering();
                    return;
                }
                // Frames exist but are all in the future — wait for source to
                // catch up (this can happen briefly after a snap-back seek).
            }

            this._tick();
        });
    }

    // ── Overlay helpers ───────────────────────────────────────────────────────

    _showBufferingOverlay() {
        const w = this._canvas.width  || 320;
        const h = this._canvas.height || 180;
        this._ctx.fillStyle = "rgba(0,0,0,0.6)";
        this._ctx.fillRect(0, 0, w, h);
        this._ctx.fillStyle = "#ffffff";
        this._ctx.font = "16px sans-serif";
        this._ctx.textAlign    = "center";
        this._ctx.textBaseline = "middle";
        this._ctx.fillText("Buffering…", w / 2, h / 2);
    }

    _clearOverlay() {
        // Draw the first available buffered frame immediately to avoid a black flash.
        // _tick() will take over from here and won't re-consume this frame because
        // we don't delete it from the buffer.
        let earliest = null;
        for (const [frameNum, entry] of this._buffer) {
            if (earliest === null || frameNum < earliest) earliest = frameNum;
        }
        if (earliest !== null) {
            const { bitmap } = this._buffer.get(earliest);
            if (this._canvas.width !== bitmap.width || this._canvas.height !== bitmap.height) {
                this._canvas.width  = bitmap.width;
                this._canvas.height = bitmap.height;
            }
            this._ctx.drawImage(bitmap, 0, 0);
        }
    }
}