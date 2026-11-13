/**
 * content.js – Entry point
 *
 * Boots the extension: loads storage + filters, wires up the live-settings
 * message listener, and starts the DOM observer.
 *
 * Load order in manifest.json must be:
 *   state.js → dom-utils.js → shadow_dom.js → filters.js → gifs.js → … → video_drm.js
 *   → videos.js → pipeline.js → content.js
 */

// ── Init ──────────────────────────────────────────────────────────────────────

Promise.all([
    browser.storage.sync.get(SETTING_DEFAULTS),
    readConnectionSettings(),
    loadFilters(),
]).then(([stored, connection, filters]) => {
    BASE_URL = connection.baseUrl.replace(/\/$/, "");

    settings.extensionEnabled = stored.extensionEnabled;
    settings.loadBehavior     = stored.loadBehavior;
    settings.gifBehavior      = stored.gifBehavior;
    settings.videoBehavior    = stored.videoBehavior;
    settings.batchImages      = stored.batchImages;
    settings.serverFetch      = stored.serverFetch;
    settings.imageResponse    = stored.imageResponse;

    // Bool aliases used by videos.js.
    settings.removeVideos    = stored.videoBehavior === 'remove';
    settings.censorVideos    = stored.videoBehavior === 'censor';
    settings.prerenderVideos = stored.videoBehavior === 'prerender';

    // Video pipeline config.
    videoDelaySeconds = stored.videoDelaySeconds;
    videoTargetFps        = stored.videoTargetFps;
    videoMaxInFlight      = stored.videoMaxInFlight;
    videoFrameFormat      = stored.videoFrameFormat;
    frameCompressionLevel = stored.frameCompressionLevel;

    compileFilters(filters);

    initReady = true;

    if (settings.extensionEnabled) {
        for (const img of preInitQueue) enqueueImage(img);
        preInitQueue = [];
        // Videos seen before now were skipped: the video behavior wasn't known yet.
        // (Handling a video twice is harmless.)
        findVideosDeep(document).forEach(handleVideo);
    }
});

// ── Message listener (live updates from popup) ────────────────────────────────

browser.runtime.onMessage.addListener((msg) => {
    if (msg.type !== "SETTING_CHANGED") return;

    if (msg.setting === "extensionEnabled") {
        settings.extensionEnabled = msg.value;
        processAllImages();
    }

    if (msg.setting === "gifBehavior") {
        settings.gifBehavior = msg.value;
        applyGifSetting();
    }

    if (msg.setting === "videoBehavior") {
        settings.videoBehavior   = msg.value;
        settings.removeVideos    = (msg.value === 'remove');
        settings.censorVideos    = (msg.value === 'censor');
        settings.prerenderVideos = (msg.value === 'prerender');
        // Undo pre-rendering first: it may run live pipelines as a fallback.
        if (!settings.prerenderVideos) applyPrerenderVideoSetting();
        applyVideoSetting();
        applyCensorVideoSetting();
        if (settings.prerenderVideos) applyPrerenderVideoSetting();
    }

    if (msg.setting === "loadBehavior") {
        settings.loadBehavior = msg.value;
    }

    // Image requests: apply to the next requests.
    if (msg.setting === "batchImages")   settings.batchImages   = msg.value;
    if (msg.setting === "serverFetch")   settings.serverFetch   = msg.value;
    if (msg.setting === "imageResponse") settings.imageResponse = msg.value;

    // Video pipeline config
    if (msg.setting === "videoDelaySeconds") videoDelaySeconds = msg.value;
    if (msg.setting === "videoTargetFps")        videoTargetFps        = msg.value;
    if (msg.setting === "videoMaxInFlight")      videoMaxInFlight      = msg.value;
    if (msg.setting === "videoFrameFormat")      videoFrameFormat      = msg.value;
    if (msg.setting === "frameCompressionLevel") frameCompressionLevel = msg.value;
});

// ── DOM observation ───────────────────────────────────────────────────────────

function processAllImages() {
    if (settings.extensionEnabled) {
        document.querySelectorAll("img").forEach(enqueueImage);
        findVideosDeep(document).forEach(handleVideo);
    }
}

/** Applies the video behavior to a <video>. */
function handleVideo(video) {
    // A DRM-protected video can't be censored: it stays as it is (video_drm.js).
    if (settings.censorVideos || settings.prerenderVideos) {
        watchForDrm(video);
        if (isDrmVideo(video)) {
            leaveDrmVideoAlone(video);
            return;
        }
    }
    replaceVideoIfNeeded(video);
    censorVideoIfNeeded(video);
    prerenderVideoIfNeeded(video);
}

const observer = new MutationObserver((mutations) => {
    if (settings.extensionEnabled) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.tagName === "IMG") {
                    enqueueImage(node);
                } else if (node.tagName === "VIDEO") {
                    handleVideo(node);
                } else {
                    node.querySelectorAll?.("img").forEach(enqueueImage);
                    findVideosDeep(node).forEach(handleVideo);
                }
            }

            if (mutation.type === "attributes" && mutation.target.tagName === "IMG") {
                const img = mutation.target;
                if (inFlight.has(img)) continue;
                enqueueImage(img);
            }
        }
    }
});

// Videos inside shadow roots (shadow_dom.js): the observer above doesn't see
// into them, so each shadow root gets one of its own. Only videos are handled there.
const shadowObserver = new MutationObserver((mutations) => {
    if (!settings.extensionEnabled) return;
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) findVideosDeep(node).forEach(handleVideo);
        }
    }
});

onShadowRoot = (root) => shadowObserver.observe(root, { childList: true, subtree: true });

function init() {
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset", "sizes"],
    });
    if (settings.extensionEnabled) {
        processAllImages();
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}
