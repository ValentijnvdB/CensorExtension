// FEATURES, GENERAL_DEFAULTS and BOX_DEFAULTS come from common/censor_schema.js

const CONNECTION_DEFAULTS = {
  baseUrl:      "https://localhost:8443",
  process:      "/censor_image",
  reset_cache:  "/reset_cache"
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const deepClone = obj => JSON.parse(JSON.stringify(obj));

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  ...CONNECTION_DEFAULTS,
  general:  deepClone(GENERAL_DEFAULTS),
  defaults: deepClone(BOX_DEFAULTS),
  features: {},
};

// ── Persistence ───────────────────────────────────────────────────────────────

// Before saving, strip the `config` field from any feature that uses the
// default — there's no point persisting a redundant copy of BOX_DEFAULTS
// for every feature
function serializeState() {
  const slim = {
    ...state,
    features: Object.fromEntries(
        Object.entries(state.features).map(([id, f]) => [
          id,
          f.useDefault
              ? { enabled: f.enabled, useDefault: true }   // drop config entirely
              : { enabled: f.enabled, useDefault: false, config: f.config },
        ])
    ),
  };
  return JSON.stringify(slim);
}

async function saveState() {
  try {
    await browser.storage.local.set({ appState: serializeState() });
    showToast("Saved", "saved");
  } catch (error) {
    showToast("Failed to save: " + error, "err");
  }
}

async function loadState() {
  try {
    const result = await browser.storage.local.get({ appState: null });
    if (result.appState) {
      const saved = JSON.parse(result.appState);
      state = { ...state, ...saved };
    }
  } catch { /* use defaults */ }

  // Ensure general settings are fully populated
  state.general  = { ...GENERAL_DEFAULTS, ...(state.general ?? {}) };
  state.defaults = { ...deepClone(BOX_DEFAULTS), ...(state.defaults ?? {}) };

  // Ensure every known feature has a fully-populated entry in memory,
  // restoring the config field for useDefault features if it was stripped.
  for (const f of FEATURES) {
    if (!state.features[f]) {
      state.features[f] = {
        enabled:    true,
        useDefault: true,
        config:     deepClone(BOX_DEFAULTS),
      };
    } else if (state.features[f].useDefault && !state.features[f].config) {
      // Re-hydrate stripped config so the rest of the UI works normally.
      state.features[f].config = deepClone(BOX_DEFAULTS);
    } else {
      state.features[f].config = { ...deepClone(BOX_DEFAULTS), ...state.features[f].config };
    }
  }
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
loadState().then(() => {
  initConnectionTab();
  buildGeneralSection();
  buildDefaultsSection();
  buildFeatureList();
});