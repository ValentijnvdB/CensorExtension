/**
 * video_jobs.js – Pre-rendered video censoring (videoBehavior 'prerender')
 *
 * Censors a whole <video> on the server as a background job (POST /videos,
 * see the backend's http_api.md#video-jobs) and swaps the censored file in
 * once it is done. Seeking and audio then work as usual, unlike the live
 * mode (video_pipeline.js), which suits long videos and streams better.
 *
 * Per video:
 *   1. The video is paused and hidden (the load behavior as a CSS filter),
 *      with an overlay showing the job's progress. Playing it is blocked
 *      until the censored version is in; a play attempt is remembered and
 *      replayed then.
 *   2. Once the video is near the viewport, a job is started with its URL
 *      (video_url). If the server can't download it (download_failed,
 *      url_not_allowed), the browser downloads it and uploads it.
 *   3. The job is polled for its state and progress. When done, the result
 *      is downloaded once and played from a blob: URL: the server streams it
 *      without range requests.
 *
 * Falls back to the live mode for videos without a URL (MediaSource/blob:,
 * srcObject), videos over the server's 100 MB limit, and when the server's
 * job queue is full.
 *
 * An unfinished job is cancelled (DELETE /videos/<id>) when the video leaves
 * the page, the page is closed, or the setting changes. The server lets the
 * work go on for a short grace period, so a reloaded page takes it over: its
 * new job for the same video shares the work. A finished job is left on the
 * server, which keeps it for an hour, so a reload within that hour gets the
 * censored video straight away.
 */

const JOB_POLL_MS          = 1000;
const JOB_START_MARGIN     = "600px";              // start jobs this far before a video scrolls into view
const JOB_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;    // the server's request limit
const JOB_MAX_POLL_ERRORS  = 30;                   // consecutive failed polls before giving up
const JOB_SUBMIT_RETRIES   = 3;

// The server could not download the video itself: the browser uploads it.
const JOB_UPLOAD_CODES = new Set(["download_failed", "url_not_allowed"]);
// The server is busy or down: try again.
const JOB_RETRY_CODES  = new Set(["network", "unavailable"]);

const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi"];

const JOB_PHASE_LABELS = { detecting: "Detecting", censoring: "Censoring", encoding: "Encoding" };

// <video> → PrerenderedVideo
const _prerenders = new Map();

const _prerenderVisibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
        if (entry.isIntersecting) _prerenders.get(entry.target)?.onVisible();
    }
}, { rootMargin: JOB_START_MARGIN });

// ── Public API (used by videos.js and content.js) ─────────────────────────────

function prerenderVideoIfNeeded(video) {
    if (!settings.prerenderVideos) return;
    if (_prerenders.has(video)) return;
    if (video.hasAttribute("data-censor-video-placeholder")) return;
    if (video.hasAttribute("data-censor-source")) return;
    if (video.closest("[data-censor-wrapper]")) return;

    const prerender = new PrerenderedVideo(video);
    _prerenders.set(video, prerender);
    prerender.attach();
}

/** Undoes every pre-rendered video: cancels jobs, restores the originals. */
function stopAllPrerenders() {
    for (const prerender of _prerenders.values()) prerender.destroy();
    _prerenders.clear();
}

/**
 * Gives a video back to its page unmodified (a DRM-protected one), and plays
 * it if the page wanted it to play while it was blocked.
 */
function releasePrerender(video) {
    const prerender = _prerenders.get(video);
    if (!prerender) return;
    _prerenders.delete(video);
    const wantsPlay = prerender.wantsPlay;
    prerender.destroy();
    if (wantsPlay) video.play().catch(() => {});
}

function applyPrerenderVideoSetting() {
    if (settings.prerenderVideos) {
        findVideosDeep(document).forEach(handleVideo);
    } else {
        stopAllPrerenders();
    }
}

