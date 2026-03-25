/**
 * content.js – Entry point
 *
 * Boots the extension: loads storage + filters, wires up the live-settings
 * message listener, and starts the DOM observer.
 *
 * Load order in manifest.json must be:
 *   state.js → dom-utils.js → filters.js → gifs.js → videos.js → pipeline.js → content.js
 */

// ── Init ──────────────────────────────────────────────────────────────────────

Promise.all([
    browser.storage.sync.get({ ...DEFAULTS, ...SETTING_DEFAULTS }),
    loadFilters(),
]).then(([stored, filters]) => {
    BASE_URL  = stored.baseUrl.replace(/\/$/, "");
    ENDPOINTS = {
        process: `${BASE_URL}${stored.process}`,
        loading: browser.runtime.getURL("assets/loading_image.png"),
    };

    settings.extensionEnabled = stored.extensionEnabled;
    settings.loadBehavior     = stored.loadBehavior;
    settings.gifBehavior      = stored.gifBehavior;
    settings.videoBehavior    = stored.videoBehavior;

    // Bool aliases used by gifs.js / videos.js.
    settings.removeGifs   = stored.gifBehavior   === 'remove';
    settings.removeVideos = stored.videoBehavior === 'remove';
    settings.censorVideos = stored.videoBehavior === 'censor';

    // Video pipeline config.
    videoPrebufferSeconds = stored.videoPrebufferSeconds;
    videoTargetFps        = stored.videoTargetFps;
    videoMaxInFlight      = stored.videoMaxInFlight;
    videoFrameFormat      = stored.videoFrameFormat;
    frameCompressionLevel = stored.frameCompressionLevel;

    compileFilters(filters);

    initReady = true;

    if (settings.extensionEnabled) {
        for (const img of preInitQueue) enqueueImage(img);
        preInitQueue = [];
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
        settings.removeGifs  = (msg.value === 'remove');
        applyGifSetting();
    }

    if (msg.setting === "videoBehavior") {
        settings.videoBehavior = msg.value;
        settings.removeVideos  = (msg.value === 'remove');
        settings.censorVideos  = (msg.value === 'censor');
        applyVideoSetting();
        applyCensorVideoSetting();
    }

    if (msg.setting === "loadBehavior") {
        settings.loadBehavior = msg.value;
    }

    // Video pipeline config
    if (msg.setting === "videoPrebufferSeconds") videoPrebufferSeconds = msg.value;
    if (msg.setting === "videoTargetFps")        videoTargetFps        = msg.value;
    if (msg.setting === "videoMaxInFlight")      videoMaxInFlight      = msg.value;
    if (msg.setting === "videoFrameFormat")      videoFrameFormat      = msg.value;
    if (msg.setting === "frameCompressionLevel") frameCompressionLevel = msg.value;
});

// ── DOM observation ───────────────────────────────────────────────────────────

function processAllImages() {
    if (settings.extensionEnabled) {
        document.querySelectorAll("img").forEach(enqueueImage);
        document.querySelectorAll("video").forEach(replaceVideoIfNeeded);
        document.querySelectorAll("video").forEach(censorVideoIfNeeded);
    }
}

const observer = new MutationObserver((mutations) => {
    if (settings.extensionEnabled) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.tagName === "IMG") {
                    enqueueImage(node);
                } else if (node.tagName === "VIDEO") {
                    replaceVideoIfNeeded(node);
                    censorVideoIfNeeded(node);
                } else {
                    node.querySelectorAll?.("img").forEach(enqueueImage);
                    node.querySelectorAll?.("video").forEach(replaceVideoIfNeeded);
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
