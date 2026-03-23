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
    extensionEnabled: true,
    removeGifs:    false,
    removeVideos:  false,
    censorVideos:  false,
    loadBehavior:  'blur',
};

// ── Video censoring config ────────────────────────────────────────────────────
// These are hard-coded defaults; future work could expose them in the options UI.

/** Maximum number of frames sent to the WS server that have not yet been returned. */
const VIDEO_MAX_IN_FLIGHT = 20;

/** Image format for encoded frames: 'jpeg' | 'png' | 'webp' */
let videoFrameFormat = 'webp';

/** JPEG/WebP quality (0–1). Only used when videoFrameFormat is 'jpeg' or 'webp'. */
let frameCompressionLevel = 0.5;

/**
 * How many seconds of frames to buffer before starting playback.
 * The pipeline stays in BUFFERING state until this many seconds' worth of
 * frames are ready, then unpauses the output canvas and audio.
 */
let videoPrebufferSeconds = 3;

// Target frames per second to send to the backend to prevent buffer starvation.
const VIDEO_FPS_TARGET = 15;

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
