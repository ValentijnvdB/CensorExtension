/**
 * video_audio.js – Delays a video's audio to match the censored picture
 *
 * The live pipeline shows each frame `videoDelaySeconds` after the source
 * video played it, so the audio has to come that much later too. Two ways:
 *
 * 1. Web Audio (same-origin, CORS and MediaSource videos):
 *
 *      MediaElementSource(video) → DelayNode(delay) → destination
 *
 *    - flush() swaps in a new, silent DelayNode: after a seek the old one still
 *      holds audio from before it.
 *    - suspend()/resume() freeze the whole graph, including the audio inside
 *      the delay, while the video is paused or stalls, so audio and picture
 *      stay together.
 *
 * 2. A second <audio> element (cross-origin videos without CORS). Web Audio
 *    only gets silence from those (the extension may read their pixels, the
 *    page may not hear them through Web Audio). A hidden <audio> plays the same
 *    URL at the time the renderer shows, kept in step by sync() (small
 *    playbackRate changes, a seek when far off). The video itself is still
 *    connected to Web Audio, which silences it without touching its muted or
 *    volume (the site's player keeps showing its own state); the <audio>
 *    follows the video's muted, volume and playbackRate.
 *
 * A media element can be connected to Web Audio only once in its life, and from
 * then on its sound only comes out through the graph. The graph is therefore
 * kept per element (WeakMap) and reused when a pipeline starts again for it;
 * destroy() connects the element straight to the output (a cross-origin video
 * stays silent then, until the page is reloaded).
 *
 * The AudioContext is created on the first play, while the page still has the
 * user's activation, so Firefox lets it run. If it (or the <audio>) is not
 * allowed to play yet, it is retried on the next click or key press. When Web
 * Audio can't be used at all, the audio plays undelayed (console warning).
 */

const _audioGraphs = new WeakMap();   // video → { ctx, input }

const MAX_AUDIO_DELAY = 179;          // DelayNode's limit is < 180 s

const AUDIO_SEEK_DRIFT  = 0.25;       // s: the <audio> is this far off: seek it
const AUDIO_NUDGE_DRIFT = 0.02;       // s: this far off: play it a bit faster/slower
const AUDIO_NUDGE_GAIN  = 0.5;        // playbackRate change per second of drift (0.1 s off: 5 %)
const AUDIO_NUDGE_MAX   = 0.1;        // at most 10 % faster/slower
const AUDIO_LEAD_MAX    = 0.5;        // s: most the <audio> is started ahead (its start-up time)

/**
 * True when Web Audio would only get silence from the video: its media is from
 * another origin and was not loaded with CORS. blob: URLs (MediaSource) belong
 * to the page.
 */
function isCrossOriginMedia(video) {
    const src = video.currentSrc || video.src;
    if (!src || video.crossOrigin !== null) return false;
    try {
        const url = new URL(src, location.href);
        if (url.protocol === "blob:" || url.protocol === "data:") return false;
        return url.origin !== location.origin;
    } catch {
        return false;
    }
}

class AudioDelay {
    /**
     * @param {HTMLVideoElement} video
     * @param {number} delaySeconds
     */
    constructor(video, delaySeconds) {
        this._video   = video;
        this._delay   = Math.min(Math.max(0, delaySeconds), MAX_AUDIO_DELAY);
        this._mode    = null;   // null (not started) | "webaudio" | "element"
        this._graph   = null;   // { ctx, input }
        this._node    = null;   // the current DelayNode (webaudio mode)
        this._shadow  = null;   // the <audio> (element mode)
        this._failed  = false;
        this._suspended = false;
        this._blocked   = false;   // the autoplay policy keeps audio from playing
        this._playing   = false;   // element mode: play() asked and not failed
        this._lead      = 0;       // element mode: s the <audio> lags after play(), learned
        this._startedAt = null;    // performance.now() of the last play(), until the lag is measured
        this._onGesture = () => this._onUserGesture();
    }

    /** True once the audio is delayed. */
    get active() { return this._mode !== null; }

