// ── Cached settings ───────────────────────────────────────────────────────────
// Wraps readCensorSettings() with a cache that is invalidated automatically
// whenever the stored settings or the backend snapshot change. The pending
// promise is cached, so concurrent callers share one read (and one fetch).

// media ("image" | "video") → pending/resolved config
const cachedSettings = new Map();
const settingsChangeListeners = [];

// Set when the server rejected our config (invalid_config / config_not_allowed);
// requests then go without a config, so the server uses its own, until the
// settings change.
let configRejected = false;

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.appState || changes[BACKEND_INFO_KEY])) {
    cachedSettings.clear();
    configRejected = false;
    for (const listener of settingsChangeListeners) listener();
  }
});

/** Calls `listener` after the stored settings (may) have changed. */
function onCensorSettingsChanged(listener) {
  settingsChangeListeners.push(listener);
}

/**
 * Returns the backend censor config for `media` (see readCensorSettings), or
 * null to let the server use its own config.
 *
 * @param {"image"|"video"} media
 * @returns {Promise<object|null>}
 */
function getCensorSettings(media = "image") {
  if (!cachedSettings.has(media)) {
    const pending = readCensorSettings(media).catch(err => {
      if (cachedSettings.get(media) === pending) cachedSettings.delete(media);
      console.warn("[Censor] Could not read settings:", err);
      return null;
    });
    cachedSettings.set(media, pending);
  }
  return cachedSettings.get(media);
}

/**
 * The config to send with a request for `media`: the user's settings, or
 * null (server's own config) when the server rejected them.
 */
async function getRequestConfig(media = "image") {
  return configRejected ? null : getCensorSettings(media);
}

const CONFIG_ERROR_CODES = new Set(["invalid_config", "config_not_allowed"]);

/** True when `err` (an ApiError) means the server rejected the config. */
function isConfigError(err) {
  return CONFIG_ERROR_CODES.has(err?.code);
}

/**
 * Remembers that the server rejected the config, so the following requests
 * use the server's config, and stores the error for the popup and options page.
 */
function rejectConfig(err) {
  if (configRejected) return;
  configRejected = true;
  console.warn("[Censor] The server rejected the censor settings, using its own:", err.message);
  browser.storage.local.set({
    [CONFIG_ERROR_KEY]: { code: err.code, error: err.message, at: Date.now() },
  }).catch(() => {});
}