// Jobs nobody will look at any more only take the server's time.
window.addEventListener("pagehide", () => {
    for (const prerender of _prerenders.values()) prerender.cancelJob({ keepalive: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The URL the video plays from, or "" when it has none (yet). */
function videoSourceUrl(video) {
    return video.currentSrc
        || video.getAttribute("src")
        || video.querySelector("source[src]")?.getAttribute("src")
        || "";
}

/** A byte count as megabytes, for log messages. */
function formatMB(bytes) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file name for the backend, ending in a video extension. */
function videoFilename(src) {
    let name = "";
    try { name = decodeURIComponent(new URL(src).pathname.split("/").pop()); } catch { /* use default */ }
    name = name.replace(/[^\w.-]/g, "_").replace(/^\.+/, "") || "video";
    const ext = name.split(".").pop().toLowerCase();
    return VIDEO_EXTENSIONS.includes(ext) && name.includes(".") ? name : `${name}.mp4`;
}

/** The CSS filter that hides a video while it waits, after settings.loadBehavior. */
function videoHideFilter() {
    if (settings.loadBehavior === "pixelate") {
        ensurePixelateFilter();
        return `url(#${PIXELATE_FILTER_ID})`;
    }
    if (settings.loadBehavior === "blur") return `blur(${BLUR_STRENGTH}px)`;
    return "brightness(0)";   // placeholder: a black frame
}

// ── Progress overlay ──────────────────────────────────────────────────────────

class JobOverlay {
    constructor(video) {
        this._video = video;

        this.el = document.createElement("div");
        this.el.setAttribute("data-censor-overlay", "true");
        this.el.style.cssText = [
            "position:absolute", "z-index:2147483646", "pointer-events:none", "box-sizing:border-box",
            "display:flex", "flex-direction:column", "align-items:center", "justify-content:center", "gap:8px",
            "padding:12px", "background:rgba(0,0,0,0.55)", "color:#fff", "text-align:center",
            "font:500 13px/1.4 system-ui,sans-serif", "text-shadow:0 1px 2px #000",
        ].join(";");

        this._label = document.createElement("div");
        this._detail = document.createElement("div");
        this._detail.style.cssText = "font-size:11px;opacity:0.8";

        this._track = document.createElement("div");
        this._track.style.cssText =
            "width:min(220px,70%);height:4px;border-radius:2px;background:rgba(255,255,255,0.25);overflow:hidden";
        this._bar = document.createElement("div");
        this._bar.style.cssText = "height:100%;width:0;background:#e8ff47;transition:width 0.4s";
        this._track.appendChild(this._bar);

        this.el.append(this._label, this._track, this._detail);

        video.after(this.el);
        this._resizeObserver = new ResizeObserver(() => this.reposition());
        this._resizeObserver.observe(video);
        this.reposition();
    }

    /**
     * @param {string} label
     * @param {number|null|undefined} progress  0-1; null = unknown (pulsing bar); undefined = no bar
     * @param {string} detail
     */
    show(label, progress = undefined, detail = "") {
        this._label.textContent  = label;
        this._detail.textContent = detail;
        this._track.style.display = progress === undefined ? "none" : "";
        if (progress === null) {
            this._bar.style.width = "100%";
            this._bar.style.opacity = "0.5";
        } else if (progress !== undefined) {
            this._bar.style.width = `${Math.round(progress * 100)}%`;
            this._bar.style.opacity = "1";
        }
        this.reposition();
    }

    /** Covers the video. The overlay is a sibling, so they share an offsetParent. */
    reposition() {
        const v = this._video;
        Object.assign(this.el.style, {
            left:   `${v.offsetLeft}px`,
            top:    `${v.offsetTop}px`,
            width:  `${v.offsetWidth}px`,
            height: `${v.offsetHeight}px`,
            display: v.offsetWidth && v.offsetHeight ? "flex" : "none",
        });
    }

    remove() {
        this._resizeObserver.disconnect();
        this.el.remove();
    }
}

// ── One video ─────────────────────────────────────────────────────────────────

class PrerenderedVideo {
    constructor(video) {
        this.video = video;

        this._state       = "waiting";   // waiting | starting | running | done | live | failed | destroyed
        this._jobId       = null;
        this._src         = "";
        this._uploaded    = false;       // the browser uploaded the video
        this._resubmitted = false;       // the job was started again after it vanished
        this._pollTimer   = null;
        this._pollErrors  = 0;
        this._controller  = new AbortController();

        this._overlay     = null;
        this._savedFilter = null;
        this._wantsPlay   = false;

        this._original = null;           // { src, sources } once the censored video is swapped in
        this._blobUrl  = null;

        this._onPlay      = this._onPlay.bind(this);
        this._onLoadStart = this._onLoadStart.bind(this);
    }

    /** The page tried to play the video (or it autoplays) while it was blocked. */
    get wantsPlay() { return this._wantsPlay; }

    attach() {
        this._block();
        this._overlay.show("Censoring video", undefined, "Waiting until it is in view…");
        _prerenderVisibility.observe(this.video);
    }

    onVisible() {
        _prerenderVisibility.unobserve(this.video);
        if (this._state === "waiting") this._start();
    }

    // ── Blocking playback ─────────────────────────────────────────────────────

    _block() {
        const v = this.video;
        this._wantsPlay   = v.autoplay || !v.paused;
        this._savedFilter = v.style.filter;
        v.style.filter    = videoHideFilter();
        v.pause();
        v.addEventListener("play", this._onPlay);
        this._overlay ??= new JobOverlay(v);
    }

    _unblock() {
        const v = this.video;
        v.removeEventListener("play", this._onPlay);
        if (this._savedFilter !== null) v.style.filter = this._savedFilter;
        this._savedFilter = null;
        this._overlay?.remove();
        this._overlay = null;
    }

    _onPlay() {
        // Not censored yet: remember the wish and wait.
        this._wantsPlay = true;
        this.video.pause();
    }

    // ── Starting the job ──────────────────────────────────────────────────────

    _start() {
        const v   = this.video;
        const raw = videoSourceUrl(v);

        if (v.srcObject || raw.startsWith("blob:") || raw.startsWith("data:")) {
            // MediaSource players (most large sites) and streams have no file to send.
            this._fallBackToLive("the video has no file URL (MediaSource/blob:, data: or a stream)");
            return;
        }
        if (!raw) {
            // The player sets the source later.
            this._state = "waiting";
            this._overlay.show("Censoring video", undefined, "Waiting for the video to load…");
            v.addEventListener("loadstart", this._onLoadStart, { once: true });
            return;
        }
        this._src = toAbsolute(raw);

        this._state = "starting";
        if (isHttpUrl(this._src)) {
            console.info("[VideoCensor] Pre-render: asking the server to download", this._src);
            this._submit({ video_url: this._src });
        } else {
            this._uploadFromBrowser();
        }
    }

    _onLoadStart() {
        if (this._state === "waiting") this._start();
    }

    async _uploadFromBrowser() {
        this._uploaded = true;
        this._overlay.show("Censoring video", null, "Downloading the video…");
        console.info("[VideoCensor] Pre-render: downloading in the browser", this._src);
        const started = performance.now();
        let blob;
        try {
            blob = await fetchBlob(this._src, this._controller.signal);
        } catch (err) {
            if (err.name !== "AbortError") this._fail("The video could not be downloaded.", err);
            return;
        }
        if (this._state === "destroyed") return;
        console.info(`[VideoCensor] Pre-render: downloaded ${formatMB(blob.size)} in ` +
                     `${((performance.now() - started) / 1000).toFixed(1)} s`, this._src);
        if (blob.size > JOB_MAX_UPLOAD_BYTES) {
            // the server would refuse it
            this._fallBackToLive(`the video is ${formatMB(blob.size)}, over the server's ${formatMB(JOB_MAX_UPLOAD_BYTES)} limit`);
            return;
        }
        this._submit({ video: blob });
    }

    /** POST /videos with `video_url` or `video` (a Blob), then polls the job. */
    async _submit(source, attempt = 0) {
        this._overlay.show("Censoring video", null, source.video ? "Uploading…" : "Starting…");
        const filename = videoFilename(this._src);

        let answer;
        for (;;) {
            const config = await getRequestConfig("video");
            if (this._state === "destroyed") return;

            // `filename` must come before `video` (see the backend's http_api.md).
            const form = new FormData();
            form.append("filename", filename);
            form.append("format", filename.toLowerCase().endsWith(".webm") ? "webm" : "mp4");
            if (source.video) form.append("video", source.video, filename);
            else              form.append("video_url", source.video_url);
            if (config) form.append("config", JSON.stringify(config));

            try {
                answer = await apiRequest(`${BASE_URL}/videos`, {
                    method: "POST", body: form, signal: this._controller.signal,
                });
                break;
            } catch (err) {
                if (err.name === "AbortError") return;
                if (config && isConfigError(err)) {
                    rejectConfig(err);
                    continue;
                }
                if (err.code === "queue_full") {
                    this._fallBackToLive("the server's video queue is full");
                } else if (JOB_UPLOAD_CODES.has(err.code) && !source.video) {
                    // The server refused the URL straight away (e.g. localhost): upload it ourselves.
                    console.info(`[VideoCensor] Pre-render: the server can't download it (${err.code}: ` +
                                 `${err.message}), uploading it from the browser`);
                    this._uploadFromBrowser();
                } else if (JOB_RETRY_CODES.has(err.code) && attempt < JOB_SUBMIT_RETRIES) {
                    this._overlay.show("Censoring video", null, "The server is not available, retrying…");
                    setTimeout(() => this._submit(source, attempt + 1), RETRY_BASE_MS * 2 ** attempt);
                } else {
                    this._fail("The server could not start censoring this video.", err);
                }
                return;
            }
        }

        this._jobId = answer.job?.id ?? null;
        if (!this._jobId) {
            this._fail("The server did not start a job.", new Error("no job id"));
            return;
        }
        if (this._state === "destroyed") {
            this.cancelJob();
            return;
        }
        this._state = "running";
        this._showJob(answer.job);
        this._schedulePoll();
    }

    // ── Polling ───────────────────────────────────────────────────────────────

    _schedulePoll() {
        clearTimeout(this._pollTimer);
        this._pollTimer = setTimeout(() => this._poll(), JOB_POLL_MS);
    }

    async _poll() {
        if (this._state !== "running") return;
        if (!this.video.isConnected) {
            // The video left the page.
            _prerenders.delete(this.video);
            this.destroy();
            return;
        }

        let job;
        try {
            job = (await apiRequest(`${BASE_URL}/videos/${this._jobId}`, { signal: this._controller.signal })).job;
            this._pollErrors = 0;
        } catch (err) {
            if (err.name === "AbortError") return;
            if (err.code === "not_found" && !this._resubmitted) {
                // The job vanished (server restart, expired): start it again once.
                this._resubmitted = true;
                this._jobId = null;
                this._state = "starting";
                this._start();
                return;
            }
            if (err.code === "not_found" || ++this._pollErrors >= JOB_MAX_POLL_ERRORS) {
                this._fail("Lost track of the censoring job.", err);
                return;
            }
            this._overlay.show("Censoring video", null, "Lost contact with the server, retrying…");
            this._schedulePoll();
            return;
        }
        if (this._state !== "running") return;

        this._showJob(job);
        if (job.state === "done") {
            this._fetchResult(job);
        } else if (job.state === "failed") {
            if (JOB_UPLOAD_CODES.has(job.code) && !this._uploaded) {
                console.info(`[VideoCensor] Pre-render: the server could not download it (${job.code}: ` +
                             `${job.error}), uploading it from the browser`);
                this._jobId = null;
                this._state = "starting";
                this._uploadFromBrowser();
            } else {
                this._fail("The server could not censor this video.", new ApiError(job.code, job.error ?? "failed"));
            }
        } else if (job.state === "cancelled") {
            this._fail("The censoring job was cancelled on the server.", new Error("cancelled"));
        } else {
            this._schedulePoll();
        }
    }

    _showJob(job) {
        const progress = typeof job.progress === "number" ? job.progress : null;
        switch (job.state) {
            case "downloading":
                this._overlay.show("Censoring video", 0, "The server is downloading the video…");
                break;
            case "queued":
                this._overlay.show("Censoring video", 0,
                    job.queue_position ? `Waiting in line: #${job.queue_position}` : "Waiting in line…");
                break;
            case "running": {
                const phase = JOB_PHASE_LABELS[job.phase] ?? "Censoring";
                const pct   = progress === null ? "" : ` ${Math.round(progress * 100)}%`;
                const frames = job.frames_total ? ` · ${job.frames_done ?? 0}/${job.frames_total} frames` : "";
                this._overlay.show("Censoring video", progress, `${phase}…${pct}${frames}`);
                break;
            }
            case "done":
                this._overlay.show("Censoring video", 1, "Loading the censored video…");
                break;
        }
    }

    // ── Result ────────────────────────────────────────────────────────────────

    async _fetchResult(job) {
        this._state = "done";
        const url = job.result_url?.startsWith("/") ? `${BASE_URL}${job.result_url}` : `${BASE_URL}/videos/${this._jobId}/result`;
        let blob;
        try {
            const res = await fetch(url, { signal: this._controller.signal, cache: "no-store" });
            if (!res.ok) throw await readApiError(res);
            blob = await res.blob();
        } catch (err) {
            if (err.name !== "AbortError") this._fail("The censored video could not be downloaded.", err);
            return;
        }
        if (this._state === "destroyed") return;
        console.info(`[VideoCensor] Pre-render: censored video ready (${formatMB(blob.size)})`, this._src);

        this._swapIn(blob);
    }

    _swapIn(blob) {
        const v = this.video;
        const time = v.currentTime;

        this._original = {
            src:     v.getAttribute("src"),
            sources: [...v.querySelectorAll("source")],
        };
        this._original.sources.forEach(s => s.remove());

        this._blobUrl = URL.createObjectURL(blob);
        v.addEventListener("loadeddata", () => {
            if (this._state !== "done") return;
            if (time) v.currentTime = time;
            this._unblock();
            if (this._wantsPlay) v.play().catch(() => { /* autoplay blocked: the user can press play */ });
        }, { once: true });
        v.src = this._blobUrl;
    }

    // ── Fallbacks ─────────────────────────────────────────────────────────────

    _fallBackToLive(reason) {
        console.info(`[VideoCensor] Pre-render: using live censoring instead, because ${reason}`, this._src);
        this.cancelJob();
        this._unblock();
        this._state = "live";
        startVideoCensorPipeline(this.video);
        if (!isVideoCensorPipelineActive(this.video)) {
            // The live mode can't read this video (cross-origin): keep it hidden.
            stopVideoCensorPipeline(this.video);
            this._state = "failed";
            this._block();
            this._overlay.show("Can't censor this video", undefined,
                "It can't be sent to the server and can't be censored live.");
        }
    }

    _fail(message, err) {
        console.warn("[VideoCensor] Pre-rendering failed:", this._src, err);
        clearTimeout(this._pollTimer);
        this.cancelJob();
        this._state = "failed";
        // The video stays hidden, nothing uncensored is shown.
        this._overlay?.show("Can't censor this video", undefined, `${message} ${err?.message ?? ""}`.trim());
    }

    // ── Clean-up ──────────────────────────────────────────────────────────────

    /** DELETE /videos/<id> for an unfinished job (the server cancels its work after a grace period). */
    cancelJob({ keepalive = false } = {}) {
        // A finished job stays on the server, which keeps it for an hour: a
        // reload of the page then gets the censored video straight away.
        if (!this._jobId || this._state === "done") return;
        const id = this._jobId;
        this._jobId = null;
        fetch(`${BASE_URL}/videos/${id}`, { method: "DELETE", keepalive }).catch(() => { /* best effort */ });
    }

    destroy() {
        const wasLive = this._state === "live";
        this._state = "destroyed";
        clearTimeout(this._pollTimer);
        this._controller.abort();
        this.cancelJob();
        _prerenderVisibility.unobserve(this.video);
        this.video.removeEventListener("loadstart", this._onLoadStart);
        this._unblock();

        if (wasLive) stopVideoCensorPipeline(this.video);

        if (this._original) {
            const v = this.video;
            v.removeAttribute("src");
            if (this._original.src !== null) v.setAttribute("src", this._original.src);
            v.append(...this._original.sources);
            v.load();
            this._original = null;
        }
        if (this._blobUrl) {
            URL.revokeObjectURL(this._blobUrl);
            this._blobUrl = null;
        }
    }
}
