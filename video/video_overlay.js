/**
 * video_overlay.js – Shows the censored picture on top of the source <video>
 *
 * The source video stays where the site put it: it is not moved or wrapped,
 * only made invisible (opacity 0, so it still takes the clicks meant for it).
 * A <div> with the output <canvas> is inserted right after it, positioned
 * absolutely over its box:
 *
 *   - As a sibling it shares the video's containing block, so the video's
 *     offsetLeft/offsetTop place it; the on-screen difference between the two
 *     boxes corrects the rest (tables, transforms). A video with
 *     position: fixed gets a fixed overlay.
 *   - Positioned elements take no space, so the site's layout (flex, grid, …)
 *     is unchanged.
 *   - It comes right after the video, so it is painted above the video and
 *     below the site's own controls that come later. The video's z-index,
 *     transform, border-radius and object-fit are copied.
 *   - Scrollers (overflow other than visible) between the video and the
 *     overlay's containing block clip the video but not the absolutely
 *     positioned overlay: the overlay gets a clip-path to their visible area.
 *
 * Every animation frame the overlay follows the video: its size and place,
 * and its place in the DOM. Sites that move their <video> elsewhere (e.g. from
 * a hidden preloading container into the player) take the overlay along; a
 * video taken out of the page takes it out too, until it comes back.
 *
 * The overlay takes no pointer events (clicks go to the site's player), except
 * when `interactive`: then it is our own player (VideoControls) for a video
 * that had native controls.
 *
 * A site that puts the bare <video> in fullscreen can't have anything drawn
 * over it: the fullscreen video is then invisible (black), never uncensored.
 */

const OVERLAY_STYLE_EVERY = 30;   // animation frames between re-reading the video's computed style

/** Every declaration of a style text as !important, so site CSS (even its !important rules) can't change it. */
function important(cssText) {
    return cssText.split(";").map(d => d.trim()).filter(Boolean).map(d => `${d} !important`).join("; ") + ";";
}

/** Set a style property as !important. */
function setImportant(el, property, value) {
    el.style.setProperty(property, value, "important");
}

class VideoOverlay {
    /**
     * @param {HTMLVideoElement} video
     * @param {{interactive: boolean}} options – interactive: take pointer events (our own controls)
     */
    constructor(video, { interactive }) {
        this._video = video;
        this._ticks = 0;
        this._moves = 0;
        this._left  = 0;
        this._top   = 0;
        this._width = -1;
        this._height = -1;
        this._fixed = false;
        this._clippers = [];   // ancestors that clip the video but not the overlay
        this._clip = "";
        this._rafHandle = null;

        // all: initial keeps the site's CSS for divs and canvases off them.
        this.element = document.createElement("div");
        this.element.style.cssText = important(`all: initial; position: absolute; display: block;
            box-sizing: border-box; margin: 0; padding: 0; border: 0; overflow: hidden; left: 0; top: 0;
            pointer-events: ${interactive ? "auto" : "none"};`);
        this.element.setAttribute("data-censor-overlay", "true");

        const w = video.offsetWidth  || parseInt(video.getAttribute("width"))  || 640;
        const h = video.offsetHeight || parseInt(video.getAttribute("height")) || 360;
        this.canvas = document.createElement("canvas");
        this.canvas.width  = w;
        this.canvas.height = h;
        this.canvas.style.cssText = important(`all: initial; display: block; width: 100%; height: 100%;
            background: #000; object-fit: contain;`);
        this.canvas.setAttribute("data-censor-canvas", "true");
        this.element.appendChild(this.canvas);

        this._saved = {
            opacity:         video.style.getPropertyValue("opacity"),
            opacityPriority: video.style.getPropertyPriority("opacity"),
            controls:        video.controls,
        };
        this._hideVideo();
        video.controls = false;

        this._sync();
        this._loop = () => {
            this._rafHandle = requestAnimationFrame(this._loop);
            this._sync();
        };
        this._rafHandle = requestAnimationFrame(this._loop);
    }

    destroy() {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
        this.element.remove();
        const v = this._video;
        v.style.setProperty("opacity", this._saved.opacity, this._saved.opacityPriority);
        if (!this._saved.opacity) v.style.removeProperty("opacity");
        v.controls = this._saved.controls;
    }

    // ── Following the video ───────────────────────────────────────────────────

    _hideVideo() {
        // important: a site's own opacity (fades) must not show it.
        this._video.style.setProperty("opacity", "0", "important");
    }

