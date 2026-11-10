/**
 * pipeline.js – Image censoring pipeline
 *
 * Queues images, batches them and sends them to the backend (see the
 * backend's http_api.md). Writes to processed / inFlight in state.js.
 *
 * Per image:
 *   1. With settings.serverFetch and an http(s) URL the server downloads the
 *      image itself (type "source"). Otherwise, or when the server can't get
 *      it (download_failed, url_not_allowed, invalid_image), the browser
 *      downloads it and sends it base64 encoded.
 *   2. Images are sent in batches to POST /censor_images (settings.batchImages),
 *      the first image of a page on its own so it shows quickly. A batch is
 *      flushed after BATCH_DELAY_MS, or when it is full.
 *   3. The answer is a URL on the server (settings.imageResponse "url") or the
 *      image itself (base64). A URL that fails to load is requested again as
 *      base64.
 *
 * Errors (by code): config errors → the server's own config is used from then
 * on (see settings_cache.js); a busy or unreachable server → retried with
 * backoff; a GIF → handed to gifs.js; censoring failed → failed screen. In
 * every other case the load behavior stays, so nothing uncensored is shown.
 */

const BATCH_MAX_IMAGES = 10;                 // the server accepts up to 50
const BATCH_MAX_BYTES  = 40 * 1024 * 1024;   // base64 per request; the server accepts up to 100 MB
const BATCH_DELAY_MS   = 50;
const MAX_ATTEMPTS     = 4;                  // the first try and 3 retries
const RETRY_BASE_MS    = 1000;               // 1 s, 2 s, 4 s

// The server is unreachable, not running or busy: try again later.
const RETRY_CODES    = new Set(["network", "unavailable", "queue_full"]);
// The server could not get or read the image itself: the browser downloads it.
const FALLBACK_CODES = new Set(["download_failed", "url_not_allowed", "invalid_image"]);
// Censoring failed: show the failed screen.
const FAILED_CODES   = new Set(["processing_failed", "internal_error"]);

/**
 * A queued image:
 *   { img, src, attempt,
 *     base64?, mimeType?,          // set once the browser downloaded it
 *     base64Response? }            // the URL answer failed to load
 */
let pendingBatch   = [];
let pendingBytes   = 0;
let batchTimer     = null;
let firstImageSent = false;

function enqueueImage(img) {
    if (!initReady) {
        if (!processed.has(img)) preInitQueue.push(img);
        return;
    }

    if (processed.has(img)) return;

    const displayedSrc = getDisplayedSrc(img);
    if (isOwnAsset(displayedSrc)) return;

    const absoluteSrc = toAbsolute(displayedSrc);

    // GIFs are handled by gifs.js (removed, left alone or sent to /censor_video).
    if (isGif(absoluteSrc)) {
        handleGif(img, absoluteSrc);
        return;
    }

    if (isFiltered(absoluteSrc)) return;

    processed.add(img);
    inFlight.add(img);

    // apply placeholder image
    applyLoadBehavior(img);

    const item = { img, src: absoluteSrc, attempt: 0 };
    if (settings.serverFetch && isHttpUrl(absoluteSrc)) {
        queueItem(item);
    } else {
        downloadInBrowser(item);
    }
}

function isHttpUrl(url) {
    try {
        const { protocol } = new URL(url);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

// ── Downloading in the browser ────────────────────────────────────────────────

async function fetchBlob(url, signal) {
    const response = await fetch(url, { credentials: "include", signal });
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    return response.blob();
}

function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader   = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("FileReader failed"));
        reader.readAsDataURL(blob);
    });
}

/** Downloads the image with the page's cookies and queues it as base64. */
async function downloadInBrowser(item) {
    try {
        const blob = await fetchBlob(item.src);

        // A GIF without a .gif URL: let gifs.js handle it.
        if (blob.type === "image/gif") {
            handOffGif(item, blob);
            return;
        }

        item.mimeType = blob.type || "image/jpeg";
        item.base64   = (await readBlobAsDataUrl(blob)).split(",")[1];
        queueItem(item);
    } catch (err) {
        giveUp(item, err);
    }
}

// ── Batching ──────────────────────────────────────────────────────────────────

function queueItem(item) {
    const size = item.base64?.length ?? 0;
    if (pendingBatch.length && pendingBytes + size > BATCH_MAX_BYTES) flushBatch();

    pendingBatch.push(item);
    pendingBytes += size;

    if (!settings.batchImages || !firstImageSent || pendingBatch.length >= BATCH_MAX_IMAGES) {
        firstImageSent = true;
        flushBatch();
    } else if (!batchTimer) {
        batchTimer = setTimeout(flushBatch, BATCH_DELAY_MS);
    }
}

