// ── Cached settings ───────────────────────────────────────────────────────────
// Wraps readCensorSettings() with a cache that is invalidated automatically
// whenever the stored settings or the backend snapshot change. The pending
// promise is cached, so concurrent callers share one read (and one fetch).

// media ("image" | "video") → pending/resolved config
const cachedSettings = new Map();
const settingsChangeListeners = [];

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.appState || changes[BACKEND_INFO_KEY])) {
    cachedSettings.clear();
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