    _sync() {
        const v = this._video;
        const o = this.element;

        if (!v.isConnected) {
            if (o.isConnected) o.remove();
            return;
        }
        let moved = false;
        if (v.nextSibling !== o) {
            v.after(o);
            moved = true;
            if (this._ticks > 0 && this._moves++ === 0) {
                console.info("[VideoCensor] The page moved the video: the censored picture follows it");
            }
        }
        if (v.style.getPropertyValue("opacity") !== "0") this._hideVideo();

        if (moved || this._ticks++ % OVERLAY_STYLE_EVERY === 0) this._copyStyle();

        const w = v.offsetWidth, h = v.offsetHeight;
        if (w !== this._width || h !== this._height) {
            this._width  = w;
            this._height = h;
            setImportant(o, "width",  `${w}px`);
            setImportant(o, "height", `${h}px`);
        }
        if (moved) {
            // A first guess in the new place; the on-screen difference below corrects it.
            this._setPosition(this._fixed ? v.getBoundingClientRect().left : v.offsetLeft,
                              this._fixed ? v.getBoundingClientRect().top  : v.offsetTop);
        }
        const vr = v.getBoundingClientRect();
        const or = o.getBoundingClientRect();
        const dx = vr.left - or.left, dy = vr.top - or.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) this._setPosition(this._left + dx, this._top + dy);
        this._applyClip(vr);
    }

    /** Clip the overlay (whose box is the video's, `vr`) to what its clipping ancestors show. */
    _applyClip(vr) {
        let clip = "none";
        if (this._clippers.length) {
            let left = -Infinity, top = -Infinity, right = Infinity, bottom = Infinity;
            for (const el of this._clippers) {
                // The padding box: what the scroller shows of its content.
                const r = el.getBoundingClientRect();
                const l = r.left + el.clientLeft, t = r.top + el.clientTop;
                left   = Math.max(left, l);
                top    = Math.max(top, t);
                right  = Math.min(right, l + el.clientWidth);
                bottom = Math.min(bottom, t + el.clientHeight);
            }
            const inset = [top - vr.top, vr.right - right, vr.bottom - bottom, left - vr.left]
                .map(x => `${Math.max(0, Math.round(x))}px`);
            clip = inset.every(x => x === "0px") ? "none" : `inset(${inset.join(" ")})`;
        }
        if (clip !== this._clip) {
            this._clip = clip;
            setImportant(this.element, "clip-path", clip);
        }
    }

    /**
     * Ancestors that clip the video but not the overlay. Only an in-flow video
     * is clipped by more: an absolutely positioned one has the overlay's
     * containing block, so the same clipping. Those are the ancestors with an
     * overflow other than visible below the overlay's containing block.
     */
    _findClippers(videoPosition) {
        const clippers = [];
        if (videoPosition === "absolute" || videoPosition === "fixed") return clippers;
        const containingBlock = this.element.offsetParent;
        if (!containingBlock) return clippers;
        for (let el = this._video.parentElement ?? this._video.getRootNode().host;
             el && el !== containingBlock;
             el = el.parentElement ?? el.getRootNode().host) {
            const cs = getComputedStyle(el);
            if (cs.overflowX !== "visible" || cs.overflowY !== "visible") clippers.push(el);
        }
        return clippers;
    }

    _setPosition(left, top) {
        this._left = left;
        this._top  = top;
        setImportant(this.element, "left", `${left}px`);
        setImportant(this.element, "top",  `${top}px`);
    }

    /** Copy what decides how the video is painted and stacked. */
    _copyStyle() {
        const cs = getComputedStyle(this._video);
        const o  = this.element;
        const fixed = cs.position === "fixed";
        if (fixed !== this._fixed) {
            this._fixed = fixed;
            setImportant(o, "position", fixed ? "fixed" : "absolute");
            const r = this._video.getBoundingClientRect();
            this._setPosition(fixed ? r.left : this._video.offsetLeft, fixed ? r.top : this._video.offsetTop);
        }
        setImportant(o, "display",          cs.display === "none" ? "none" : "block");
        setImportant(o, "visibility",       cs.visibility);
        setImportant(o, "z-index",          cs.position === "static" ? "auto" : cs.zIndex);
        setImportant(o, "transform",        cs.transform);
        setImportant(o, "transform-origin", cs.transformOrigin);
        setImportant(o, "border-radius",    cs.borderRadius);
        this._clippers    = this._findClippers(cs.position);
        setImportant(this.canvas, "object-fit",      cs.objectFit);
        setImportant(this.canvas, "object-position", cs.objectPosition);
    }
}
