/**
 * gifs.js – GIF handling
 *
 * GIFs never go through the image pipeline. What happens to them depends on
 * settings.gifBehavior:
 *   'nothing' – left untouched, no request to the backend.
 *   'remove'  – src replaced with assets/removed.gif, no request to the backend.
 *   'censor'  – sent to POST /censor_video (the backend censors GIFs as videos)
 *               while the user's load behavior is shown. The censored GIF
 *               replaces the src.
 *
 * Exposes:
 *   handleGif(img, src)                 – called by enqueueImage for GIF URLs
 *   handleDetectedGif(img, src, blob)   – called by the image pipeline when a
 *                                         download turns out to be a GIF
 *   applyGifSetting()                   – called when gifBehavior changes
 */

// Every <img> that was handled as a GIF, so it can be handled again when the
// behavior changes.
const gifImgs = new WeakSet();

// Removed or censored <img> → its original src.
const gifOriginals = new WeakMap();

// 'censor': <img> with a request in flight → { controller, src }.
const gifRequests = new Map();

function isGif(url) {
    try {
        return new URL(url).pathname.toLowerCase().endsWith(".gif");
    } catch {
        return url.toLowerCase().includes(".gif");
    }
}

/** Handles a GIF <img> according to settings.gifBehavior. */
function handleGif(img, src) {
    processed.add(img);
    gifImgs.add(img);

    if (settings.gifBehavior === "remove") {
        removeGif(img, src);
    } else if (settings.gifBehavior === "censor" && !isFiltered(src)) {
        censorGif(img, src);
    }
    // 'nothing': leave the GIF as it is.
}

/**
 * Called by the image pipeline when an image without a .gif URL turned out
 * to be a GIF. The load behavior is already applied and `blob` downloaded.
 */
function handleDetectedGif(img, src, blob) {
    gifImgs.add(img);

    if (settings.gifBehavior === "censor") {
        censorGif(img, src, blob);
        return;
    }

    restoreImg(img, src);
    if (settings.gifBehavior === "remove") removeGif(img, src);
}

// ── Remove ────────────────────────────────────────────────────────────────────

function removeGif(img, src) {
    gifOriginals.set(img, src);
    setSrc(img, browser.runtime.getURL("assets/removed.gif"));
}

// ── Censor ────────────────────────────────────────────────────────────────────

/**
 * Sends the GIF to /censor_video and shows the result in place of `img`.
 * Without `blob` the GIF is downloaded and the load behavior applied first;
 * with `blob` (handed over by the image pipeline) both are already done.
 */
async function censorGif(img, src, blob = null) {
    const controller = new AbortController();
    gifRequests.set(img, { controller, src });
    inFlight.add(img);
    if (!blob) applyLoadBehavior(img);

    try {
        blob ??= await fetchBlob(src, controller.signal);
        const config   = await getCensorSettings("video");
        const filename = gifFilename(src);

        // `filename` must come before `video` (see the backend's http_api.md).
        const form = new FormData();
        form.append("filename", filename);
        form.append("format", "gif");
        form.append("video", blob, filename);
        if (config) form.append("config", JSON.stringify(config));

        const response = await fetch(`${BASE_URL}/censor_video`, {
            method: "POST",
            body:   form,
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Server responded with ${response.status}`);

        const dataUrl = await readBlobAsDataUrl(await response.blob());
        if (controller.signal.aborted) return;
        gifOriginals.set(img, src);
        setSrc(img, dataUrl);
        reverseLoadBehavior(img);
    } catch (err) {
        if (err.name !== "AbortError") {
            console.warn("[ImageCensor] Failed to censor GIF:", src, err);
        }
    } finally {
        // A behavior change may have started a new request for this img.
        if (gifRequests.get(img)?.controller === controller) {
            gifRequests.delete(img);
            inFlight.delete(img);
        }
    }
}

/** A file name for the backend: the URL's basename, ending in .gif. */
function gifFilename(src) {
    let name = "";
    try { name = new URL(src).pathname.split("/").pop(); } catch { /* use default */ }
    name = decodeURIComponent(name).replace(/[^\w.-]/g, "_").replace(/^\.+/, "");
    if (!name) name = "image";
    return name.toLowerCase().endsWith(".gif") ? name : `${name}.gif`;
}

// ── Behavior changes ──────────────────────────────────────────────────────────

/** Undoes the load behavior and puts the original src back. */
function restoreImg(img, src) {
    reverseLoadBehavior(img);
    setSrc(img, src);
}

/**
 * Called when gifBehavior changes: undoes whatever was done to each GIF, then
 * handles every GIF on the page again with the new behavior.
 */
function applyGifSetting() {
    // Cancel censor requests in flight.
    for (const [img, { controller, src }] of gifRequests) {
        controller.abort();
        inFlight.delete(img);
        restoreImg(img, src);
    }
    gifRequests.clear();

    for (const img of document.querySelectorAll("img")) {
        if (!gifImgs.has(img)) continue;

        // Restore removed and censored GIFs.
        if (gifOriginals.has(img)) {
            setSrc(img, gifOriginals.get(img));
            gifOriginals.delete(img);
        }
        gifImgs.delete(img);
        processed.delete(img);
    }

    if (settings.extensionEnabled) {
        document.querySelectorAll("img").forEach(enqueueImage);
    }
}
