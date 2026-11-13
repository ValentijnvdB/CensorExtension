/**
 * video_pipeline.js – Per-video orchestrator
 *
 * For each <video> element that should be censored, a VideoPipeline:
 *   1. Hides the original and inserts an output <canvas> in its place
 *   2. Creates an AudioDelay, a VideoRenderer and a VideoCapture
 *   3. Registers with the shared VideoWS (video_ws.js)
 *   4. Adds a control bar (VideoControls) if the video used native controls
 *   5. Follows the source's events
 *
 * Delay line (see video_renderer.js): the hidden source plays normally, its
 * frames go to the backend as they are presented, and picture and audio come
 * out videoDelaySeconds later. The pipeline never pauses or seeks the source
 * itself, so every event on it comes from the user or the site's player:
 *
 *   play     – create the audio graph (needs the user's activation), resume audio
 *   playing  – resume audio (after a stall)
 *   pause    – freeze audio (not at the end: the delay still has to play out)
 *   waiting  – freeze audio while the source stalls (its time stands still too)
 *   seeking  – a loop back to the start (the loop attribute, or the site's
 *              player starting over right after 'ended'): the renderer's
 *              timeline goes on (VideoRenderer.onLoop), nothing is dropped.
 *              Any other seek flushes: cancel the frames in flight, forget all
 *              frames, empty the audio delay, start a new segment there
 *   seeked   – paused: censor the frame at the new position once (a still)
 *   loadeddata, emptied – a new source: flush, and show a still when paused
 *   ended    – show the last delay seconds (VideoRenderer.onEnded)
 *   timeupdate – remember the position, to tell a loop from a seek
 *
 * Frames are tagged with the seekId they were captured in; frames of an
 * older seek are dropped and don't count towards the in-flight limit.
 *
 * Cross-origin iframe videos are detected and skipped with a console message.
 */

let _nextVideoId = 1;

// A seek counts as a loop when it lands this close to the start (s) …
const LOOP_RESTART_MAX  = 0.5;
// … and, with the loop attribute, the source was this close to its end (s),
const LOOP_END_MARGIN   = 1;
// … or it comes this soon after 'ended' (the site's player starting over, ms).
const LOOP_AFTER_END_MS = 2000;

class VideoPipeline {
    constructor(video) {
        this._id       = _nextVideoId++;
        this._original = video;
        this._active   = false;

        this._capture  = null;
        this._renderer = null;
        this._audio    = null;
        this._canvas   = null;
        this._wrapper  = null;
        this._controls = null;
        this._source   = null;
        this._saved    = null;   // the original's state that _buildDom changes
        this._lastTime = 0;      // the source's position at its last timeupdate (s)
        this._endedAt  = null;   // performance.now() of the last 'ended'

        this._listeners = {
            play:       () => this._onPlay(),
            playing:    () => this._audio.resume(),
            pause:      () => this._onPause(),
            waiting:    () => this._audio.suspend(),
            seeking:    () => this._onSeeking(),
            seeked:     () => this._showStillIfPaused(),
            loadeddata: () => this._showStillIfPaused(),
            emptied:    () => this._flush(),
            ended:      () => this._onEnded(),
            timeupdate: () => { if (!this._source.seeking) this._lastTime = this._source.currentTime; },
        };
    }

    start() {
        if (this._active) return;

        const source = this._tryGetSourceVideo(this._original);
        if (!source) return;

        this._active = true;
        this._source = source;
        const hadControls = source.hasAttribute("controls");
        this._buildDom(source);

        const delay = Math.max(0.5, Number(videoDelaySeconds) || SETTING_DEFAULTS.videoDelaySeconds);
        this._audio    = new AudioDelay(source, delay);
        this._renderer = new VideoRenderer(source, this._canvas, this._audio, delay);
        this._capture  = new VideoCapture(
            source,
            (frameNum, captureTime, bytes, seekId) => {
                this._renderer.recordFrameDispatch(frameNum, captureTime);
                videoWsSend(this._id, seekId, frameNum, bytes);
            },
            () => this._renderer.seekId,
            t => this._renderer.toTimeline(t),
        );

        videoWsRegister(this._id, {
            onFrame: (seekId, frameNum, bytes) => {
                // A frame of an older seek: capture.reset() already zeroed the
                // in-flight count, so it must not be decremented again.
                if (seekId === this._renderer.seekId) this._capture.frameCompleted();
                this._renderer.receiveFrame(seekId, frameNum, bytes);
            },
            onFrameFailed: (seekId, frameNum) => {
                if (seekId === this._renderer.seekId) this._capture.frameCompleted();
                this._renderer.forgetFrame(seekId, frameNum);
            },
            // Frames in flight are lost with the connection.
            onClose: () => this._capture.reset(),
        });

        // The native controls are hidden with the video: offer our own instead.
        // Videos without them are driven by their site's player.
        if (hadControls) {
            this._controls = new VideoControls(this._wrapper, this._canvas, source, this._renderer);
        }

        for (const [type, fn] of Object.entries(this._listeners)) source.addEventListener(type, fn);

        // Taking over a video that already plays: its audio gets delayed from now.
        if (!source.paused) this._audio.ensure();
        this._capture.start();
        this._showStillIfPaused();
    }

