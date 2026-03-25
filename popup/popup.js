const SETTING_DEFAULTS = {
    extensionEnabled:      true,
    gifBehavior:           'remove',  // 'nothing' | 'remove' | 'censor'
    videoBehavior:         'remove',  // 'nothing' | 'remove' | 'censor'
    loadBehavior:          'blur',
    // Video tab
    videoPrebufferSeconds: 10,
    videoTargetFps:        10,
    videoMaxInFlight:      128,
    videoFrameFormat:      'webp',
    frameCompressionLevel: 0.5,
};

const $ = id => document.getElementById(id);

// ── Version ───────────────────────────────────────────────────────────────────
const manifest = browser.runtime.getManifest();
$("version").textContent = `v${manifest.version}`;

// ── Load & render saved state ─────────────────────────────────────────────────
browser.storage.sync.get(SETTING_DEFAULTS).then(settings => {
    applyToggleUI("extensionEnabled",       settings.extensionEnabled);
    applySelectUI("gifBehavior",            settings.gifBehavior);
    applySelectUI("videoBehavior",          settings.videoBehavior);
    applySelectUI("loadBehavior",           settings.loadBehavior);
    applySelectUI("videoFrameFormat",       settings.videoFrameFormat);
    applyNumericUI("videoPrebufferSeconds", settings.videoPrebufferSeconds);
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

// ── Select interactions ───────────────────────────────────────────────────────
for (const setting of ["gifBehavior", "videoBehavior", "loadBehavior", "videoFrameFormat"]) {
    $(`select-${setting}`).addEventListener("change", async () => {
        const newValue = $(`select-${setting}`).value;
        if (!newValue) return;
        await browser.storage.sync.set({ [setting]: newValue });
        broadcast(setting, newValue);
    });
}

// ── Numeric input interactions ────────────────────────────────────────────────
for (const setting of ["videoPrebufferSeconds", "videoTargetFps", "videoMaxInFlight", "frameCompressionLevel"]) {
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
