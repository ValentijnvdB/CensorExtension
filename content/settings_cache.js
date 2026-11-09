// ── Cached settings ───────────────────────────────────────────────────────────
// Wraps readCensorSettings() with a cache that is invalidated automatically
// whenever the stored settings or the backend snapshot change. The pending
// promise is cached, so concurrent callers share one read (and one fetch).

let cachedSettings = null;
const settingsChangeListeners = [];

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.appState || changes[BACKEND_INFO_KEY])) {
    cachedSettings = null;
    for (const listener of settingsChangeListeners) listener();
  }
});

/** Calls `listener` after the stored settings (may) have changed. */
function onCensorSettingsChanged(listener) {
  settingsChangeListeners.push(listener);
}

/**
 * Returns the backend censor config (see readCensorSettings), or null to let
 * the server use its own config.
 *
 * @returns {Promise<object|null>}
 */
function getCensorSettings() {
  if (cachedSettings === null) {
    cachedSettings = readCensorSettings().catch(err => {
      cachedSettings = null;
      console.warn("[Censor] Could not read settings:", err);
      return null;
    });
  }
  return cachedSettings;
}
