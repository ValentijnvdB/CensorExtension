const SETTING_DEFAULTS = { removeGifs: false, removeVideos: false, censorVideos: false, loadBehavior: 'blur', extensionEnabled: true };

const $ = id => document.getElementById(id);

// ── Load version from manifest ────────────────────────────────────────────────
const manifest = browser.runtime.getManifest();
$("version").textContent = `v${manifest.version}`;

// ── Render saved state ────────────────────────────────────────────────────────
browser.storage.sync.get(SETTING_DEFAULTS).then(settings => {
    applyToggleUI("extensionEnabled", settings.extensionEnabled);
    applyToggleUI("removeGifs",    settings.removeGifs);
    applyToggleUI("removeVideos",  settings.removeVideos);
    applyToggleUI("censorVideos",  settings.censorVideos);
    applySelectUI("loadBehavior",  settings.loadBehavior);
});

// ── Toggle interaction ────────────────────────────────────────────────────────
for (const setting of ["extensionEnabled", "removeGifs", "removeVideos", "censorVideos"]) {
    $(`toggle-${setting}`).addEventListener("click", async () => {
        const current  = await browser.storage.sync.get(SETTING_DEFAULTS);
        const newValue = !current[setting];

        await browser.storage.sync.set({ [setting]: newValue });
        applyToggleUI(setting, newValue);

        // Notify all tabs so the content script can react immediately.
        const tabs = await browser.tabs.query({});
        for (const tab of tabs) {
            browser.tabs.sendMessage(tab.id, {
                type:    "SETTING_CHANGED",
                setting: setting,
                value:   newValue,
            }).catch(() => {
                // Tab may not have the content script (e.g. about:blank) — ignore.
            });
        }
    });
}

for (const setting of ["loadBehavior"]) {
    $(`select-${setting}`).addEventListener("change", async () => {
        const newValue = $(`select-${setting}`).value;
        if (!newValue) return;

        await browser.storage.sync.set({ [setting]: newValue });

        // Notify all tabs so the content script can react immediately.
        const tabs = await browser.tabs.query({});
        for (const tab of tabs) {
            browser.tabs.sendMessage(tab.id, {
                type: "SETTING_CHANGED",
                setting: setting,
                value: newValue,
            }).catch(() => {
                // Tab may not have the content script (e.g. about:blank) — ignore.
            });
        }
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
    btn.setAttribute("aria-checked", String(value));
}

function applySelectUI(id, value) {
    const selectElement = $(`select-${id}`);
    if (selectElement) {
        selectElement.value = value;
    }
}
