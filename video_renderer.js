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

        // frameNum → { bitmap: ImageBitmap, captureTime: number }
        this._buffer    = new Map();
        this._nextFrame = 0; // lowest frameNum not yet displayed

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
                const oldCt  = ct;
                ct = this._clockSync.perfNow +
                     (videoT - this._clockSync.videoTime) * 1000;
                console.log(`[VC:recv]  late stepping frame ${frameNum}: ct ${oldCt.toFixed(1)}ms (videoT=${videoT.toFixed(3)}s) → ${ct.toFixed(1)}ms`);
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
        this._nextFrame = 0;
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
        console.log(`[VC:state] → BUFFERING  videoTime=${this._source.currentTime.toFixed(3)}s  bufSize=${this._buffer.size}  prebufferOrigin=${this._prebufferOrigin?.toFixed(3) ?? 'null'}s`);

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
        console.log(`[VC:state] → PLAYING  videoTime=${this._source.currentTime.toFixed(3)}s  bufSize=${this._buffer.size}  prebufferOrigin=${this._prebufferOrigin?.toFixed(3) ?? 'null'}s`);

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
     * Stepping-mode frames have captureTime = source.currentTime * 1000,
     * which is a small number (seconds-into-video * 1000).
     * Playing-mode frames have captureTime = performance.now(), a large
     * number (ms since page load).
     * Without normalisation these two sets are never directly comparable.
     */
    _establishClockSync() {
        const perfNow   = performance.now();
        const videoTime = this._source.currentTime;
        this._clockSync = { perfNow, videoTime };
        console.log(`[VC:sync]  clockSync set  perfNow=${perfNow.toFixed(1)}ms  videoTime=${videoTime.toFixed(3)}s`);

        // Convert stepping-mode captureTime values to performance.now() space.
        // A stepping frame captured at video position T seconds was stored as
        // T * 1000.  Its equivalent perf time is:
        //   perfNow + (T - videoTime) * 1000
        // which places it relative to the current playback position on the
        // perf timeline.  Future frames (T > videoTime) get a future perf time;
        // past frames (T < videoTime) get a past perf time — both correct.
        //
        // We use the explicit entry.stepping flag written at capture time to
        // identify frames in video-time space. This is reliable regardless of
        // when in the page's lifetime the session starts.
        // Rewrite stepping-mode frames from video-time space into perf space.
        // We use the explicit entry.stepping flag set at capture time — no
        // threshold heuristics that break when page load time and video time
        // happen to overlap (e.g. early in a session).
        let rewriteCount = 0;
        for (const [frameNum, entry] of this._buffer) {
            if (entry.stepping) {
                const videoT  = entry.captureTime / 1000;
                const oldCt   = entry.captureTime;
                entry.captureTime = perfNow + (videoT - videoTime) * 1000;
                entry.stepping    = false; // now in perf space, treat as playing
                rewriteCount++;
                console.log(`[VC:sync]  rewrite frame ${frameNum}: ct ${oldCt.toFixed(1)}ms (videoT=${videoT.toFixed(3)}s) → ${entry.captureTime.toFixed(1)}ms`);
            }
        }
        if (rewriteCount === 0) {
            console.log(`[VC:sync]  no stepping frames to rewrite (bufSize=${this._buffer.size})`);
            for (const [frameNum, entry] of this._buffer) {
                console.log(`[VC:sync]    frame ${frameNum}: ct=${entry.captureTime.toFixed(1)}ms  stepping=${entry.stepping}`);
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

            // Convert source.currentTime to the performance.now() timeline using
            // the sync point established when playback started. This lets us
            // compare directly against captureTime, which is performance.now()-
            // based in playing mode and source.currentTime*1000-based in stepping
            // mode. If no sync point exists yet, fall back to a raw ms conversion.
            const videoTimeMs = this._source.currentTime * 1000;
            const now = this._clockSync
                ? this._clockSync.perfNow +
                  (this._source.currentTime - this._clockSync.videoTime) * 1000
                : videoTimeMs;

            // Find the best frame to display: among all frames whose captureTime
            // is <= now (i.e. due to be shown), pick the one closest to 'now'
            // (highest captureTime). Use frameNum strictly to break ties.
            let bestFrameNum    = null;
            let bestCaptureTime = -Infinity;

            for (const [frameNum, { captureTime }] of this._buffer) {
                if (captureTime <= now) {
                    // FIX: Maximize captureTime first. Only fallback to frameNum for exact ties.
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
                        console.log(`[VC:tick]  DISCARD frame ${frameNum}: ct=${captureTime.toFixed(1)} < bestCt=${bestCaptureTime.toFixed(1)}  now=${now.toFixed(1)}`);
                        bitmap.close();
                        this._buffer.delete(frameNum);
                    }
                }

                console.log(`[VC:tick]  DRAW frame ${bestFrameNum}: ct=${bestCaptureTime.toFixed(1)}  now=${now.toFixed(1)}  clockSync=${this._clockSync ? 'yes' : 'NO'}  videoTime=${this._source.currentTime.toFixed(3)}s  bufRemaining=${this._buffer.size - 1}`);

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
                    // _prebufferOrigin must be in seconds (source.currentTime
                    // space) — not in ms / performance.now() space.
                    this._prebufferOrigin = this._source.currentTime;
                    console.log(`[VC:tick]  STARVATION  videoTime=${this._source.currentTime.toFixed(3)}s  now=${now.toFixed(1)}  clockSync=${this._clockSync ? 'yes' : 'NO'}`);
                    this._enterBuffering();
                    return;
                }
                // Frames exist but are all in the future — wait for source to
                // catch up (this can happen briefly after a snap-back seek).
                const futureCts = [...this._buffer.values()].map(e => e.captureTime.toFixed(1)).join(', ');
                console.log(`[VC:tick]  WAIT (all future)  now=${now.toFixed(1)}  bufSize=${this._buffer.size}  captureTimes=[${futureCts}]  clockSync=${this._clockSync ? 'yes' : 'NO'}`);
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