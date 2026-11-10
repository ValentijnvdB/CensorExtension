// ── Backend API ───────────────────────────────────────────────────────────────
// Shared by the options page, the popup and the content scripts. Besides the
// endpoint helpers further down (errors, /health, /cache, /storage,
// /censor_config/validate) this file
// fetches GET /profile and GET /censor_config and keeps a snapshot in
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
  const data = await apiRequest(url);
  if (data.status !== "success") throw new ApiError("internal_error", data.error ?? "unexpected response");
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

// ── Errors ────────────────────────────────────────────────────────────────────
// The backend answers errors as {status: "error", code, error} (see
// http_api.md#errors). Network failures get the code "network".

class ApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name   = "ApiError";
    this.code   = code;
    this.status = status;
  }
}

/** Reads the error of a failed response as an ApiError (never throws). */
async function readApiError(res) {
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  return new ApiError(
      data?.code ?? (res.status === 404 ? "not_found" : "internal_error"),
      data?.error ?? `${res.status} ${res.statusText}`.trim(),
      res.status,
  );
}

/**
 * fetch() that resolves to the parsed JSON of a successful answer and throws
 * an ApiError otherwise (code "network" when the server can't be reached).
 */
async function apiRequest(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { cache: "no-store", ...options });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError("network", err.message || "server unreachable");
  }
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

/** POST JSON to `url` with apiRequest. */
function apiPostJson(url, body, options = {}) {
  return apiRequest(url, {
    ...options,
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

// ── Server status ─────────────────────────────────────────────────────────────

/**
 * GET /health → { reachable, ok, health, error }
 *   reachable: the server answered (also with 503)
 *   ok:        the pipeline runs and can censor
 *   health:    the /health answer, or null
 */
async function fetchHealth(baseUrl, options = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}/health`, { cache: "no-store", ...options });
  } catch (err) {
    return { reachable: false, ok: false, health: null, error: new ApiError("network", err.message) };
  }
  let health = null;
  try { health = await res.json(); } catch { /* not JSON */ }
  if (res.ok && health?.status === "ok") return { reachable: true, ok: true, health, error: null };
  return {
    reachable: true,
    ok:        false,
    health:    health?.pipeline_running !== undefined ? health : null,
    error:     new ApiError(health?.code ?? (res.status === 404 ? "not_found" : "unavailable"),
                            health?.error ?? `${res.status} ${res.statusText}`.trim(), res.status),
  };
}

/** GET /cache → { files, bytes } */
async function fetchCacheInfo(baseUrl) {
  const data = await apiRequest(`${baseUrl}/cache`);
  return { files: data.files ?? 0, bytes: data.bytes ?? 0 };
}

/** DELETE /cache → { deleted_files, deleted_bytes } */
function clearCache(baseUrl) {
  return apiRequest(`${baseUrl}/cache`, { method: "DELETE" });
}

/** GET /storage → { retention_hours, folders: {name: {files, bytes}}, files, bytes } */
function fetchStorageInfo(baseUrl) {
  return apiRequest(`${baseUrl}/storage`);
}

/** DELETE /storage → { deleted_files, deleted_bytes } */
function clearStorage(baseUrl) {
  return apiRequest(`${baseUrl}/storage`, { method: "DELETE" });
}

/** POST /censor_config/validate → { valid, errors: string[], warnings: string[] } */
async function validateCensorConfig(baseUrl, config, options = {}) {
  const data = await apiPostJson(`${baseUrl}/censor_config/validate`, { config }, options);
  return {
    valid:    data.valid === true,
    errors:   Array.isArray(data.errors)   ? data.errors   : [],
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  };
}

/** 1536 → "1.5 KB" */
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(bytes) || 0, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

// ── Config errors reported by the content scripts ─────────────────────────────
// When the server rejects the extension's censor config, the content scripts
// fall back to the server's config and store the error here, so the popup and
// the options page can show it. The options page clears it on every save.

const CONFIG_ERROR_KEY = "configError";   // { code, error, at }
