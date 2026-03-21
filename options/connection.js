// ── Connection tab ────────────────────────────────────────────────────────────
// Depends on: shared.js (state, CONNECTION_DEFAULTS, $, saveState, showToast)

function initConnectionTab() {
  $("baseUrl").value     = state.baseUrl;
  $("process").value = state.process;

  $("baseUrl").addEventListener("blur", () => {
    state.baseUrl = $("baseUrl").value.trim().replace(/\/$/, "");
    saveState();
  });
  $("process").addEventListener("blur", () => {
    state.process = $("process").value.trim() || CONNECTION_DEFAULTS.process;
    saveState();
  });

  $("btnTest").addEventListener("click", runTest);
  $("btnSave").addEventListener("click", handleSave);
  $("btnResetCache").addEventListener("click", resetCache);

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

async function runTest() {
  const url            = $("baseUrl").value.trim().replace(/\/$/, "");
  const connectionPath = "/assets/connection_test.png";
  const dot            = $("dot");
  const text           = $("statusText");
  const banner         = $("certBanner");

  dot.className    = "dot testing";
  text.className   = "status-text";
  text.textContent = "testing…";
  banner.classList.remove("visible", "trusted");

  try {
    const res = await fetch(`${url}${connectionPath}`, { method: "HEAD", cache: "no-store" });
    if (res.ok) {
      dot.className    = "dot ok";
      text.className   = "status-text ok";
      text.textContent = `reachable — ${res.status} ${res.statusText}`;
    } else {
      throw new Error(`${res.status} ${res.statusText}`);
    }
  } catch (err) {
    const isHttps    = url.toLowerCase().startsWith("https://");
    const isCertLike = err instanceof TypeError && isHttps;
    dot.className    = "dot " + (isCertLike ? "warn" : "fail");
    text.className   = "status-text " + (isCertLike ? "warn" : "fail");
    text.textContent = isCertLike
      ? "certificate not trusted — see below"
      : (err.message || "unreachable");
    if (isCertLike) {
      $("btnTrust").dataset.url = `${url}${connectionPath}`;
      banner.classList.add("visible");
    }
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
  state.baseUrl     = baseUrl;
  state.process = $("process").value.trim() || CONNECTION_DEFAULTS.process;
  await saveState();
}


