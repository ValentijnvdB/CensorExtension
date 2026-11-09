// ── Settings reader ───────────────────────────────────────────────────────────
// Builds the censor config sent with each request (see CensorTool's
// censor_config.md) from the saved settings and the backend's profile.
// Depends on: common/censor_schema.js, common/backend_api.js, common/model_config.js

/**
 * Returns the backend censor config, or null when the backend's profile is
 * unknown (never fetched and unreachable). With null, no config is sent and
 * the server uses its own censor_config.yml.
 */
async function readCensorSettings() {
  let settings = null;
  try {
    const result = await browser.storage.local.get({ appState: null });
    if (result.appState) settings = JSON.parse(result.appState);
  } catch { /* use the server's settings */ }

  if (settings && settings.version !== APP_STATE_VERSION) settings = null;

  const baseUrl = (settings?.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, "");
  const info    = await getBackendInfo(baseUrl);
  if (!info?.profile) return null;

  return buildCensorConfig(settings, info.profile, info.censorConfig);
}
