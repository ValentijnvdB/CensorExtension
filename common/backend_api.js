// ── Backend info (profile + server censor config) ─────────────────────────────
// Fetches GET /profile and GET /censor_config and keeps a snapshot in
// browser.storage.local under `backendInfo`, so the content scripts and the
// options page share it and it is available while the backend is offline.
//
// backendInfo = {
//   baseUrl:      string,                  // server the snapshot came from
//   fetchedAt:    number,                  // ms timestamp
//   profile:      { name, labels, models } | null,
//   censorConfig: object | null,           // raw censor_config.yml as JSON
// }

const BACKEND_INFO_KEY     = "backendInfo";
const BACKEND_INFO_MAX_AGE = 5 * 60 * 1000;   // content scripts refresh after 5 min

async function fetchJson(url) {
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.status !== "success") throw new Error(data.error ?? "unexpected response");
  return data;
}

/** GET /profile → { name, labels, models } */
async function fetchProfile(baseUrl) {
  const data = await fetchJson(`${baseUrl}/profile`);
  return {
    name:   data.profile,
    labels: Array.isArray(data.labels) ? data.labels : [],
    models: data.models && typeof data.models === "object" ? data.models : {},
  };
}

/** GET /censor_config → the config object */
async function fetchServerCensorConfig(baseUrl) {
  const data = await fetchJson(`${baseUrl}/censor_config`);
  return data.config ?? null;
}

async function readStoredBackendInfo() {
  try {
    const result = await browser.storage.local.get({ [BACKEND_INFO_KEY]: null });
    return result[BACKEND_INFO_KEY];
  } catch {
    return null;
  }
}

/**
 * Returns the backend info for `baseUrl`, fetching it when the stored
 * snapshot is older than `maxAge` ms (0 = always fetch) or belongs to another
 * server. When fetching fails the stored snapshot is returned with
 * `offline: true`, or null when there is none.
 *
 * The censor config is optional: older backends without /censor_config still
 * return a profile.
 */
async function getBackendInfo(baseUrl, maxAge = BACKEND_INFO_MAX_AGE) {
  const stored = await readStoredBackendInfo();
  const sameServer = stored?.baseUrl === baseUrl;

  if (sameServer && stored.profile && Date.now() - stored.fetchedAt < maxAge) {
    return { ...stored, offline: false };
  }

  try {
    const [profile, censorConfig] = await Promise.all([
      fetchProfile(baseUrl),
      fetchServerCensorConfig(baseUrl).catch(() => null),
    ]);
    const info = { baseUrl, fetchedAt: Date.now(), profile, censorConfig };
    await browser.storage.local.set({ [BACKEND_INFO_KEY]: info });
    return { ...info, offline: false };
  } catch (err) {
    if (sameServer && stored.profile) return { ...stored, offline: true, error: err.message };
    return null;
  }
}

/**
 * Groups the profile's labels by the model that produces them:
 * { modelName: [label, ...] }, models and labels sorted alphabetically.
 */
function groupLabelsByModel(profile) {
  const groups = {};
  for (const label of profile?.labels ?? []) {
    const model = profile.models?.[label] ?? "unknown";
    (groups[model] ??= []).push(label);
  }
  return Object.fromEntries(
      Object.keys(groups).sort().map(m => [m, groups[m].sort()])
  );
}

/**
 * GET /stickers[?dir=<stickersDir>] → {
 *   stickersDir: string,
 *   categories:  string[],                       // folders, relative to stickersDir
 *   stickers:    [{ path, url }],                // path relative to stickersDir,
 * }                                              // url absolute
 */
async function fetchStickers(baseUrl, stickersDir) {
  const query = stickersDir ? `?dir=${encodeURIComponent(stickersDir)}` : "";
  const data  = await fetchJson(`${baseUrl}/stickers${query}`);
  return {
    stickersDir: data.stickers_dir ?? stickersDir ?? "",
    categories:  Array.isArray(data.categories) ? data.categories : [],
    stickers:    (Array.isArray(data.stickers) ? data.stickers : [])
        .filter(s => s && typeof s.path === "string")
        .map(s => ({ path: s.path, url: `${baseUrl}${s.url ?? `/stickers/${s.path}`}` })),
  };
}
