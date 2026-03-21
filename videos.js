/**
 * videos.js – Video detection and removal
 *
 * Manages the videoOriginals WeakMap and exposes:
 *   replaceVideoIfNeeded(video)  – called per-element from the pipeline and observer
 *   applyVideoSetting()          – called when the removeVideos toggle changes
 */

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
