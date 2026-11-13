/**
 * videos.js – Video detection and handling
 *
 * Two of the video behaviors (the third, 'prerender', is in video_jobs.js):
 *
 *   1. removeVideos: replaces <video> elements with a static placeholder clip.
 *
 *   2. censorVideos: intercepts <video> elements, sends frames over a WebSocket
 *      to <base URL>/censor_frame (ws:// or wss://), and displays the censored frames
 *      on a <canvas> in place of the video.
 *
 * The behaviors are mutually exclusive. Enabling one will disable the other.
 *
 * Load order requirement (manifest.json):
 *   state.js → … → shadow_dom.js → … → video_ws.js → video_audio.js → video_capture.js
 *   → video_renderer.js → video_controls.js → video_pipeline.js → video_jobs.js
 *   → video_drm.js → videos.js → …
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
        findVideosDeep(document).forEach(replaceVideoIfNeeded);
    } else {
        for (const placeholder of findVideosDeep(document)) {
            if (!placeholder.hasAttribute("data-censor-video-placeholder")) continue;
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

    startVideoCensorPipeline(video);
}

function applyCensorVideoSetting() {
    if (settings.censorVideos) {
        // Tear down any active remove-video placeholders first.
        if (settings.removeVideos) {
            settings.removeVideos = false;
            applyVideoSetting();
        }
        findVideosDeep(document).forEach(handleVideo);
    } else {
        findVideosDeep(document).forEach(v => stopVideoCensorPipeline(v));
    }
}
