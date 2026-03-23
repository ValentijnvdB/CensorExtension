/**
 * video_pipeline.js – Per-video orchestrator
 *
 * For each <video> element that should be censored, a VideoPipeline:
 *   1. Hides the original and inserts an output <canvas> in its place
 *   2. Creates a VideoCapture (frame extraction)
 *   3. Registers with the shared VideoWS (video_ws.js)
 *   4. Creates a VideoRenderer (frame display + audio)
 *   5. Wires up seek/pause/play event listeners
 *
 * Cross-origin iframe videos are detected and skipped with a console message.
 * The hook point for adding site-specific adapters later is _tryGetSourceVideo().
 */

// Monotonically increasing ID assigned to each pipeline instance
let _nextVideoId = 1;

class VideoPipeline {
    /**
     * @param {HTMLVideoElement} video – the original <video> element on the page
     */
    constructor(video) {
        this._id      = _nextVideoId++;
        this._original = video;
        this._active  = false;

        this._capture  = null;
        this._renderer = null;
        this._canvas   = null;
        this._wrapper  = null;

        this._boundOnSeeked  = this._onSeeked.bind(this);
        this._boundOnPause   = this._onPause.bind(this);
        this._boundOnPlay    = this._onPlay.bind(this);
        this._boundOnEnded   = this._onEnded.bind(this);
    }

    start() {
        if (this._active) return;

        const source = this._tryGetSourceVideo(this._original);
        if (!source) return; // unsupported player — already logged

        this._active = true;
        this._buildDom(source);

        // VideoCapture: extracts frames from the hidden source
        this._capture = new VideoCapture(source, (frameNum, bytes) => {
            this._renderer.recordFrameDispatch(frameNum);
            videoWsSend(this._id, this._renderer.seekId, frameNum, bytes);
        });

        // VideoRenderer: displays censored frames, manages audio
        this._renderer = new VideoRenderer(source, this._canvas, () => {
            // Called when renderer needs frames (entered BUFFERING)
            this._capture.start();
        });



        // Register with the shared WS
        videoWsRegister(this._id, {
            onFrame: (seekId, frameNum, bytes) => {
                this._renderer.receiveFrame(seekId, frameNum, bytes, () => {
                    this._capture.frameCompleted();
                });
            },
            onOpen:  () => this._renderer.start(),
            onClose: () => this._renderer.onWsClose(),
        });

        // Video event listeners
        source.addEventListener("seeked",  this._boundOnSeeked);
        source.addEventListener("pause",   this._boundOnPause);
        source.addEventListener("play",    this._boundOnPlay);
        source.addEventListener("ended",   this._boundOnEnded);
    }

    destroy() {
        if (!this._active) return;
        this._active = false;

        videoWsUnregister(this._id);
        this._capture?.destroy();
        this._renderer?.destroy();

        const source = this._wrapper?.querySelector("video[data-censor-source]");
        if (source) {
            source.removeEventListener("seeked",  this._boundOnSeeked);
            source.removeEventListener("pause",   this._boundOnPause);
            source.removeEventListener("play",    this._boundOnPlay);
            source.removeEventListener("ended",   this._boundOnEnded);
        }

        // Restore original video
        if (this._wrapper && this._original) {
            this._original.style.visibility = "";
            this._wrapper.replaceWith(this._original);
        }

        this._capture  = null;
        this._renderer = null;
        this._canvas   = null;
        this._wrapper  = null;
    }

    // ── DOM construction ──────────────────────────────────────────────────────

    _buildDom(source) {
        const v = this._original;
        const w = v.offsetWidth  || parseInt(v.getAttribute("width"))  || 640;
        const h = v.offsetHeight || parseInt(v.getAttribute("height")) || 360;

        // Output canvas — shown to the user
        this._canvas = document.createElement("canvas");
        this._canvas.width  = w;
        this._canvas.height = h;
        this._canvas.style.cssText = v.style.cssText;
        this._canvas.className     = v.className;
        this._canvas.setAttribute("data-censor-canvas", "true");

        // Wrapper div to hold canvas + hidden source together
        this._wrapper = document.createElement("div");
        this._wrapper.style.cssText = `display:inline-block;position:relative;width:${w}px;height:${h}px;`;
        this._wrapper.setAttribute("data-censor-wrapper", "true");

        // Insert the wrapper into the DOM first, in the original video's position.
        // We must do this BEFORE moving the source video into the wrapper —
        // appending source into wrapper while source is still in the DOM would
        // make wrapper a descendant of source's parent via source itself, which
        // causes a HierarchyRequestError when we then call replaceWith.
        v.replaceWith(this._wrapper);

        // Now it's safe to move the source video inside the wrapper.
        source.style.position      = "absolute";
        source.style.visibility    = "hidden";
        source.style.pointerEvents = "none";
        source.setAttribute("data-censor-source", "true");
        source.controls = false;

        this._wrapper.appendChild(this._canvas);
        this._wrapper.appendChild(source);
    }

