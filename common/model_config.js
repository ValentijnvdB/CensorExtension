// ── Per-model censor settings ─────────────────────────────────────────────────
// Logic shared by the options page and the content scripts for the settings
// stored in `appState` (browser.storage.local):
//
// appState = {
//   version:  2,
//   baseUrl, process,
//   general:  flat general settings     (absent → taken from the server)
//   defaults: flat default censor box   (absent → taken from the server)
//   models: {
//     "<model name>": {
//       features: { "<label>": { enabled, useDefault, config? } }
//     }
//   }
// }
//
// Labels without a stored entry take the server's censor config (see
// serverFeatureEntry), so the server's censor_config.yml is the starting
// point for every new model and label.
//
// Depends on: censor_schema.js, backend_api.js (groupLabelsByModel)

const APP_STATE_VERSION = 2;

/**
 * The entry for `label` according to the server's censor config:
 * enabled when it is in features_to_censor; with an override when it has
 * one in feature_overrides. Without a server config: enabled, use default.
 */
function serverFeatureEntry(label, censorConfig) {
  if (!censorConfig) return { enabled: true, useDefault: true };

  const toCensor = Array.isArray(censorConfig.features_to_censor) ? censorConfig.features_to_censor : [];
  const enabled  = toCensor.includes(label);
  const override = censorConfig.feature_overrides?.[label];

  if (override && typeof override === "object") {
    return {
      enabled,
      useDefault: false,
      config: fromBackendBox(mergeBox(censorConfig.default_censor_config, override)),
    };
  }
  return { enabled, useDefault: true };
}

/** Server entries for all `labels` of one model: { label: entry } */
function serverModelFeatures(labels, censorConfig) {
  return Object.fromEntries(labels.map(l => [l, serverFeatureEntry(l, censorConfig)]));
}

/** Fills in missing keys of a stored entry. */
function normalizeFeatureEntry(entry) {
  const out = {
    enabled:    entry.enabled    ?? true,
    useDefault: entry.useDefault ?? true,
  };
  if (!out.useDefault) out.config = { ...cloneJson(BOX_DEFAULTS), ...(entry.config ?? {}) };
  return out;
}

/** The effective entry for `label` of `model`: stored, else from the server. */
function resolveFeature(settings, model, label, censorConfig) {
  const stored = settings?.models?.[model]?.features?.[label];
  return stored ? normalizeFeatureEntry(stored) : serverFeatureEntry(label, censorConfig);
}

/**
 * Imports the label settings of another model into a model with `labels`.
 * Labels the source has are copied; labels it lacks get the server's settings;
 * source labels that `labels` does not contain are dropped.
 */
function importModelFeatures(sourceFeatures, labels, censorConfig) {
  return Object.fromEntries(labels.map(label => {
    const src = sourceFeatures?.[label];
    return [label, src ? normalizeFeatureEntry(cloneJson(src)) : serverFeatureEntry(label, censorConfig)];
  }));
}

/** Effective flat general settings. */
function resolveGeneral(settings, censorConfig) {
  return settings?.general
      ? normalizeGeneral(settings.general)
      : fromBackendGeneral(censorConfig);
}

/** Effective flat default censor box. */
function resolveDefaults(settings, censorConfig) {
  return settings?.defaults
      ? { ...cloneJson(BOX_DEFAULTS), ...settings.defaults }
      : fromBackendBox(censorConfig?.default_censor_config);
}

/**
 * Builds the backend censor config for the labels in `profile`, for `media`
 * ("image" | "video"). clip_to labels the profile cannot detect are dropped.
 */
function buildCensorConfig(settings, profile, censorConfig, media = "image") {
  const known = new Set(profile?.labels ?? []);
  const backendBox = flat => {
    const box = toBackendBox(flat);
    box.clip_to = box.clip_to.filter(l => known.has(l));
    return box;
  };

  const features_to_censor = [];
  const feature_overrides  = {};

  for (const [model, labels] of Object.entries(groupLabelsByModel(profile))) {
    for (const label of labels) {
      const entry = resolveFeature(settings, model, label, censorConfig);
      if (entry.enabled) features_to_censor.push(label);
      if (!entry.useDefault) feature_overrides[label] = backendBox(entry.config);
    }
  }

  return {
    ...toBackendGeneral(resolveGeneral(settings, censorConfig), media),
    features_to_censor,
    default_censor_config: backendBox(resolveDefaults(settings, censorConfig)),
    feature_overrides,
  };
}
