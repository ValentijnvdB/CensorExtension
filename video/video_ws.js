/**
 * video_ws.js – Shared WebSocket connection for video censoring
 *
 * Manages a single WebSocket connection to wss://localhost:8443/censor_video
 * shared across all videos on the page. Routes incoming frames back to the
 * correct VideoRenderer by videoId.
 *
 * Packet format (13 bytes header, followed by optional payload):
 *   [0]    msgType   (uint8)  — 0 = frame, 1 = cancel
 *   [1–4]  videoId   (uint32, big-endian)
 *   [5–8]  seekId    (uint32, big-endian)
 *   [9–12] frameNum  (uint32, big-endian)  — unused / zero for cancel
 *   [13…]  frame image bytes               — only present for msgType 0
 *
 * Cancel message (msgType 1, 13 bytes, no payload):
 *   Sent immediately when a seek occurs. Tells the backend to discard all
 *   queued work for (videoId, seekId-1) — i.e. the seekId that was active
 *   before the seek incremented it. Any frames that arrive back for the old
 *   seekId are silently dropped by the renderer's seekId guard.
 *
 * The client-side send queue is also purged of stale frames for the old seekId
 *   on cancel, so frames that haven't left the browser yet never reach the wire.
 */

const VIDEO_WS_URL = "wss://localhost:8443/censor_video";

const MSG_TYPE_FRAME  = 0;
const MSG_TYPE_CANCEL = 1;

// Map<videoId, { onFrame, onOpen, onClose }> — registered renderers
const _videoWsHandlers = new Map();

let _ws = null;
let _wsReady = false;
let _wsReconnectTimer = null;

// Each entry is { videoId, seekId, buffer } so we can purge stale frames.
const _wsSendQueue = [];

function videoWsRegister(videoId, handlers) {
    // handlers: { onFrame(seekId, frameNum, bytes: ArrayBuffer), onOpen(), onClose() }
    _videoWsHandlers.set(videoId, handlers);
    _videoWsEnsureConnected();
}

function videoWsUnregister(videoId) {
    _videoWsHandlers.delete(videoId);
    // Purge any queued frames for this video.
    _wsPurgeQueue(videoId, null);
    // Let the connection idle — cheap to keep open.
}

/**
 * Send a frame to the server.
 * @param {number} videoId
 * @param {number} seekId
 * @param {number} frameNum
 * @param {ArrayBuffer} frameBytes  – raw image bytes (no header)
 */
function videoWsSend(videoId, seekId, frameNum, frameBytes) {
    const packet = _buildPacket(MSG_TYPE_FRAME, videoId, seekId, frameNum, frameBytes);

    if (_wsReady && _ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(packet);
    } else {
        _wsSendQueue.push({ videoId, seekId, buffer: packet });
        _videoWsEnsureConnected();
    }
}

/**
 * Send a cancel message to the server for the given (videoId, oldSeekId),
 * and purge any not-yet-sent frames for that pair from the local queue.
 *
 * Call this immediately after incrementing seekId on a seek event, passing
 * the *previous* seekId as oldSeekId.
 *
 * @param {number} videoId
 * @param {number} oldSeekId  – the seekId that is now stale
 */
function videoWsCancel(videoId, oldSeekId) {
    // Drop stale frames that are still sitting in the local queue.
    _wsPurgeQueue(videoId, oldSeekId);

    // Tell the backend to discard any in-flight work for the old seekId.
    const packet = _buildPacket(MSG_TYPE_CANCEL, videoId, oldSeekId, 0, null);
    if (_wsReady && _ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(packet);
    }
    // If not connected, no point queuing a cancel — the connection reset will
    // implicitly abandon all server-side state anyway.
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Build a packet ArrayBuffer.
 * @param {number} msgType
 * @param {number} videoId
 * @param {number} seekId
 * @param {number} frameNum
 * @param {ArrayBuffer|null} payload  – null for cancel messages
 */
function _buildPacket(msgType, videoId, seekId, frameNum, payload) {
    const payloadLen = payload ? payload.byteLength : 0;
    const buf  = new ArrayBuffer(13 + payloadLen);
    const view = new DataView(buf);
    view.setUint8 (0,  msgType);
    view.setUint32(1,  videoId,  false);
    view.setUint32(5,  seekId,   false);
    view.setUint32(9,  frameNum, false);
    if (payload) {
        new Uint8Array(buf).set(new Uint8Array(payload), 13);
    }
    return buf;
}

/**
 * Remove queued packets for a given videoId and (optionally) a specific seekId.
 * Pass seekId = null to purge all packets for the videoId (used on unregister).
 */
function _wsPurgeQueue(videoId, seekId) {
    for (let i = _wsSendQueue.length - 1; i >= 0; i--) {
        const entry = _wsSendQueue[i];
        if (entry.videoId === videoId && (seekId === null || entry.seekId === seekId)) {
            _wsSendQueue.splice(i, 1);
        }
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
            _ws.send(_wsSendQueue.shift().buffer);
        }

        // Notify all registered renderers
        for (const [, handlers] of _videoWsHandlers) {
            handlers.onOpen?.();
        }
    });

    _ws.addEventListener("message", (event) => {
        const buf = event.data;
        if (!(buf instanceof ArrayBuffer) || buf.byteLength < 13) {
            console.warn("[VideoCensor] Received malformed packet, ignoring");
            return;
        }

        const view = new DataView(buf);
        // msgType byte is echoed back but we don't need to act on it client-side.
        const videoId    = view.getUint32(1, false);
        const seekId     = view.getUint32(5, false);
        const frameNum   = view.getUint32(9, false);
        const frameBytes = buf.slice(13);

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
