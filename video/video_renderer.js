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
 *   - rAF tick finds the frame with the largest frameNum whose captureTime <=
 *     source.currentTime and draws it; all frames with a strictly earlier
 *     captureTime are discarded. Frames with an equal or future captureTime
 *     are kept so late-arriving out-of-order frames are not prematurely dropped.
 *   - VideoCapture runs in rVFC mode.
 *   - On starvation (empty buffer) it calls onStarved: the pipeline flushes
 *     like a seek (new seekId, frames still in flight are dropped, they are
 *     all behind the playhead) and the renderer rebuffers from here.
 *
 * User pause during PLAYING:
 *   - Source is already paused by the user; canvas freezes.
 *   - Capture keeps running in seek-step mode to fill the buffer.
 *   - On resume: if buffer already full → PLAYING directly, else → BUFFERING.
 *
 * Audio sync:
 *   The canvas follows source.currentTime — no nudging of currentTime needed.
 *   Every frame's captureTime is its media time in ms, so _tick() compares it
 *   with source.currentTime * 1000 directly.
 */

const RendererState = Object.freeze({
    IDLE:      "IDLE",
    BUFFERING: "BUFFERING",
    PLAYING:   "PLAYING",
});

class VideoRenderer {
    /**
     * @param {function()} onNeedFrames – entered BUFFERING: start capture
     * @param {function()} onStarved    – the buffer ran dry while playing: flush (see header)
     */
    constructor(sourceVideo, outputCanvas, onNeedFrames, onStarved) {
        this._source       = sourceVideo;
        this._canvas       = outputCanvas;
        this._ctx          = outputCanvas.getContext("2d");
        this._onNeedFrames = onNeedFrames;
        this._onStarved    = onStarved;

        this._state  = RendererState.IDLE;
        this._seekId = 0;

        // frameNum → { bitmap: ImageBitmap, captureTime: number (media time, ms) }
        this._buffer = new Map();

        this._rafHandle = null;

        // Media time (ms) recorded at dispatch, looked up when the processed frame returns.
        // frameNum → captureTime
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

        // source.currentTime when the user paused during PLAYING. Capture keeps
        // stepping the source forward to fill the buffer, so on resume we seek
        // back here instead of continuing where capture got to.
        this._pausedAt = null;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    get seekId() { return this._seekId; }
    get state()  { return this._state; }

    /** True while the video plays or should play (also while we hold it paused to buffer). */
    get wantsPlayback() {
        return !this._source.paused || this._sourcePausedByUs;
    }

    /**
     * The playback position to show, in seconds. Not always source.currentTime:
     * while buffering or paused, capture steps the source ahead.
     */
    get displayTime() {
        if (this._state === RendererState.BUFFERING && this._prebufferOrigin !== null) return this._prebufferOrigin;
        if (this._pausedAt !== null && this._source.paused) return this._pausedAt;
        return this._source.currentTime;
    }

    /** A pause asked for by the control bar (VideoControls). */
    userPause() {
        // Also when we hold the source paused to buffer: don't resume it then.
        this._sourcePausedByUs = false;
        if (!this._source.paused) this._source.pause();   // → 'pause' → onPaused()
    }

    /** Returns true when the buffer has reached the prebuffer target. */
    isBufferFull() {
        return this._buffer.size >= this._prebufferFrames;
    }

    /**
     * Called by VideoPipeline when the WS connects. Keeps a BUFFERING or
     * PLAYING state: the video may have started (autoplay) before the WS was
     * open, and its frames were queued meanwhile. A video that was already
     * playing when the pipeline took it over never sends 'play', so buffering
     * starts here.
     */
    start() {
        if (this._state !== RendererState.IDLE) return;
        if (!this._source.paused && !this._source.ended) this._enterBuffering();
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

        const captureTime = this._captureTimeMap.get(frameNum) ?? 0;
        this._captureTimeMap.delete(frameNum);

        createImageBitmap(new Blob([bytes])).then(bitmap => {
            onConsumed();

            // A seek happened while decoding: the frame belongs to the old position.
            if (seekId !== this._seekId) {
                bitmap.close();
                return;
            }

            this._buffer.set(frameNum, { bitmap, captureTime });
            if (this._state === RendererState.BUFFERING) {
                this._checkPrebuffer();
            }
        }).catch(err => {
            onConsumed();
            console.warn("[VideoCensor] Failed to decode frame", frameNum, err);
        });
    }

    /**
     * Called by VideoPipeline on a user-initiated seek, and on starvation:
     * forget every frame (also those in flight) and rebuffer from here.
     */
    onSeeked() {
        this._seekId++;
        this._pausedAt = null;
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
        if (this._state === RendererState.PLAYING && this._pausedAt === null) {
            this._pausedAt = this._source.currentTime;
        }
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
            // Was playing, user paused then resumed. Capture stepped the source
            // ahead meanwhile: go back to where the user paused first.
            const pausedAt = this._pausedAt;
            this._pausedAt = null;
            if (pausedAt !== null && Math.abs(this._source.currentTime - pausedAt) > 0.05) {
                this.internalPlayback = true;
                this._source.addEventListener("seeked", () => {
                    this.internalPlayback = false;
                    if (this._state === RendererState.PLAYING) this.onResumed();
                }, { once: true });
                this._source.currentTime = pausedAt;
                return;
            }
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
        console.log(`[VideoCensor] → BUFFERING  videoTime=${this._source.currentTime.toFixed(3)}s`);

        this._prebufferFrames = Math.ceil(videoTargetFps * videoPrebufferSeconds);

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
        } else {
            // Source was already paused (e.g. starvation during a user pause, or
            // initial load). We never called pause() so the listener above will
            // never fire — make sure internalPlayback isn't left true from a
            // previous _enterPlaying() call.
            this.internalPlayback = false;
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
        console.log(`[VideoCensor] → PLAYING  videoTime=${this._source.currentTime.toFixed(3)}s`);

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
                .then(() => {
                    this.internalPlayback = false;
                })
                .catch((err) => {
                    this.internalPlayback = false;
                    console.warn("[VideoCensor] source.play() failed:", err);
                });
        } else {
            // Source is already playing.
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

            const now = this._source.currentTime * 1000;

            // Find the best frame to display: among all frames whose captureTime
            // is <= now (i.e. due to be shown), pick the one closest to 'now'
            // (highest captureTime). Use frameNum strictly to break ties.
            let bestFrameNum    = null;
            let bestCaptureTime = -Infinity;

            for (const [frameNum, { captureTime }] of this._buffer) {
                if (captureTime <= now) {
                    // Maximise captureTime first; only use frameNum to break exact ties.
                    if (bestFrameNum === null ||
                        captureTime > bestCaptureTime ||
                        (captureTime === bestCaptureTime && frameNum > bestFrameNum)) {
                        bestFrameNum    = frameNum;
                        bestCaptureTime = captureTime;
                    }
                }
            }

            if (bestFrameNum !== null) {
                // Discard frames that are strictly older than the chosen frame.
                // We key on captureTime rather than frameNum so that a frame
                // which arrived late from the backend (low frameNum but future
                // captureTime) is NOT discarded — it will still be displayable
                // once the audio clock advances past its captureTime.
                for (const [frameNum, { bitmap, captureTime }] of this._buffer) {
                    if (captureTime < bestCaptureTime ||
                        (captureTime === bestCaptureTime && frameNum < bestFrameNum)) {
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
            } else {
                // No frame is ready for the current playback position.
                // Check whether we have any future frames at all.
                if (this._buffer.size === 0) {
                    // Completely empty — starvation. The pipeline flushes and
                    // calls onSeeked(), which rebuffers from here.
                    console.warn(`[VideoCensor] buffer starvation at ${this._source.currentTime.toFixed(3)}s`);
                    this._onStarved();
                    return;
                }
                // Frames exist but are all in the future — wait for the source
                // to catch up (can happen briefly after a snap-back seek).
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
        // Draw the earliest buffered frame (by media time) immediately to avoid
        // a black flash. _tick() takes over from here; the frame stays in the
        // buffer.
        let earliest = null;
        for (const entry of this._buffer.values()) {
            if (earliest === null || entry.captureTime < earliest.captureTime) earliest = entry;
        }
        if (earliest !== null) {
            const { bitmap } = earliest;
            if (this._canvas.width !== bitmap.width || this._canvas.height !== bitmap.height) {
                this._canvas.width  = bitmap.width;
                this._canvas.height = bitmap.height;
            }
            this._ctx.drawImage(bitmap, 0, 0);
        }
    }
}