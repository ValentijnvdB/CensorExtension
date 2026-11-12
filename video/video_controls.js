/**
 * video_controls.js – Control bar for live-censored videos
 *
 * The live pipeline hides the original <video> and draws on a <canvas>, so the
 * browser's native controls are gone. For videos that used them (the
 * `controls` attribute), VideoPipeline adds this bar on top of the canvas.
 * Videos without it are left alone: their site's own player drives the
 * hidden video.
 *
 * The bar drives the hidden source video, so the pipeline's usual event
 * handling applies: play starts buffering, a seek flushes and rebuffers.
 *
 * Shows: play/pause, a seek bar, the time, and mute. Clicking the canvas
 * toggles play/pause, like the native controls. The bar is shown while the
 * mouse is over the video, and always while it is paused.
 *
 * Some sites keep the `controls` attribute but put their own player on top of
 * the video. Before the bar is shown, it checks what is at its place on the
 * page: when that is something of the site (not the bar, the canvas or the
 * wrapper), the site's player covers the video and the bar is turned off for
 * good. Elements with pointer-events: none don't count (they take no clicks).
 *
 * The bar is placed on the canvas's box as laid out, not the wrapper's: site
 * CSS (via the copied class and style) can size the canvas differently.
 */

class VideoControls {
    /**
     * @param {HTMLElement}       wrapper   – the pipeline's wrapper (position: relative)
     * @param {HTMLCanvasElement} canvas
     * @param {HTMLVideoElement}  source    – the hidden video
     * @param {VideoRenderer}     renderer
     */
    constructor(wrapper, canvas, source, renderer) {
        this._wrapper  = wrapper;
        this._canvas   = canvas;
        this._source   = source;
        this._renderer = renderer;
        this._dragging = false;   // the seek bar is being dragged
        this._hovered  = false;
        this._disabled = false;   // the site's own player covers the video
        this._lastCoverCheck = 0;

        this._bar  = this._el("div", `
            position:absolute; left:0; right:0; bottom:0; z-index:2;
            display:flex; align-items:center; gap:8px; box-sizing:border-box;
            height:36px; padding:0 10px; margin:0;
            background:linear-gradient(transparent, rgba(0,0,0,.75));
            color:#fff; font:13px/1 sans-serif; transition:opacity .2s;`);
        this._bar.setAttribute("data-censor-controls", "true");

        this._playBtn = this._button("Play");
        this._seek    = this._el("input", "flex:1; min-width:40px; margin:0; accent-color:#fff; cursor:pointer;");
        this._seek.type = "range";
        this._seek.min  = "0";
        this._seek.step = "any";
        this._seek.setAttribute("aria-label", "Seek");
        this._time    = this._el("span", "white-space:nowrap; font-variant-numeric:tabular-nums;");
        this._muteBtn = this._button("Mute");

        this._bar.append(this._playBtn, this._seek, this._time, this._muteBtn);
        wrapper.appendChild(this._bar);

        this._onPlayClick  = (e) => { e.stopPropagation(); this._togglePlay(); };
        this._onMuteClick  = (e) => { e.stopPropagation(); this._source.muted = !this._source.muted; this._update(); };
        this._onCanvasClick = () => this._togglePlay();
        this._onSeekInput  = () => { this._dragging = true; this._update(); };
        this._onSeekChange = () => {
            this._dragging = false;
            const t = parseFloat(this._seek.value);
            if (isFinite(t)) this._source.currentTime = t;   // a user seek: the pipeline rebuffers
        };
        this._onEnter = () => { this._hovered = true;  this._update(); };
        this._onLeave = () => { this._hovered = false; this._update(); };

        this._playBtn.addEventListener("click", this._onPlayClick);
        this._muteBtn.addEventListener("click", this._onMuteClick);
        this._bar.addEventListener("click", e => e.stopPropagation());
        canvas.addEventListener("click", this._onCanvasClick);
        canvas.style.cursor = "pointer";
        this._seek.addEventListener("input",  this._onSeekInput);
        this._seek.addEventListener("change", this._onSeekChange);
        wrapper.addEventListener("mouseenter", this._onEnter);
        wrapper.addEventListener("mouseleave", this._onLeave);

        // The time moves while playing; a timer is simpler than following every
        // event (the capture's own step seeks move currentTime too).
        this._timer = setInterval(() => this._update(), 250);
        this._update();
    }

