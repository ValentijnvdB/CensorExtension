/**
 * videos.js – Video detection and handling
 *
 * Two independent features are managed here:
 *
 *   1. removeVideos (existing): replaces <video> elements with a static
 *      placeholder clip — unchanged from the original implementation.
 *
 *   2. censorVideos (new): intercepts <video> elements, sends frames
 *      frame-by-frame over a WebSocket to wss://localhost:8443/censor_videos,
 *      and displays the censored frames on a <canvas> in place of the video.
 *      Controlled by settings.censorVideos (distinct from removeVideos).
 *
 * Load order requirement (manifest.json):
 *   state.js → … → video_ws.js → video_capture.js → video_renderer.js
 *   → video_pipeline.js → videos.js → …
 */

// ── Feature 1: removeVideos (original, unchanged) ────────────────────────────

// Maps each placeholder <video> → the original <video> it replaced.
const videoOriginals = new WeakMap();

/**
 * Called whenever the removeVideos toggle changes.
 * - Turning ON:  find all videos and replace them with the placeholder.
 * - Turning OFF: restore every video we replaced.
 */
function applyVideoSetting() {
    if (settings.removeVideos) {
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

/**
 * Replace a single <video> with a placeholder if removeVideos is on
 * and it hasn't already been replaced.
 */
function replaceVideoIfNeeded(video) {
    if (!settings.removeVideos) return;
    if (videoOriginals.has(video)) return;  // already replaced

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

// ── Feature 2: censorVideos (new) ────────────────────────────────────────────

/**
 * Called from the pipeline and MutationObserver for each new <video> element.
 * Skips elements that are our own injected placeholders or canvas wrappers.
 */
function censorVideoIfNeeded(video) {
    if (!settings.censorVideos) return;
    if (video.hasAttribute("data-censor-video-placeholder")) return;
    if (video.hasAttribute("data-censor-source")) return;
    if (video.closest("[data-censor-wrapper]")) return;

    startVideoCensorPipeline(video);
}

/**
 * Called whenever the censorVideos toggle changes.
 * - Turning ON:  start pipelines for all current videos.
 * - Turning OFF: tear down all active pipelines and restore originals.
 */
function applyCensorVideoSetting() {
    if (settings.censorVideos) {
        document.querySelectorAll("video").forEach(censorVideoIfNeeded);
    } else {
        document.querySelectorAll("video").forEach(v => stopVideoCensorPipeline(v));
    }
}
