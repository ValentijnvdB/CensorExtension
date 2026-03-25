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

    // Handle GIF removal before the normal censoring pipeline.
    replaceGifIfNeeded(img);

    if (processed.has(img)) return;

    const displayedSrc = getDisplayedSrc(img);
    if (isOwnAsset(displayedSrc)) return;

    const absoluteSrc = toAbsolute(displayedSrc);
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

async function fetchImageAsBase64(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

    const blob     = await response.blob();
    const mimeType = blob.type || "image/jpeg";

    return new Promise((resolve, reject) => {
        const reader   = new FileReader();
        reader.onload  = () => resolve({ base64: reader.result.split(",")[1], mimeType });
        reader.onerror = () => reject(new Error("FileReader failed"));
        reader.readAsDataURL(blob);
    });
}

async function fetchCensored(img, originalSrc) {
    try {
        const { base64, mimeType } = await fetchImageAsBase64(originalSrc);

        const response = await fetch(ENDPOINTS.process, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                type: 'base64',
                image_data: base64,
                mime_type: mimeType,
                image_url: originalSrc,
                expected_response: 'base64',
                config: await getCensorSettings()
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
        inFlight.delete(img);
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