    destroy() {
        clearInterval(this._timer);
        this._canvas.removeEventListener("click", this._onCanvasClick);
        this._canvas.style.cursor = "";
        this._wrapper.removeEventListener("mouseenter", this._onEnter);
        this._wrapper.removeEventListener("mouseleave", this._onLeave);
        this._bar.remove();
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    _togglePlay() {
        if (this._renderer.wantsPlayback) {
            this._renderer.userPause();
        } else {
            this._source.play().catch(err => console.warn("[VideoCensor] play() failed:", err));
        }
        this._update();
    }

    // ── Display ───────────────────────────────────────────────────────────────

    _update() {
        if (this._disabled) return;
        const playing  = this._renderer.wantsPlayback;
        const duration = this._source.duration;
        const time     = this._renderer.displayTime;

        this._playBtn.textContent = playing ? "❚❚" : "▶";
        this._playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
        this._muteBtn.textContent = this._source.muted ? "🔇" : "🔊";
        this._muteBtn.setAttribute("aria-label", this._source.muted ? "Unmute" : "Mute");

        if (isFinite(duration)) {
            this._seek.max      = String(duration);
            this._seek.disabled = false;
            if (!this._dragging) this._seek.value = String(time);
        } else {
            this._seek.disabled = true;
        }
        const shown = this._dragging ? parseFloat(this._seek.value) : time;
        this._time.textContent = isFinite(duration)
            ? `${formatVideoTime(shown)} / ${formatVideoTime(duration)}`
            : formatVideoTime(shown);

        const visible = this._hovered || !playing || this._dragging;
        if (visible) {
            this._place();
            if (this._isCovered()) return this._disable();
        }
        this._bar.style.opacity = visible ? "1" : "0";
    }

    /** Put the bar along the bottom of the canvas as it is laid out. */
    _place() {
        const wr = this._wrapper.getBoundingClientRect();
        const cr = this._canvas.getBoundingClientRect();
        if (!cr.width || !cr.height) return;
        Object.assign(this._bar.style, {
            left:   `${cr.left - wr.left}px`,
            width:  `${cr.width}px`,
            right:  "auto",
            top:    `${cr.bottom - wr.top - this._bar.offsetHeight}px`,
            bottom: "auto",
        });
    }

    /**
     * Whether a site element lies on top of the bar (its own player). Checked at
     * most once a second, and only while the bar's middle is in the viewport.
     */
    _isCovered() {
        const now = performance.now();
        if (now - this._lastCoverCheck < 1000) return false;
        this._lastCoverCheck = now;

        const r = this._bar.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (!r.width || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const top = document.elementFromPoint(x, y);
        return top !== null && !this._wrapper.contains(top);
    }

    /** The site has its own player: no bar, no click-to-play. */
    _disable() {
        this._disabled = true;
        clearInterval(this._timer);
        this._bar.style.display = "none";
        this._canvas.removeEventListener("click", this._onCanvasClick);
        this._canvas.style.cursor = "";
        console.info("[VideoCensor] The site's own player covers the video: no control bar");
    }

    // ── Elements ──────────────────────────────────────────────────────────────

    _el(tag, css) {
        const el = document.createElement(tag);
        el.style.cssText = css;
        return el;
    }

    _button(label) {
        const b = this._el("button", `
            all:unset; cursor:pointer; color:#fff; font:16px/1 sans-serif;
            width:24px; height:24px; display:flex; align-items:center; justify-content:center;`);
        b.type = "button";
        b.setAttribute("aria-label", label);
        return b;
    }
}

/** 75.3 → "1:15", 3725 → "1:02:05". */
function formatVideoTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60), m = Math.floor(seconds / 60) % 60, h = Math.floor(seconds / 3600);
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