function flushBatch() {
    clearTimeout(batchTimer);
    batchTimer = null;
    const batch = pendingBatch.splice(0);
    pendingBytes = 0;
    if (batch.length) sendBatch(batch);
}

// ── Requests ──────────────────────────────────────────────────────────────────

/** One image of a request (see http_api.md#image-requests). */
function imageRequest(item) {
    const image = item.base64
        ? { type: "base64", image_data: item.base64, mime_type: item.mimeType, image_url: item.src }
        : { type: "source", image_url: item.src };
    const base64 = item.base64Response || settings.imageResponse === "base64";
    return { ...image, expected_response: base64 ? "base64" : "url" };
}

/**
 * Sends `items` to /censor_image (one) or /censor_images (several).
 * Returns one { data } or { error: ApiError } per item.
 */
async function requestCensor(items, config) {
    const withConfig = config ? { config } : {};   // no config → the server's censor_config.yml

    if (items.length === 1) {
        try {
            return [{ data: await apiPostJson(`${BASE_URL}/censor_image`, { ...imageRequest(items[0]), ...withConfig }) }];
        } catch (error) {
            return [{ error }];
        }
    }

    let answer;
    try {
        answer = await apiPostJson(`${BASE_URL}/censor_images`, { images: items.map(imageRequest), ...withConfig });
    } catch (error) {
        return items.map(() => ({ error }));   // the request failed as a whole
    }
    const results = Array.isArray(answer.results) ? answer.results : [];
    return items.map((_, i) => {
        const r = results[i];
        if (r?.status === "success") return { data: r };
        return { error: new ApiError(r?.code ?? "internal_error", r?.error ?? "no result for this image") };
    });
}

async function sendBatch(items) {
    const config  = await getRequestConfig("image");
    const results = await requestCensor(items, config);
    items.forEach((item, i) => handleResult(item, results[i], Boolean(config)));
}

function handleResult(item, { data, error }, sentConfig) {
    if (!error) {
        try {
            showCensored(item, data);
        } catch (err) {
            giveUp(item, err);
        }
        return;
    }

    if (error.code === "use_censor_video") {
        handOffGif(item, null);
    } else if (sentConfig && isConfigError(error)) {
        rejectConfig(error);
        queueItem(item);                       // again, with the server's config
    } else if (!item.base64 && FALLBACK_CODES.has(error.code)) {
        downloadInBrowser(item);
    } else if (RETRY_CODES.has(error.code) && ++item.attempt < MAX_ATTEMPTS) {
        setTimeout(() => queueItem(item), RETRY_BASE_MS * 2 ** (item.attempt - 1));
    } else {
        if (FAILED_CODES.has(error.code)) showFailed(item.img);
        giveUp(item, error);
    }
}

// ── Results ───────────────────────────────────────────────────────────────────

function showCensored(item, data) {
    const { img } = item;
    if (data.url) {
        showCensoredUrl(item, data.url.startsWith("/") ? `${BASE_URL}${data.url}` : data.url);
    } else if (data.image_data) {
        const src = data.image_data.startsWith("data:")
            ? data.image_data
            : `data:${data.mime_type || item.mimeType || "image/jpeg"};base64,${data.image_data}`;
        setSrc(img, src);
        reverseLoadBehavior(img);
        inFlight.delete(img);
    } else {
        throw new Error("The response has neither a url nor image_data");
    }
}

/**
 * Shows the censored image at `url`. The load behavior stays until it has
 * loaded, so the original never shows unblurred in between. If it doesn't
 * load (e.g. the server's files were cleared) it is requested again as base64.
 */
function showCensoredUrl(item, url) {
    const { img } = item;
    const onLoad = () => {
        img.removeEventListener("error", onError);
        reverseLoadBehavior(img);
        inFlight.delete(img);
    };
    const onError = () => {
        img.removeEventListener("load", onLoad);
        if (!item.base64Response) {
            item.base64Response = true;
            queueItem(item);
        } else {
            showFailed(img);
            giveUp(item, new Error(`Could not load ${url}`));
        }
    };
    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });
    setSrc(img, url);
}

function showFailed(img) {
    setSrc(img, browser.runtime.getURL("assets/failed_screen.png"));
    reverseLoadBehavior(img);
}

/** Hands the image to gifs.js, which then owns its inFlight entry. */
function handOffGif(item, blob) {
    inFlight.delete(item.img);
    handleDetectedGif(item.img, item.src, blob);
}

/** Stops trying. Unless something was shown, the load behavior stays. */
function giveUp(item, err) {
    console.warn("[ImageCensor] Failed to process image:", item.src, err);
    inFlight.delete(item.img);
}
