/**
 * videos.js – Video detection and handling
 *
 * Two mutually exclusive features:
 *
 *   1. removeVideos: replaces <video> elements with a static placeholder clip.
 *
 *   2. censorVideos: intercepts <video> elements, sends frames over a WebSocket
 *      to wss://localhost:8443/censor_video, and displays the censored frames
 *      on a <canvas> in place of the video.
 *
 * The two features are mutually exclusive. Enabling one will disable the other.
 *
 * Load order requirement (manifest.json):
 *   state.js → … → video_ws.js → video_capture.js → video_renderer.js
 *   → video_pipeline.js → videos.js → …
 */

// ── Feature 1: removeVideos ───────────────────────────────────────────────────

const videoOriginals = new WeakMap();

function applyVideoSetting() {
    if (settings.removeVideos) {
        // Tear down any active censor pipelines first.
        if (settings.censorVideos) {
            settings.censorVideos = false;
            applyCensorVideoSetting();
        }
        document.querySelectorAll("video").forEach(replaceVideoIfNeeded);
    } else {
        for (const placeholder of document.querySelectorAll("video[data-censor-video-placeholder]")) {
            const original = videoOriginals.get(placeholder);
            if (!original) continue;
            videoOriginals.delete(placeholder);
            placeholder.replaceWith(original);
        }
    }
}

function replaceVideoIfNeeded(video) {
    if (!settings.removeVideos) return;
    if (videoOriginals.has(video)) return;

    const placeholder = document.createElement("video");
    placeholder.setAttribute("data-censor-video-placeholder", "true");
    placeholder.src    = `${BASE_URL}/assets/removed.mp4`;
    placeholder.width  = video.offsetWidth  || video.width  || 320;
    placeholder.height = video.offsetHeight || video.height || 180;
    placeholder.style.cssText = video.style.cssText;
    placeholder.className     = video.className;

    videoOriginals.set(placeholder, video);
    video.replaceWith(placeholder);
}

// ── Feature 2: censorVideos ───────────────────────────────────────────────────

function censorVideoIfNeeded(video) {
    if (!settings.censorVideos) return;
    if (video.hasAttribute("data-censor-video-placeholder")) return;
    if (video.hasAttribute("data-censor-source")) return;
    if (video.closest("[data-censor-wrapper]")) return;

    startVideoCensorPipeline(video);
}

function applyCensorVideoSetting() {
    if (settings.censorVideos) {
        // Tear down any active remove-video placeholders first.
        if (settings.removeVideos) {
            settings.removeVideos = false;
            applyVideoSetting();
        }
        document.querySelectorAll("video").forEach(censorVideoIfNeeded);
    } else {
        document.querySelectorAll("video[data-censor-source]").forEach(v => {
            // Walk up to find the original video element tracked by the pipeline.
            // stopVideoCensorPipeline expects the *original* video, which the
            // pipeline stored in _activePipelines keyed by the original element.
            // The MutationObserver / initial scan always calls us with the original,
            // but if called from applyCensorVideoSetting we need to find originals.
            const wrapper = v.closest("[data-censor-wrapper]");
            if (wrapper) {
                const original = wrapper.__censorOriginal;
                if (original) stopVideoCensorPipeline(original);
            }
        });

        // Fallback: also attempt to stop any video that might be the original.
        document.querySelectorAll("video").forEach(v => stopVideoCensorPipeline(v));
    }
}
