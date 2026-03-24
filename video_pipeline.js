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
 * Event handler guards:
 *   _onSeeked  – ignored when capture.isStepping (internal seek-step) or
 *                renderer.internalPlayback (snap-back seek after buffering).
 *   _onPause   – ignored when renderer.internalPlayback (starvation pause).
 *   _onPlay    – ignored when renderer.internalPlayback (resume after buffering).
 *
 * Cross-origin iframe videos are detected and skipped with a console message.
 */

let _nextVideoId = 1;

class VideoPipeline {
    constructor(video) {
        this._id       = _nextVideoId++;
        this._original = video;
        this._active   = false;

        this._capture  = null;
        this._renderer = null;
        this._canvas   = null;
        this._wrapper  = null;

        this._boundOnSeeked = this._onSeeked.bind(this);
        this._boundOnPause  = this._onPause.bind(this);
        this._boundOnPlay   = this._onPlay.bind(this);
        this._boundOnEnded  = this._onEnded.bind(this);
    }

    start() {
        if (this._active) return;

        const source = this._tryGetSourceVideo(this._original);
        if (!source) return;

        this._active = true;
        this._buildDom(source);

        // VideoCapture: extracts frames from the hidden source.
        // onFrame now receives (frameNum, captureTime, bytes).
        this._capture = new VideoCapture(
            source,
            (frameNum, captureTime, bytes) => {
                this._renderer.recordFrameDispatch(frameNum, captureTime);
                videoWsSend(this._id, this._renderer.seekId, frameNum, bytes);
            },
            () => this._renderer.isBufferFull(),
        );

        // VideoRenderer: displays censored frames, manages audio.
        this._renderer = new VideoRenderer(source, this._canvas, () => {
            // Called when the renderer enters BUFFERING and needs frames.
            this._capture.start();
        });

        // Register with the shared WS.
        videoWsRegister(this._id, {
            onFrame: (seekId, frameNum, bytes) => {
                this._renderer.receiveFrame(seekId, frameNum, bytes, () => {
                    this._capture.frameCompleted();
                });
            },
            onOpen:  () => this._renderer.start(),
            onClose: () => this._renderer.onWsClose(),
        });

        source.addEventListener("seeked", this._boundOnSeeked);
        source.addEventListener("pause",  this._boundOnPause);
        source.addEventListener("play",   this._boundOnPlay);
        source.addEventListener("ended",  this._boundOnEnded);
    }

    destroy() {
        if (!this._active) return;
        this._active = false;

        videoWsUnregister(this._id);
        this._capture?.destroy();
        this._renderer?.destroy();

        const source = this._wrapper?.querySelector("video[data-censor-source]");
        if (source) {
            source.removeEventListener("seeked", this._boundOnSeeked);
            source.removeEventListener("pause",  this._boundOnPause);
            source.removeEventListener("play",   this._boundOnPlay);
            source.removeEventListener("ended",  this._boundOnEnded);
        }

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

        this._canvas = document.createElement("canvas");
        this._canvas.width  = w;
        this._canvas.height = h;
        this._canvas.style.cssText = v.style.cssText;
        this._canvas.className     = v.className;
        this._canvas.setAttribute("data-censor-canvas", "true");

        this._wrapper = document.createElement("div");
        this._wrapper.style.cssText = `display:inline-block;position:relative;width:${w}px;height:${h}px;`;
        this._wrapper.setAttribute("data-censor-wrapper", "true");

        // Insert wrapper first, before moving source inside it, to avoid
        // HierarchyRequestError.
        v.replaceWith(this._wrapper);

        source.style.position      = "absolute";
        source.style.visibility    = "hidden";
        source.style.pointerEvents = "none";
        source.setAttribute("data-censor-source", "true");
        source.controls = false;

        this._wrapper.appendChild(this._canvas);
        this._wrapper.appendChild(source);

        // Store a back-reference so applyCensorVideoSetting() in videos.js can
        // retrieve the original element to call stopVideoCensorPipeline() with.
        this._wrapper.__censorOriginal = v;
    }

    // ── Source video resolution ───────────────────────────────────────────────

    _tryGetSourceVideo(video) {
        try {
            const testCanvas = document.createElement("canvas");
            testCanvas.width = 1; testCanvas.height = 1;
            testCanvas.getContext("2d").drawImage(video, 0, 0);
            return video;
        } catch (err) {
            if (err.name === "SecurityError") {
                console.info(
                    "[VideoCensor] Skipping cross-origin protected video (canvas taint). " +
                    "To add support, implement a site-specific adapter in " +
                    "video_pipeline.js::_tryGetSourceVideo(). URL:", video.src || "(no src)"
                );
                return null;
            }
            return video;
        }
    }

    // ── Video event handlers ──────────────────────────────────────────────────

    _onSeeked() {
        // Ignore seeks from the capture's internal seek-step loop.
        if (this._capture?.isStepping) return;

        // Ignore seeks from the renderer snapping back to the prebuffer origin,
        // or from the audio-sync nudge.
        if (this._renderer?.internalPlayback) return;

        // A real user seek: tell the backend to cancel all in-flight work for
        // the current (now stale) seekId before we increment it.
        videoWsCancel(this._id, this._renderer.seekId);

        // Flush everything and rebuffer from the new position.
        this._capture.stop();
        this._capture.reset();
        this._renderer.onSeeked();
        // renderer.onSeeked() increments seekId, calls _enterBuffering() which
        // calls _onNeedFrames() which calls capture.start().
    }

    _onPause() {
        // Ignore pauses we triggered ourselves (starvation / prebuffering).
        if (this._renderer?.internalPlayback) return;

        // User-initiated pause: renderer acknowledges, capture keeps stepping
        // to fill the buffer while the source is paused.
        this._renderer.onPaused();
        // Capture is already running; if it was in playing mode, the 'pause'
        // event on the source will switch it to stepping mode automatically
        // (via the listener in VideoCapture).
    }

    _onPlay() {
        // Ignore resumes we triggered ourselves.
        if (this._renderer?.internalPlayback) return;

        this._renderer.onResumed();
        // Capture restarts via _onNeedFrames if the renderer enters BUFFERING,
        // or continues running if it was already in PLAYING state.
    }

    _onEnded() {
        this._capture.stop();
        this._renderer.onPaused();
    }
}

// ── Page-level registry ───────────────────────────────────────────────────────

const _activePipelines = new WeakMap();

function startVideoCensorPipeline(video) {
    if (_activePipelines.has(video)) return;
    const pipeline = new VideoPipeline(video);
    _activePipelines.set(video, pipeline);
    pipeline.start();
}

function stopVideoCensorPipeline(video) {
    const pipeline = _activePipelines.get(video);
    if (!pipeline) return;
    _activePipelines.delete(video);
    pipeline.destroy();
}