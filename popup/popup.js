const SETTING_DEFAULTS = {
    extensionEnabled:      true,
    gifBehavior:           'remove',  // 'nothing' | 'remove' | 'censor'
    videoBehavior:         'remove',  // 'nothing' | 'remove' | 'censor'
    loadBehavior:          'blur',
    // Images tab
    batchImages:           true,
    serverFetch:           true,
    imageResponse:         'url',
    // Video tab
    videoDelaySeconds:     3,
    videoTargetFps:        10,
    videoMaxInFlight:      12,
    videoFrameFormat:      'jpeg',
    frameCompressionLevel: 0.8,
};

const $ = id => document.getElementById(id);

// ── Version ───────────────────────────────────────────────────────────────────
const manifest = browser.runtime.getManifest();
$("version").textContent = `v${manifest.version}`;

// ── Load & render saved state ─────────────────────────────────────────────────
browser.storage.sync.get(SETTING_DEFAULTS).then(settings => {
    applyToggleUI("extensionEnabled",       settings.extensionEnabled);
    applyToggleUI("batchImages",            settings.batchImages);
    applyToggleUI("serverFetch",            settings.serverFetch);
    applySelectUI("imageResponse",          settings.imageResponse);
    applySelectUI("gifBehavior",            settings.gifBehavior);
    applySelectUI("videoBehavior",          settings.videoBehavior);
    applySelectUI("loadBehavior",           settings.loadBehavior);
    applySelectUI("videoFrameFormat",       settings.videoFrameFormat);
    applyNumericUI("videoDelaySeconds", settings.videoDelaySeconds);
    applyNumericUI("videoTargetFps",        settings.videoTargetFps);
    applyNumericUI("videoMaxInFlight",      settings.videoMaxInFlight);
    applyNumericUI("frameCompressionLevel", settings.frameCompressionLevel);
});

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
        btn.classList.add("active");
        $(`tab-${btn.dataset.tab}`).classList.remove("hidden");
    });
});

// ── Toggle interactions ───────────────────────────────────────────────────────
$("toggle-extensionEnabled").addEventListener("click", async () => {
    const current  = await browser.storage.sync.get(SETTING_DEFAULTS);
    const newValue = !current.extensionEnabled;
    await browser.storage.sync.set({ extensionEnabled: newValue });
    applyToggleUI("extensionEnabled", newValue);
    broadcast("extensionEnabled", newValue);
});

for (const setting of ["batchImages", "serverFetch"]) {
    $(`toggle-${setting}`).addEventListener("click", async () => {
        const current  = await browser.storage.sync.get(SETTING_DEFAULTS);
        const newValue = !current[setting];
        await browser.storage.sync.set({ [setting]: newValue });
        applyToggleUI(setting, newValue);
        broadcast(setting, newValue);
    });
}

// ── Select interactions ───────────────────────────────────────────────────────
for (const setting of ["gifBehavior", "videoBehavior", "loadBehavior", "videoFrameFormat", "imageResponse"]) {
    $(`select-${setting}`).addEventListener("change", async () => {
        const newValue = $(`select-${setting}`).value;
        if (!newValue) return;
        await browser.storage.sync.set({ [setting]: newValue });
        broadcast(setting, newValue);
    });
}

// ── Numeric input interactions ────────────────────────────────────────────────
for (const setting of ["videoDelaySeconds", "videoTargetFps", "videoMaxInFlight", "frameCompressionLevel"]) {
    $(`input-${setting}`).addEventListener("change", async () => {
        const newValue = parseFloat($(`input-${setting}`).value);
        if (isNaN(newValue)) return;
        await browser.storage.sync.set({ [setting]: newValue });
        broadcast(setting, newValue);
    });
}

// ── Open full options page ────────────────────────────────────────────────────
$("openOptions").addEventListener("click", e => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
});

$("configErrorLink").addEventListener("click", e => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
});

// ── Server status ─────────────────────────────────────────────────────────────
// Depends on: common/backend_api.js (fetchHealth, CONFIG_ERROR_KEY)

const DEFAULT_BASE_URL = "https://localhost:8443";

async function readBaseUrl() {
    try {
        const { appState } = await browser.storage.local.get({ appState: null });
        const saved = appState ? JSON.parse(appState) : {};
        return (saved.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    } catch {
        return DEFAULT_BASE_URL;
    }
}

function setServerStatus(kind, text, title = "") {
    $("serverDot").className    = `dot ${kind}`;
    $("serverText").textContent = text;
    $("serverStatus").title     = title;
}

async function refreshServerStatus() {
    const baseUrl = await readBaseUrl();
    const { reachable, ok, health, error } = await fetchHealth(baseUrl, { signal: AbortSignal.timeout(4000) });

    if (ok) {
        const images  = health.pending_image_jobs ?? 0;
        const running = health.running_video_jobs ?? 0;
        const waiting = health.waiting_video_jobs ?? 0;
        const busy    = [
            images  && `${images} image${images === 1 ? "" : "s"}`,
            running && "video running",
            waiting && `${waiting} video${waiting === 1 ? "" : "s"} waiting`,
        ].filter(Boolean);
        setServerStatus("ok",
            `${health.profile ?? "server"} · ${busy.length ? busy.join(", ") : "idle"}`,
            `${baseUrl} — ${health.backend ?? "?"} backend`);
    } else if (reachable && health) {
        setServerStatus("fail", "pipeline not running", baseUrl);
    } else if (reachable) {
        setServerStatus("warn", error.status === 404 ? "server too old for /health" : error.message, baseUrl);
    } else {
        setServerStatus("fail", "server unreachable", `${baseUrl} — ${error.message}`);
    }
}

async function showConfigError() {
    const { [CONFIG_ERROR_KEY]: err } = await browser.storage.local.get({ [CONFIG_ERROR_KEY]: null });
    $("configError").classList.toggle("hidden", !err);
    if (err) $("configErrorText").textContent = err.error ?? err.code;
}

refreshServerStatus();
setInterval(refreshServerStatus, 5000);
showConfigError();
browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[CONFIG_ERROR_KEY]) showConfigError();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function applyToggleUI(id, value) {
    const btn = $(`toggle-${id}`);
    if (btn) btn.setAttribute("aria-checked", String(value));
}

function applySelectUI(id, value) {
    const el = $(`select-${id}`);
    if (el) el.value = value;
}

function applyNumericUI(id, value) {
    const el = $(`input-${id}`);
    if (el) el.value = value;
}

async function broadcast(setting, value) {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
        browser.tabs.sendMessage(tab.id, {
            type:    "SETTING_CHANGED",
            setting: setting,
            value:   value,
        }).catch(() => {});
    }
}
