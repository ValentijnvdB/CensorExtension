/**
 * video_ws.js – Shared WebSocket connection for video censoring
 *
 * Manages a single WebSocket connection to wss://localhost:8443/censor_videos
 * shared across all videos on the page. Routes incoming frames back to the
 * correct VideoRenderer by videoId.
 *
 * Header format (12 bytes, prepended to every frame, echoed back by server):
 *   [0–3]  videoId   (uint32, big-endian)
 *   [4–7]  seekId    (uint32, big-endian)
 *   [8–11] frameNum  (uint32, big-endian)
 */

const VIDEO_WS_URL = "wss://localhost:8443/censor_video";

// Map<videoId, { onFrame, onOpen, onClose }> — registered renderers
const _videoWsHandlers = new Map();

let _ws = null;
let _wsReady = false;
let _wsReconnectTimer = null;
const _wsSendQueue = []; // ArrayBuffer[] queued before connection is open

function videoWsRegister(videoId, handlers) {
    // handlers: { onFrame(seekId, frameNum, bytes: ArrayBuffer), onOpen(), onClose() }
    _videoWsHandlers.set(videoId, handlers);
    _videoWsEnsureConnected();
}

function videoWsUnregister(videoId) {
    _videoWsHandlers.delete(videoId);
    // If no more videos, let the connection idle (don't close — cheap to keep open)
}

/**
 * Send a frame to the server.
 * @param {number} videoId
 * @param {number} seekId
 * @param {number} frameNum
 * @param {ArrayBuffer} frameBytes  – raw image bytes (no header)
 */
function videoWsSend(videoId, seekId, frameNum, frameBytes) {
    console.log("Sending frame:", videoId, seekId, frameNum);
    const header = new ArrayBuffer(12);
    const view = new DataView(header);
    view.setUint32(0, videoId, false);
    view.setUint32(4, seekId,  false);
    view.setUint32(8, frameNum, false);

    // Concatenate header + frame bytes
    const packet = new Uint8Array(12 + frameBytes.byteLength);
    packet.set(new Uint8Array(header), 0);
    packet.set(new Uint8Array(frameBytes), 12);

    if (_wsReady && _ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(packet.buffer);
    } else {
        _wsSendQueue.push(packet.buffer);
        _videoWsEnsureConnected();
    }
}

function _videoWsEnsureConnected() {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

    clearTimeout(_wsReconnectTimer);
    _ws = new WebSocket(VIDEO_WS_URL);
    _ws.binaryType = "arraybuffer";

    _ws.addEventListener("open", () => {
        _wsReady = true;
        console.log("[VideoCensor] WebSocket connected");

        // Flush queued sends
        while (_wsSendQueue.length > 0) {
            _ws.send(_wsSendQueue.shift());
        }

        // Notify all registered renderers
        for (const [, handlers] of _videoWsHandlers) {
            handlers.onOpen?.();
        }
    });

    _ws.addEventListener("message", (event) => {
        const buf = event.data;
        if (!(buf instanceof ArrayBuffer) || buf.byteLength < 12) {
            console.warn("[VideoCensor] Received malformed packet, ignoring");
            return;
        }

        const view = new DataView(buf);
        const videoId  = view.getUint32(0, false);
        const seekId   = view.getUint32(4, false);
        const frameNum = view.getUint32(8, false);
        const frameBytes = buf.slice(12);

        const handlers = _videoWsHandlers.get(videoId);
        if (!handlers) return; // video was unregistered

        handlers.onFrame(seekId, frameNum, frameBytes);
    });

    _ws.addEventListener("close", () => {
        _wsReady = false;
        console.log("[VideoCensor] WebSocket closed, reconnecting in 2s…");
        for (const [, handlers] of _videoWsHandlers) {
            handlers.onClose?.();
        }
        _wsReconnectTimer = setTimeout(_videoWsEnsureConnected, 2000);
    });

    _ws.addEventListener("error", (err) => {
        console.warn("[VideoCensor] WebSocket error:", err);
        // 'close' will fire after 'error', which handles reconnect
    });
}
