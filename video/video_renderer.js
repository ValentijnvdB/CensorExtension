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
 *   - Transitions back to BUFFERING when the buffer is empty (starvation).
 *
 * User pause during PLAYING:
 *   - Source is already paused by the user; canvas freezes.
 *   - Capture keeps running in seek-step mode to fill the buffer.
 *   - On resume: if buffer already full → PLAYING directly, else → BUFFERING.
 *
 * Audio sync:
 *   The canvas follows source.currentTime — no nudging of currentTime needed.
 *   _tick() converts source.currentTime to the performance.now() timeline via
 *   a sync point set at playback start, then compares against captureTime.
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

        // frameNum → { bitmap: ImageBitmap, captureTime: number, stepping: boolean }
        this._buffer = new Map();

        this._rafHandle = null;

        // Metadata recorded at dispatch, looked up when the processed frame returns.
        // frameNum → { captureTime: number (ms), stepping: boolean }
        //   captureTime: performance.now() in playing mode,
        //                source.currentTime*1000 in stepping mode.
        //   stepping: true if captured during seek-step (prebuffer/paused).
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

        // Clock sync point set when PLAYING starts. Used by _tick() to convert
        // source.currentTime into the performance.now() timeline so it can be
        // compared against captureTime (which is performance.now()-based in
        // playing mode and source.currentTime*1000-based in stepping mode).
        // { perfNow: number, videoTime: number } | null
        this._clockSync = null;
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
    recordFrameDispatch(frameNum, captureTime, stepping) {
        this._captureTimeMap.set(frameNum, { captureTime, stepping });
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

        const dispatch = this._captureTimeMap.get(frameNum);
        this._captureTimeMap.delete(frameNum);

        createImageBitmap(new Blob([bytes])).then(bitmap => {
            onConsumed();

            let ct       = dispatch?.captureTime ?? 0;
            const isStepping = dispatch?.stepping ?? false;

            // If this is a stepping-mode frame and we already have a clock sync,
            // rewrite its captureTime from video-time space (currentTime*1000)
            // into performance.now() space so _tick() can compare it against
            // playing-mode frames on a single timeline.
            // We use the explicit `stepping` flag — no threshold heuristics.
            if (isStepping && this._clockSync) {
                const videoT = ct / 1000;
                ct = this._clockSync.perfNow +
                     (videoT - this._clockSync.videoTime) * 1000;
            }

            this._buffer.set(frameNum, { bitmap, captureTime: ct, stepping: isStepping });
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
        this._captureTimeMap.clear();
        this._clockSync = null;
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
        this._clockSync = null;
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
                    // Establish the sync point only once the browser's media
                    // clock is actually running. Recording it before play()
                    // resolves causes drift because currentTime hasn't started
                    // moving yet.
                    this._establishClockSync();
                })
                .catch((err) => {
                    this.internalPlayback = false;
                    console.warn("[VideoCensor] source.play() failed:", err);
                });
        } else {
            // Source is already playing — clock is running now.
            this.internalPlayback = false;
            this._establishClockSync();
        }

        this._startPlaybackLoop();
    }

    /**
     * Record the (perfNow, videoTime) sync point and rewrite every
     * stepping-mode captureTime in the buffer from video-time space
     * (currentTime * 1000) into performance.now() space so all frames
     * share a single comparable timeline before _tick() runs.
     *
     * All captureTime values are stored as currentTime * 1000 at capture time.
     * A stepping frame at video position T seconds gets:
     *   newCaptureTime = perfNow + (T - videoTime) * 1000
     * which places it correctly relative to the current playback position on
     * the perf timeline. Future frames (T > videoTime) get a future perf time;
     * past frames (T < videoTime) get a past perf time.
     */
    _establishClockSync() {
        const perfNow   = performance.now();
        const videoTime = this._source.currentTime;
        this._clockSync = { perfNow, videoTime };
        console.log(`[VideoCensor] clockSync set  perfNow=${perfNow.toFixed(1)}ms  videoTime=${videoTime.toFixed(3)}s`);

        // Rewrite any stepping-mode frames already in the buffer from video-time
        // space (currentTime * 1000) into performance.now() space so all frames
        // share a single comparable timeline before _tick() runs.
        for (const [, entry] of this._buffer) {
            if (entry.stepping) {
                const videoT      = entry.captureTime / 1000;
                entry.captureTime = perfNow + (videoT - videoTime) * 1000;
                entry.stepping    = false;
            }
        }
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

            // Map source.currentTime into the performance.now() timeline using
            // the sync point established when playback started. All captureTime
            // values in the buffer have already been rewritten into this same
            // perf space by _establishClockSync, so the comparison is valid.
            const now = this._clockSync.perfNow +
                (this._source.currentTime - this._clockSync.videoTime) * 1000;

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
                    // Completely empty — starvation.
                    this._prebufferOrigin = this._source.currentTime;
                    console.warn(`[VideoCensor] buffer starvation at ${this._source.currentTime.toFixed(3)}s`);
                    this._enterBuffering();
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