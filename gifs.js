/**
 * gifs.js – GIF detection and removal
 *
 * Manages the gifOriginals WeakMap and exposes:
 *   replaceGifIfNeeded(img)  – called per-image from the pipeline and observer
 *   applyGifSetting()        – called when the removeGifs toggle changes
 */

// Maps each replaced GIF <img> → its original src so it can be restored.
const gifOriginals = new WeakMap();

/**
 * Called whenever the removeGifs toggle changes.
 * - Turning ON:  scan all images and replace any GIFs not yet handled.
 * - Turning OFF: restore every GIF we replaced back to its original src.
 */
function applyGifSetting() {
    if (settings.removeGifs) {
        // Scan the whole page — some GIFs may not have been touched yet
        // because the setting was off when they were first seen.
        document.querySelectorAll("img").forEach(replaceGifIfNeeded);
    } else {
        // Restore all GIFs we have replaced.
        for (const img of document.querySelectorAll("img")) {
            if (gifOriginals.has(img)) {
                const original = gifOriginals.get(img);
                gifOriginals.delete(img);
                // Allow enqueueImage to process this img again if needed.
                processed.delete(img);
                setSrc(img, original);
            }
        }
    }
}

/**
 * Replace a single GIF with the removed-placeholder if removeGifs is on
 * and the image hasn't already been replaced.
 */
function replaceGifIfNeeded(img) {
    if (!settings.removeGifs) return;
    if (gifOriginals.has(img))  return;  // already replaced

    const src = getDisplayedSrc(img);
    if (!src || isOwnAsset(src)) return;

    const absolute = toAbsolute(src);
    if (!isGif(absolute)) return;

    gifOriginals.set(img, absolute);
    // Mark as processed so the censoring pipeline ignores it.
    processed.add(img);
    inFlight.add(img);

    setSrc(img, browser.runtime.getURL("assets/removed.gif"));
    inFlight.delete(img);
}

function isGif(url) {
    try {
        const path = new URL(url).pathname.toLowerCase();
        return path.endsWith(".gif");
    } catch {
        return url.toLowerCase().includes(".gif");
    }
}
