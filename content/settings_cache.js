// ── Cached settings ───────────────────────────────────────────────────────────
// Wraps readCensorSettings() with a cache that is invalidated automatically
// whenever the stored settings change. The object is only reconstructed once
// per save, no matter how many times getCensorSettings() is called.

let cachedSettings = null;

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.appState) {
    cachedSettings = null;
  }
});

/**
 * Returns the censor settings object, rebuilding it only if the cache has
 * been invalidated since the last call.
 *
 * @returns {Promise<{
 *   features_to_censor: string[],
 *   default_censor_config: object,
 *   feature_overrides: object
 * }>}
 */
async function getCensorSettings() {
  if (cachedSettings === null) {
    cachedSettings = await readCensorSettings();
  }
  return cachedSettings;
}
