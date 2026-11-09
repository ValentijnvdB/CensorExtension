// ── Config I/O ────────────────────────────────────────────────────────────────
// Depends on: censor_schema.js (GENERAL_DEFAULTS, BOX_DEFAULTS)
//             model_config.js (APP_STATE_VERSION, normalizeFeatureEntry)
//             shared.js (state, serializeState, saveState, syncWithBackend, buildConfigTab, showToast)

// ── Export ────────────────────────────────────────────────────────────────────
// The export holds the settings as stored (flat format), so an import
// restores them exactly:
//   { version: 2, general, defaults, models: { model: { features } } }

function buildExportPayload() {
  const saved = JSON.parse(serializeState());
  return {
    version:  APP_STATE_VERSION,
    general:  saved.general,
    defaults: saved.defaults,
    models:   saved.models,
  };
}

function handleExport() {
  const json = JSON.stringify(buildExportPayload(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = "image-censor-config.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("Config exported", "saved");
}

// ── Import ────────────────────────────────────────────────────────────────────
// General and defaults are replaced; models are merged by name (models in the
// file replace the saved ones with the same name, others are kept). Labels
// are not filtered here: settings for labels the profile doesn't have are
// kept, but never sent to the server.

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

    if (typeof parsed !== "object" || parsed === null || parsed.version !== APP_STATE_VERSION) {
      showToast("Unrecognised config format", "err");
      return;
    }

    try {
      if (parsed.general  && typeof parsed.general  === "object") {
        state.general  = { ...deepClone(GENERAL_DEFAULTS), ...parsed.general };
      }
      if (parsed.defaults && typeof parsed.defaults === "object") {
        state.defaults = { ...deepClone(BOX_DEFAULTS), ...parsed.defaults };
      }
      for (const [model, cfg] of Object.entries(parsed.models ?? {})) {
        if (!cfg || typeof cfg.features !== "object") continue;
        state.models[model] = {
          features: Object.fromEntries(
              Object.entries(cfg.features).map(([l, entry]) => [l, normalizeFeatureEntry(entry ?? {})])
          ),
        };
      }

      // Fill in labels of the current profile that the file doesn't cover.
      await syncWithBackend();
      await saveState();
      buildConfigTab();
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
