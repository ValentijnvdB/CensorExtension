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
    removeGifs:   false,
    removeVideos: false,
    loadBehavior:  'blur',
};

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