    /** Seconds between the graph and the speakers, to add to the delay of the picture. */
    get outputLatency() {
        const ctx = this._graph?.ctx;
        if (this._mode !== "webaudio" || !ctx) return 0;
        return (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    }

    /** Start delaying if not done yet. Call from a 'play' event (user activation). */
    ensure() {
        if (this._mode || this._failed) return;
        try {
            let graph = _audioGraphs.get(this._video);
            if (!graph) {
                const ctx   = new AudioContext();
                const input = ctx.createMediaElementSource(this._video);
                graph = { ctx, input };
                _audioGraphs.set(this._video, graph);
            } else {
                graph.input.disconnect();
            }
            this._graph = graph;
        } catch (err) {
            this._failed = true;
            console.warn("[VideoCensor] Can't delay the audio, it plays ahead of the picture:", err);
            return;
        }

        if (isCrossOriginMedia(this._video)) {
            // The graph only silences the video; the <audio> plays its sound.
            this._mode   = "element";
            this._shadow = document.createElement("audio");
            this._shadow.preload = "auto";
            this._shadow.src     = this._video.currentSrc;
            console.info("[VideoCensor] Cross-origin video: its audio plays from a second <audio> element");
        } else {
            this._mode = "webaudio";
            this._connectNewDelay();
        }
        this._tryResume();
    }

    /** Drop the delayed audio (after a seek). */
    flush() {
        if (this._mode === "webaudio") this._connectNewDelay();
        if (this._mode === "element") this._pauseShadow();
    }

    /** Freeze audio (paused or stalled source). */
    suspend() {
        this._suspended = true;
        if (this._mode === "webaudio") this._graph.ctx.suspend().catch(() => {});
        if (this._mode === "element") this._pauseShadow();
    }

    /** Unfreeze audio. */
    resume() {
        this._suspended = false;
        this._tryResume();
    }

    /**
     * Element mode: keep the <audio> at media time `t` (the time the renderer
     * shows), playing while `advancing`. Called on every renderer tick.
     */
    sync(t, advancing) {
        const a = this._shadow;
        if (this._mode !== "element" || !a) return;
        const v = this._video;

        if (v.currentSrc && a.src !== v.currentSrc) a.src = v.currentSrc;
        if (a.muted  !== v.muted)  a.muted  = v.muted;
        if (a.volume !== v.volume) a.volume = v.volume;
        const rate = v.playbackRate || 1;

        if (a.readyState < 1 || a.seeking) return;
        const drift = a.currentTime - t;
        // Where to (re)start: ahead by the lag a start had last time, so it starts in step.
        const start = t + this._lead * rate;

        if (!advancing || this._suspended) {
            this._pauseShadow();
            // Wait there already, so the start needs no seek.
            if (Math.abs(a.currentTime - start) > AUDIO_NUDGE_DRIFT) a.currentTime = start;
            return;
        }
        if (!this._playing) {
            if (Math.abs(a.currentTime - start) > AUDIO_NUDGE_DRIFT) a.currentTime = start;
            a.playbackRate = rate;
            this._startedAt = performance.now();
            this._playShadow();
            return;
        }
        // Shortly after a start, learn how far behind it still started.
        if (this._startedAt !== null && performance.now() - this._startedAt > 300) {
            this._startedAt = null;
            this._lead = Math.min(AUDIO_LEAD_MAX, Math.max(0, this._lead - drift));
        }
        if (Math.abs(drift) > AUDIO_SEEK_DRIFT) {
            a.currentTime = t;
        } else if (Math.abs(drift) > AUDIO_NUDGE_DRIFT) {
            const nudge = Math.min(AUDIO_NUDGE_MAX, Math.abs(drift) * AUDIO_NUDGE_GAIN);
            a.playbackRate = rate * (drift > 0 ? 1 - nudge : 1 + nudge);
        } else if (a.playbackRate !== rate) {
            a.playbackRate = rate;
        }
    }

    /** Let the element's audio play undelayed again. The graph stays for a next pipeline. */
    destroy() {
        this._removeGestureListeners();
        if (this._shadow) {
            this._shadow.pause();
            this._shadow.removeAttribute("src");
            this._shadow.load();
            this._shadow = null;
        }
        if (this._graph) {
            const { ctx, input } = this._graph;
            input.disconnect();
            this._node?.disconnect();
            input.connect(ctx.destination);
            ctx.resume().catch(() => {});
        }
        this._node  = null;
        this._graph = null;
        this._mode  = null;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _connectNewDelay() {
        const { ctx, input } = this._graph;
        const node = ctx.createDelay(MAX_AUDIO_DELAY);
        node.delayTime.value = this._delay;
        input.disconnect();
        this._node?.disconnect();
        input.connect(node);
        node.connect(ctx.destination);
        this._node = node;
    }

    _playShadow() {
        if (this._blocked) return;   // waits for a gesture
        this._playing = true;
        this._shadow.play().catch(err => {
            this._playing = false;
            if (err?.name === "NotAllowedError") this._waitForGesture();
            else console.warn("[VideoCensor] The delayed audio can't play:", err);
        });
    }

    _pauseShadow() {
        this._playing = false;
        if (this._shadow && !this._shadow.paused) this._shadow.pause();
    }

    _tryResume() {
        if (this._mode !== "webaudio" || this._suspended) return;
        const ctx = this._graph.ctx;
        ctx.resume().then(() => {
            if (ctx.state !== "running") return;
            this._removeGestureListeners();
            // It wasn't allowed to run until now: what it holds is out of step.
            if (this._blocked) {
                this._blocked = false;
                if (!this._suspended) this.flush();
            }
        }).catch(() => {});
        if (ctx.state !== "running" && ctx.currentTime === 0) this._waitForGesture();
    }

    /** The autoplay policy blocks audio: retry on the next click or key press. */
    _waitForGesture() {
        this._blocked = true;
        document.addEventListener("pointerdown", this._onGesture, true);
        document.addEventListener("keydown",     this._onGesture, true);
    }

    _onUserGesture() {
        if (this._mode === "element") {
            this._blocked = false;
            this._removeGestureListeners();   // sync() plays it on the next tick
        } else {
            this._tryResume();
        }
    }

    _removeGestureListeners() {
        document.removeEventListener("pointerdown", this._onGesture, true);
        document.removeEventListener("keydown",     this._onGesture, true);
    }
}
