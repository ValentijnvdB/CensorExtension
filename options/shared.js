// Depends on: common/censor_schema.js, common/backend_api.js, common/model_config.js

const CONNECTION_DEFAULTS = {
  baseUrl:      "https://localhost:8443",
  process:      "/censor_image",
  reset_cache:  "/reset_cache"
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const deepClone = obj => JSON.parse(JSON.stringify(obj));

// ── State ─────────────────────────────────────────────────────────────────────
// See common/model_config.js for the shape. `general` and `defaults` stay null
// until they are seeded from the server (or the documented defaults).
let state = {
  version:  APP_STATE_VERSION,
  ...CONNECTION_DEFAULTS,
  general:  null,
  defaults: null,
  models:   {},
};

// Last result of getBackendInfo(): { profile, censorConfig, offline, ... } | null
let backendInfo = null;

const serverCensorConfig = () => backendInfo?.censorConfig ?? null;
const profileLabels      = () => backendInfo?.profile?.labels ?? [];
const labelGroups        = () => groupLabelsByModel(backendInfo?.profile);

// ── Persistence ───────────────────────────────────────────────────────────────

// Features that use the default don't need their config persisted.
function serializeState() {
  const slimFeatures = features => Object.fromEntries(
      Object.entries(features ?? {}).map(([label, f]) => [
        label,
        f.useDefault
            ? { enabled: f.enabled, useDefault: true }
            : { enabled: f.enabled, useDefault: false, config: f.config },
      ])
  );
  return JSON.stringify({
    ...state,
    models: Object.fromEntries(
        Object.entries(state.models).map(([m, cfg]) => [m, { features: slimFeatures(cfg.features) }])
    ),
  });
}

async function saveState({ silent = false } = {}) {
  try {
    await browser.storage.local.set({ appState: serializeState() });
    if (!silent) showToast("Saved", "saved");
  } catch (error) {
    showToast("Failed to save: " + error, "err");
  }
}

async function loadState() {
  try {
    const result = await browser.storage.local.get({ appState: null });
    if (result.appState) {
      const saved = JSON.parse(result.appState);
      // Settings from older versions are not migrated.
      if (saved.version === APP_STATE_VERSION) state = { ...state, ...saved };
    }
  } catch { /* use defaults */ }

  state.models ??= {};
  for (const cfg of Object.values(state.models)) {
    cfg.features = Object.fromEntries(
        Object.entries(cfg.features ?? {}).map(([l, e]) => [l, normalizeFeatureEntry(e)])
    );
  }
}

// ── Backend sync ──────────────────────────────────────────────────────────────

/**
 * Fetches the profile and server censor config, and fills in everything that
 * has no saved settings yet (general, defaults, new models and labels) from
 * the server's censor config.
 */
async function syncWithBackend() {
  backendInfo = await getBackendInfo(state.baseUrl, 0);
  const cc = serverCensorConfig();
  let changed = false;

  if (!state.general)  { state.general  = resolveGeneral(null, cc);  changed = Boolean(cc); }
  if (!state.defaults) { state.defaults = resolveDefaults(null, cc); changed = changed || Boolean(cc); }

  for (const [model, labels] of Object.entries(labelGroups())) {
    const features = (state.models[model] ??= { features: {} }).features;
    for (const label of labels) {
      if (!features[label]) {
        features[label] = serverFeatureEntry(label, cc);
        changed = true;
      }
    }
  }

  if (changed) await saveState({ silent: true });
}

// ── Model operations ──────────────────────────────────────────────────────────

/** Replaces the settings of `model` with the server's censor config. */
function resetModelToServer(model) {
  const labels = labelGroups()[model] ?? [];
  state.models[model] = { features: serverModelFeatures(labels, serverCensorConfig()) };
}

/** Imports the label settings of `fromModel` into `toModel` (see importModelFeatures). */
function importIntoModel(fromModel, toModel) {
  const labels = labelGroups()[toModel] ?? [];
  state.models[toModel] = {
    features: importModelFeatures(state.models[fromModel]?.features, labels, serverCensorConfig()),
  };
}

function resetGeneralAndDefaultsToServer() {
  const cc = serverCensorConfig();
  state.general  = resolveGeneral(null, cc);
  state.defaults = resolveDefaults(null, cc);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 2400);
}

// ── Init ──────────────────────────────────────────────────────────────────────

function buildConfigTab() {
  buildProfileSection();
  buildGeneralSection();
  buildDefaultsSection();
  buildModelSections();
}

/** Re-fetches the backend info and rebuilds the config tab. */
async function refreshBackend() {
  setProfileStatus("testing", "loading profile…");
  await syncWithBackend();
  buildConfigTab();
}

// Wait for the other scripts of the page (connection.js, config.js, ...).
document.addEventListener("DOMContentLoaded", async () => {
  await loadState();
  initConnectionTab();
  await refreshBackend();
});
