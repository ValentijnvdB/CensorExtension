// ── Config I/O ────────────────────────────────────────────────────────────────
// Depends on: censor_schema.js (FEATURES, toBackendBox, fromBackendBox, ...)
//             shared.js (state, deepClone, saveState, showToast)
//             config.js  (buildGeneralSection, buildDefaultsSection, buildFeatureList)

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Builds the export object, with censor boxes in the backend format.
 */
function buildExportPayload() {
  const payload = {
    general:  toBackendGeneral(state.general),
    defaults: toBackendBox(state.defaults),
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
      payload.features[featureId].config = toBackendBox(f.config);
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
        state.general = fromBackendGeneral(parsed.general);
      }

      // Import defaults
      state.defaults = fromBackendBox(parsed.defaults);

      // Import feature states
      if (parsed.features && typeof parsed.features === "object") {
        for (const featureId of FEATURES) {
          const src = parsed.features[featureId];
          if (!src) continue;

          state.features[featureId] = {
            enabled:    src.enabled    ?? true,
            useDefault: src.useDefault ?? true,
            config:     src.useDefault === false && src.config
              ? fromBackendBox(src.config)
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
