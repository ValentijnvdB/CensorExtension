/**
 * pipeline.js – Image censoring pipeline
 *
 * Handles queuing, batching, fetching, and sending images to the censor
 * endpoint. Writes to processed / inFlight / pendingBatch in state.js.
 */

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
    applyLoadBehavior(img)

    pendingBatch.push({ img, originalSrc: absoluteSrc });

    if (!batchScheduled) {
        batchScheduled = true;
        Promise.resolve().then(flushBatch);
    }
}

function flushBatch() {
    const batch = pendingBatch.splice(0);
    batchScheduled = false;
    Promise.allSettled(batch.map(({ img, originalSrc }) => fetchCensored(img, originalSrc)));
}

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

async function fetchCensored(img, originalSrc) {
    let handedOff = false;
    try {
        const blob = await fetchBlob(originalSrc);

        // A GIF without a .gif URL: let gifs.js handle it.
        if (blob.type === "image/gif") {
            handedOff = true;
            inFlight.delete(img);
            handleDetectedGif(img, originalSrc, blob);
            return;
        }

        const mimeType = blob.type || "image/jpeg";
        const base64   = (await readBlobAsDataUrl(blob)).split(",")[1];
        const config   = await getCensorSettings("image");

        const response = await fetch(ENDPOINTS.process, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                type: 'base64',
                image_data: base64,
                mime_type: mimeType,
                image_url: originalSrc,
                expected_response: 'base64',
                // No config → the server uses its own censor_config.yml
                ...(config ? { config } : {}),
            }),
        });

        if (!response.ok) throw new Error(`Server responded with ${response.status}`);

        // Check if the server is responding with a stream or a regular JSON response
        const contentType = response.headers.get("Content-Type") || "";
        if (contentType.includes("text/event-stream")) {

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // SSE messages are separated by double newlines
                const parts = buffer.split("\n\n");
                buffer = parts.pop(); // keep incomplete trailing chunk

                for (const part of parts) {
                    // Extract the data line from the SSE message
                    const dataLine = part.split("\n").find(l => l.startsWith("image_data:"));
                    if (!dataLine) continue;

                    const base64_str = dataLine.slice("image_data:".length).trim();
                    applyCensoredData(img, { image_data: base64_str }, mimeType);
                }
            }
        } else {
            const data = await response.json();
            applyCensoredData(img, data, mimeType);
        }

    } catch (err) {
        console.warn("[ImageCensor] Failed to process image:", originalSrc, err);
    } finally {
        // After a hand-off gifs.js owns the inFlight entry.
        if (!handedOff) inFlight.delete(img);
    }
}

// Extracted helper so both code paths can use it
function applyCensoredData(img, data, mimeType) {
    let censoredSrc;
    if (data.image_data?.startsWith("data:")) {
        censoredSrc = data.image_data;
    } else if (data.image_data) {
        censoredSrc = `data:${data.mime_type || mimeType};base64,${data.image_data}`;
    } else {
        throw new Error("Response did not contain image_data");
    }

    setSrc(img, censoredSrc);
    reverseLoadBehavior(img);
}
