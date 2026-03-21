// ── Config I/O ────────────────────────────────────────────────────────────────
// Depends on: shared.js (state, FEATURES, CONFIG_DEFAULTS, deepClone, saveState, showToast)
//             config.js  (buildDefaultsSection, buildFeatureList)
//             settings_reader.js (reshapeConfig, READER_CONFIG_DEFAULTS)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a [B, G, R] array back to a "#rrggbb" hex string.
 * Accepts both BGR arrays (from reshapeConfig) and plain hex strings (passthrough).
 */
function bgrToHex(bgr) {
  if (typeof bgr === "string") return bgr;
  const [b, g, r] = bgr;
  return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Joins an array back to a comma-separated string.
 * Accepts both arrays and plain strings (passthrough).
 */
function joinList(arr) {
  if (typeof arr === "string") return arr;
  return (arr ?? []).join(", ");
}

/**
 * Flattens the shaped config object (output of reshapeConfig) back into
 * the flat format used internally by the options page state.
 */
function flattenConfig(shaped) {
  const D = CONFIG_DEFAULTS;
  const flat = { ...D };

  // censor_style
  if (shaped.censor_style) {
    flat.censor_style = shaped.censor_style.type ?? D.censor_style;
    if (shaped.censor_style.strength !== undefined)
      flat.blur_strength = shaped.censor_style.strength;
    if (shaped.censor_style.factor !== undefined)
      flat.pixel_factor = shaped.censor_style.factor;
    if (shaped.censor_style.color !== undefined)
      flat.bar_color = bgrToHex(shaped.censor_style.color);
  }

  // border
  if (shaped.border) {
    flat.border = true;
    if (shaped.border.thickness !== undefined)
      flat.border_thickness = shaped.border.thickness;
    if (shaped.border.color !== undefined)
      flat.border_color = bgrToHex(shaped.border.color);
  } else if (shaped.border === null) {
    flat.border = false;
  }

  // overlay
  if (shaped.overlay === null) {
    flat.overlay_type = "off";
  } else if (shaped.overlay) {
    flat.overlay_type = shaped.overlay.type ?? D.overlay_type;
    if (shaped.overlay.probability !== undefined)
      flat.overlay_prob = shaped.overlay.probability;
    if (shaped.overlay.values !== undefined)
      flat.overlay_values = joinList(shaped.overlay.values);
    if (shaped.overlay.color !== undefined)
      flat.overlay_color = bgrToHex(shaped.overlay.color);
    if (shaped.overlay.font_scale !== undefined)
      flat.overlay_font_scale = shaped.overlay.font_scale;
    if (shaped.overlay.categories !== undefined)
      flat.overlay_categories = joinList(shaped.overlay.categories);
  }

  // scalar fields
  const scalars = [
    "inverse", "intersect_human", "shape",
    "min_prob", "width_area_safety", "height_area_safety",
  ];
  for (const key of scalars) {
    if (shaped[key] !== undefined) flat[key] = shaped[key];
  }

  return flat;
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Builds the full shaped export object using reshapeConfig (from settings_reader.js).
 */
function buildExportPayload() {
  const payload = {
    general:  state.general,
    defaults: reshapeConfig(state.defaults),
    features: {},
  };

  for (const featureId of FEATURES) {
    const f = state.features[featureId];
    if (!f) continue;
    payload.features[featureId] = {
      enabled:    f.enabled,
      useDefault: f.useDefault,
    };
    if (!f.useDefault && f.config) {
      payload.features[featureId].config = reshapeConfig(f.config);
    }
  }

  return payload;
}

function handleExport() {
  const payload = buildExportPayload();
  const json    = JSON.stringify(payload, null, 2);
  const blob    = new Blob([json], { type: "application/json" });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement("a");
  a.href        = url;
  a.download    = "image-censor-config.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Config exported", "saved");
}

// ── Import ────────────────────────────────────────────────────────────────────

function handleImport(file) {
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async e => {
    let parsed;
    try {
      parsed = JSON.parse(e.target.result);
    } catch {
      showToast("Invalid JSON file", "err");
      return;
    }

    // Validate top-level shape
    if (typeof parsed !== "object" || !parsed.defaults) {
      showToast("Unrecognised config format", "err");
      return;
    }

    try {
      // Import general settings
      if (parsed.general && typeof parsed.general === "object") {
        state.general = { ...GENERAL_DEFAULTS, ...parsed.general };
      }

      // Import defaults
      state.defaults = flattenConfig(parsed.defaults);

      // Import feature states
      if (parsed.features && typeof parsed.features === "object") {
        for (const featureId of FEATURES) {
          const src = parsed.features[featureId];
          if (!src) continue;

          state.features[featureId] = {
            enabled:    src.enabled    ?? true,
            useDefault: src.useDefault ?? true,
            config:     src.useDefault === false && src.config
              ? flattenConfig(src.config)
              : deepClone(state.defaults),
          };
        }
      }

      await saveState();

      // Rebuild UI to reflect imported values
      buildGeneralSection();
      buildDefaultsSection();
      buildFeatureList();

      showToast("Config imported", "saved");
    } catch (err) {
      showToast("Import failed: " + err.message, "err");
    }
  };

  reader.onerror = () => showToast("Could not read file", "err");
  reader.readAsText(file);
}

// ── Wire up buttons ───────────────────────────────────────────────────────────

$("btnExport").addEventListener("click", handleExport);

$("btnImport").addEventListener("click", () => {
  const importBtn = $("importFile")
  importBtn.value = "";   // reset so same file can be re-imported
  importBtn.click();
});

$("importFile").addEventListener("change", e => {
  handleImport(e.target.files[0] ?? null);
});
