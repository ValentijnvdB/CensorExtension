/**
 * video_drm.js – DRM-protected (EME) videos
 *
 * No script can read the frames of a DRM-protected video (Netflix, Disney+,
 * Prime Video, …): a capture is black. Such a video can't be censored, live
 * or pre-rendered, so in those modes it is left to the page unmodified. The
 * console says so, and the background script marks the tab: a "!" on the
 * toolbar button and a notice at the top of the popup.
 *
 * A video counts as protected once it has MediaKeys or fires "encrypted"
 * (the browser found encrypted media data). The "remove" mode works on them
 * as usual: it doesn't need their frames.
 */

const _drmVideos     = new WeakSet();   // seen to be protected
const _drmWatched    = new WeakSet();   // listeners added
const _drmReported   = new WeakSet();   // logged and reported to the background

function _hasMediaKeys(video) {
    try {
        return Boolean(video.mediaKeys);
    } catch {
        return false;
    }
}

/** Whether `video` is known to be DRM-protected. */
function isDrmVideo(video) {
    if (_hasMediaKeys(video)) _drmVideos.add(video);
    return _drmVideos.has(video);
}

/** Whether the current video behavior needs the frames (and so fails on DRM). */
function _censorsVideos() {
    return settings.censorVideos || settings.prerenderVideos;
}

/** Listens for `video` turning out to be protected (only once per video). */
function watchForDrm(video) {
    if (_drmWatched.has(video)) return;
    _drmWatched.add(video);

    const found = () => {
        _drmVideos.add(video);
        if (_censorsVideos()) leaveDrmVideoAlone(video);
    };
    const check = () => { if (_hasMediaKeys(video)) found(); };

    video.addEventListener("encrypted", found);
    video.addEventListener("loadedmetadata", check);
    video.addEventListener("play", check);
}

/**
 * Undoes whatever censoring started on a protected video (it shows the page's
 * own video again) and reports it once.
 */
function leaveDrmVideoAlone(video) {
    releasePrerender(video);
    stopVideoCensorPipeline(video);

    if (_drmReported.has(video)) return;
    _drmReported.add(video);
    console.warn(
        "[VideoCensor] DRM-protected video: its frames can't be read, so it can't be censored. " +
        "It is shown unmodified.", videoSourceUrl(video) || "(MediaSource stream)",
    );
    browser.runtime.sendMessage({ type: "DRM_VIDEO_FOUND" }).catch(() => {});
}
