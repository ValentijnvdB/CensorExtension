/**
 * dom-utils.js – Pure DOM helper functions
 *
 * No state of their own; everything here is a stateless utility
 */

function setSrc(img, url) {
    img.removeAttribute("srcset");
    img.removeAttribute("sizes");
    img.removeAttribute("src");
    img.src = url;
}

function getDisplayedSrc(img) {
    return img.currentSrc
        || img.src
        || img.getAttribute("srcset")?.split(",")[0]?.trim()?.split(/\s+/)[0];
}

function toAbsolute(src) {
    try { return new URL(src, document.baseURI).href; }
    catch { return src; }
}

function isOwnAsset(url) {
    return !url || url.startsWith(BASE_URL) || url.startsWith("data:") || url.startsWith("moz-extension://");
}