    // ── Source video resolution ───────────────────────────────────────────────

    /**
     * Returns the source <video> element to capture frames from.
     *
     * Currently handles:
     *   - Native <video> elements (same-origin or blob/object URLs)
     *   - Same-origin iframes (covered automatically because content.js runs
     *     in all_frames:true — each iframe gets its own pipeline instance)
     *
     * Cross-origin iframes (YouTube, Vimeo, etc.) cannot be accessed from a
     * content script. We detect this case and skip with a console message.
     * TODO: add site-specific adapters here (e.g. YouTube iframe API) by
     *       checking window.location.hostname and returning a virtual source.
     *
     * @param {HTMLVideoElement} video
     * @returns {HTMLVideoElement|null}
     */
    _tryGetSourceVideo(video) {
        // Check if this video is inside a cross-origin iframe we can't control.
        // (In practice, if we're running as a content script we already have access,
        // but the video src itself might be a cross-origin stream we can't canvas-capture.)
        try {
            // Attempt a dummy canvas draw to verify capture is allowed.
            // This will throw a SecurityError for cross-origin protected streams.
            const testCanvas = document.createElement("canvas");
            testCanvas.width = 1; testCanvas.height = 1;
            testCanvas.getContext("2d").drawImage(video, 0, 0);
            // If we get here, capture is allowed
            return video;
        } catch (err) {
            if (err.name === "SecurityError") {
                console.info(
                    "[VideoCensor] Skipping cross-origin protected video (canvas taint). " +
                    "To add support for this player, implement a site-specific adapter in " +
                    "video_pipeline.js::_tryGetSourceVideo(). URL:", video.src || "(no src)"
                );
                return null;
            }
            // Other errors (e.g. video not ready) — allow, capture will retry
            return video;
        }
    }

    // ── Video event handlers ──────────────────────────────────────────────────

    _onSeeked() {
        // Ignore seeks triggered internally by VideoCapture stepping.
        if (this._capture?.isStepping) return;

        // Ignore seeks triggered internally by the renderer (audio sync nudge).
        if (this._renderer?.internalPlayback) return;

        // Ignore HLS/DASH internal segment seeks that fire while buffering.
        if (this._renderer?.state === RendererState.BUFFERING) return;

        this._capture.stop();
        this._capture.reset();
        this._renderer.onSeeked();
    }

    _onPause() {
        // Ignore pauses triggered internally by the renderer (starvation pause)
        // — capture must keep running so the buffer can refill.
        if (this._renderer?.internalPlayback) return;
        this._renderer.onPaused();
        this._capture.stop();
    }

    _onPlay() {
        if (this._renderer?.internalPlayback) return;
        this._renderer.onResumed();
        // capture.start() triggered by renderer via _onNeedFrames when needed
    }

    _onEnded() {
        this._capture.stop();
        this._renderer.onPaused();
    }
}

// ── Page-level registry ───────────────────────────────────────────────────────
// Maps each original <video> element → its VideoPipeline instance.
const _activePipelines = new WeakMap();

/**
 * Called from videos.js (the existing hook point) to censor a video.
 * Idempotent — safe to call multiple times on the same element.
 */
function startVideoCensorPipeline(video) {
    if (_activePipelines.has(video)) return;
    const pipeline = new VideoPipeline(video);
    _activePipelines.set(video, pipeline);
    pipeline.start();
}

/**
 * Called when removeVideos is toggled off or a video is removed from the DOM.
 */
function stopVideoCensorPipeline(video) {
    const pipeline = _activePipelines.get(video);
    if (!pipeline) return;
    _activePipelines.delete(video);
    pipeline.destroy();
}