    destroy() {
        if (!this._active) return;
        this._active = false;

        videoWsUnregister(this._id);
        this._controls?.destroy();
        this._capture?.destroy();
        this._renderer?.destroy();
        this._audio?.destroy();

        const source = this._source;
        if (source) {
            for (const [type, fn] of Object.entries(this._listeners)) source.removeEventListener(type, fn);
        }

        if (this._wrapper && this._original) {
            const v = this._original;
            if (this._saved) {
                v.style.position      = this._saved.position;
                v.style.visibility    = this._saved.visibility;
                v.style.pointerEvents = this._saved.pointerEvents;
                v.controls            = this._saved.controls;
            }
            v.removeAttribute("data-censor-source");
            this._wrapper.replaceWith(v);
        }

        this._controls = null;
        this._saved    = null;
        this._capture  = null;
        this._renderer = null;
        this._audio    = null;
        this._source   = null;
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
        // Fill the wrapper (the original's size) whatever the frame size is.
        Object.assign(this._canvas.style, {
            width: "100%", height: "100%", display: "block", objectFit: "contain", background: "#000",
        });
        this._canvas.setAttribute("data-censor-canvas", "true");

        this._wrapper = document.createElement("div");
        this._wrapper.style.cssText = `display:inline-block;position:relative;width:${w}px;height:${h}px;`;
        this._wrapper.setAttribute("data-censor-wrapper", "true");

        // Insert wrapper first, before moving source inside it, to avoid
        // HierarchyRequestError.
        v.replaceWith(this._wrapper);

        this._saved = {
            position:      source.style.position,
            visibility:    source.style.visibility,
            pointerEvents: source.style.pointerEvents,
            controls:      source.controls,
        };
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

    _onPlay() {
        this._audio.ensure();
        this._audio.resume();
    }

    _onPause() {
        // At the end the source pauses too, but the delay still holds the last
        // seconds of audio, which the renderer's tail shows the picture for.
        if (!this._source.ended) this._audio.suspend();
    }

    _onEnded() {
        this._endedAt = performance.now();
        this._renderer.onEnded();
    }

    /** A loop back to the start goes on without a break; any other seek flushes. */
    _onSeeking() {
        const looped = this._isLoop() && this._renderer.onLoop();
        this._endedAt = null;
        if (!looped) this._flush();
    }

    /** Whether the seek going on now is the source starting over. */
    _isLoop() {
        const v = this._source;
        const duration = v.duration;
        if (!isFinite(duration) || v.currentTime > LOOP_RESTART_MAX) return false;
        // The browser loops it (the loop attribute) …
        if (v.loop && this._lastTime >= duration - LOOP_END_MARGIN) return true;
        // … or the site's player starts it over after the end.
        return this._endedAt !== null && performance.now() - this._endedAt < LOOP_AFTER_END_MS;
    }

    /**
     * Drop every frame of the current seekId (queued, at the backend, and
     * buffered) and the delayed audio, and start again from the source's
     * position.
     */
    _flush() {
        // Tell the backend to cancel all in-flight work for the current (now
        // stale) seekId before the renderer increments it.
        videoWsCancel(this._id, this._renderer.seekId);
        this._capture.reset();
        this._renderer.flush();
        this._audio.flush();
    }

    /** A paused video shows the censored frame at its position (start, seek while paused). */
    _showStillIfPaused() {
        const v = this._source;
        if (v.paused && !v.seeking && v.readyState >= 2) this._capture.captureStill();
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

/** True when a live pipeline runs for `video` (it can't for cross-origin videos). */
function isVideoCensorPipelineActive(video) {
    return Boolean(_activePipelines.get(video)?._active);
}
