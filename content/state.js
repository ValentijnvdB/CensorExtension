/**
 * state.js – Shared constants and mutable state
 *
 * Loaded first so every subsequent content-script file can read and write
 * these globals directly (same JS scope, no ES-module imports needed).
 */

const DEFAULTS = {
    baseUrl:     "https://localhost:8443",
    process: "/censor_image",
};

const SETTING_DEFAULTS = {
    extensionEnabled:      true,
    gifBehavior:           'remove',  // 'nothing' | 'remove' | 'censor'
    videoBehavior:         'remove',  // 'nothing' | 'remove' | 'censor'
    loadBehavior:          'blur',
    // Video config (previously hard-coded)
    videoPrebufferSeconds: 10,
    videoTargetFps:        10,
    videoMaxInFlight:      128,
    videoFrameFormat:      'webp',
    frameCompressionLevel: 0.5,
};

// ── Video censoring config ────────────────────────────────────────────────────
// These start at their defaults and are updated live from storage/popup messages.

/** Maximum number of frames sent to the WS server that have not yet been returned. */
let videoMaxInFlight = SETTING_DEFAULTS.videoMaxInFlight;

/** Image format for encoded frames: 'jpeg' | 'webp' */
let videoFrameFormat = SETTING_DEFAULTS.videoFrameFormat;

/** JPEG/WebP quality (0–1). Only used when videoFrameFormat is 'jpeg' or 'webp'. */
let frameCompressionLevel = SETTING_DEFAULTS.frameCompressionLevel;

/**
 * How many seconds of frames to buffer before starting playback.
 * The pipeline stays in BUFFERING state until this many seconds' worth of
 * frames are ready, then unpauses the output canvas and audio.
 */
let videoPrebufferSeconds = SETTING_DEFAULTS.videoPrebufferSeconds;

// Target frames per second to send to the backend to prevent buffer starvation.
let videoTargetFps = SETTING_DEFAULTS.videoTargetFps;

// Populated once storage + filters are both ready.
let ENDPOINTS = null;
let BASE_URL  = null;

// Quick settings — updated live via messages from the popup.
let settings = { ...SETTING_DEFAULTS };

// Compiled filter state — written by filters.js, read by pipeline.js.
let globalMatchers = [];
let domainMatchers = {};

// Images discovered before init is complete are queued here.
let preInitQueue = [];
let initReady    = false;

// Pipeline state — written/read by pipeline.js.
const processed = new WeakSet();
const inFlight  = new WeakSet();

let pendingBatch   = [];
let batchScheduled = false;
