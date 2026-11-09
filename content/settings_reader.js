// ── Settings reader ───────────────────────────────────────────────────────────
// Reads the config from browser.storage.local and returns it in the format the
// backend expects as `config` (see CensorTool's censor_config.md).
// Depends on: common/censor_schema.js

/**
 * Reads saved settings from storage and returns them as a backend censor config:
 * {
 *   inverse_censor_style, force_inverse_censor, merge_overlapping_borders,
 *   enable_overlays, enable_watermark, stickers_dir?,
 *   features_to_censor:    string[],
 *   default_censor_config: object,
 *   feature_overrides:     { [label]: object }
 * }
 */
async function readCensorSettings() {
  let raw = null;

  try {
    const result = await browser.storage.local.get({ appState: null });
    if (result.appState) {
      raw = JSON.parse(result.appState);
    }
  } catch { /* fall through to defaults */ }

  const features_to_censor = [];
  const feature_overrides  = {};

  for (const label of FEATURES) {
    const fState = raw?.features?.[label];

    if (fState?.enabled ?? true) {
      features_to_censor.push(label);
    }
    if (fState?.useDefault === false && fState.config) {
      feature_overrides[label] = toBackendBox(fState.config);
    }
  }

  return {
    ...toBackendGeneral(raw?.general ?? {}),
    features_to_censor,
    default_censor_config: toBackendBox(raw?.defaults ?? {}),
    feature_overrides,
  };
}
