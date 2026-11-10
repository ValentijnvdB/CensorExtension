// ── Connection tab ────────────────────────────────────────────────────────────
// Depends on: shared.js (state, $, saveState, showToast, refreshBackend)
//             backend_api.js (fetchHealth)

function initConnectionTab() {
  $("baseUrl").value = state.baseUrl;

  $("baseUrl").addEventListener("blur", () => {
    state.baseUrl = $("baseUrl").value.trim().replace(/\/$/, "");
    saveState();
  });

  $("btnTest").addEventListener("click", runTest);
  $("btnSave").addEventListener("click", handleSave);

  $("btnTrust").addEventListener("click", () => {
    const target = $("btnTrust").dataset.url;
    browser.tabs.create({ url: target });
    const banner = $("certBanner");
    banner.classList.add("trusted");
    banner.innerHTML = `
      <p>
        <strong>Tab opened.</strong><br />
        Accept the certificate warning in that tab, then come back and
        re-test to confirm the connection works.
      </p>
      <button class="btn-retest" id="btnRetest">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        Re-test connection
      </button>
    `;
    $("btnRetest").addEventListener("click", runTest);
  });
}

/** "3725.4" → "1h 2m" */
function formatUptime(seconds) {
  const s = Math.floor(seconds ?? 0);
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

async function runTest() {
  const url    = $("baseUrl").value.trim().replace(/\/$/, "");
  const dot    = $("dot");
  const text   = $("statusText");
  const banner = $("certBanner");

  const setStatus = (kind, msg) => {
    dot.className    = `dot ${kind}`;
    text.className   = `status-text ${kind === "testing" ? "" : kind}`;
    text.textContent = msg;
  };

  setStatus("testing", "testing…");
  banner.classList.remove("visible", "trusted");

  const { reachable, ok, health, error } = await fetchHealth(url);

  if (ok) {
    setStatus("ok", `ready — profile ${health.profile ?? "?"}, ${health.backend ?? "?"} backend, ` +
                    `up ${formatUptime(health.uptime_seconds)}`);
  } else if (reachable && health) {
    setStatus("warn", `reachable, but the pipeline is not running (profile ${health.profile ?? "?"})`);
  } else if (reachable && error.status === 404) {
    setStatus("warn", "reachable, but the server has no /health — is the backend up to date?");
  } else if (reachable) {
    setStatus("fail", error.message);
  } else if (url.toLowerCase().startsWith("https://")) {
    // fetch() gives no details; with https a missing certificate exception is the usual cause.
    setStatus("warn", "certificate not trusted (or server down) — see below");
    $("btnTrust").dataset.url = `${url}/health`;
    banner.classList.add("visible");
  } else {
    setStatus("fail", error.message || "unreachable");
  }
}

async function handleSave() {
  const baseUrl = $("baseUrl").value.trim().replace(/\/$/, "");
  if (!baseUrl) {
    $("baseUrl").classList.add("error");
    showToast("Base URL is required", "err");
    return;
  }
  $("baseUrl").classList.remove("error");
  state.baseUrl = baseUrl;
  await saveState();
  await refreshBackend();
}


