/**
 * background.js – Per-tab notices on the toolbar button
 *
 * Content scripts report each DRM-protected video they can't censor
 * ({type: "DRM_VIDEO_FOUND"}, see video/video_drm.js). The tab then gets a
 * "!" badge, and the popup asks for the tab's notices with
 * {type: "GET_TAB_NOTICES", tabId} → {drmVideos: <count>}.
 *
 * A tab's notices are cleared when it loads a new page (not on in-page
 * navigation, which keeps the same content scripts).
 */

const _drmVideoCounts = new Map();   // tabId → DRM-protected videos reported

function _showBadge(tabId) {
    const count = _drmVideoCounts.get(tabId) ?? 0;
    const title = count === 1
        ? "Image Censor: a DRM-protected video on this page is shown uncensored"
        : `Image Censor: ${count} DRM-protected videos on this page are shown uncensored`;
    browser.browserAction.setBadgeText({ tabId, text: "!" }).catch(() => {});
    browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#f59e0b" }).catch(() => {});
    browser.browserAction.setTitle({ tabId, title }).catch(() => {});
}

function _clearTab(tabId) {
    if (!_drmVideoCounts.delete(tabId)) return;
    browser.browserAction.setBadgeText({ tabId, text: "" }).catch(() => {});
    browser.browserAction.setTitle({ tabId, title: null }).catch(() => {});
}

browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === "DRM_VIDEO_FOUND") {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return;
        _drmVideoCounts.set(tabId, (_drmVideoCounts.get(tabId) ?? 0) + 1);
        _showBadge(tabId);
        return;
    }
    if (msg?.type === "GET_TAB_NOTICES") {
        return Promise.resolve({ drmVideos: _drmVideoCounts.get(msg.tabId) ?? 0 });
    }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") _clearTab(tabId);
});

browser.tabs.onRemoved.addListener(tabId => _drmVideoCounts.delete(tabId));
