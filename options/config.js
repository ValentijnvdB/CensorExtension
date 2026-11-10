// ── Config tab ────────────────────────────────────────────────────────────────
// Depends on: censor_schema.js (CENSOR_STYLES, SHAPES, ...)
//             shared.js (state, $, deepClone, saveState)


// ── Server storage (Advanced tab) ─────────────────────────────────────────────
// Depends on: backend_api.js (fetchCacheInfo, fetchStorageInfo, clearCache, clearStorage, formatBytes)

const serverUrl = () => state.baseUrl.replace(/\/$/, "");

function setStorageStatus(kind, text) {
  $("storageDot").className    = `dot ${kind}`;
  $("storageStatus").className = `status-text ${kind === "testing" ? "" : kind}`;
  $("storageStatus").textContent = text;
}

/** Fills a <tbody> with [name, files, bytes] rows. */
function fillStorageTable(tbody, rows) {
  tbody.innerHTML = "";
  for (const [name, files, bytes] of rows) {
    const tr = tbody.insertRow();
    tr.insertCell().textContent = name;
    tr.insertCell().textContent = `${files} file${files === 1 ? "" : "s"}`;
    tr.insertCell().textContent = formatBytes(bytes);
  }
}

async function refreshStorage() {
  setStorageStatus("testing", "loading…");
  const [cache, storage] = await Promise.allSettled([
    fetchCacheInfo(serverUrl()),
    fetchStorageInfo(serverUrl()),
  ]);

  fillStorageTable($("cacheTable"),
      cache.status === "fulfilled" ? [["cache/server", cache.value.files, cache.value.bytes]] : []);

  if (storage.status === "fulfilled") {
    const st = storage.value;
    fillStorageTable($("storageTable"), [
      ...Object.entries(st.folders ?? {}).sort().map(([name, f]) => [name, f.files ?? 0, f.bytes ?? 0]),
      ["total", st.files ?? 0, st.bytes ?? 0],
    ]);
    const hours = st.retention_hours;
    $("storageDesc").textContent =
        `Originals and censored images the server keeps in ${st.server_dir ?? "data/server"}/. ` +
        (hours === 0 ? "Files are kept forever."
                     : `A file is removed once it has not been used for ${hours ?? 24} hours.`);
  } else {
    fillStorageTable($("storageTable"), []);
  }

  const failed = [cache, storage].filter(r => r.status === "rejected");
  $("btnClearCache").disabled   = cache.status   === "rejected";
  $("btnClearStorage").disabled = storage.status === "rejected";
  if (!failed.length) {
    setStorageStatus("ok", `updated ${new Date().toLocaleTimeString()}`);
  } else {
    const err = failed[0].reason;
    setStorageStatus(failed.length === 2 ? "fail" : "warn",
        err?.status === 404 ? "the server has no /cache or /storage — is the backend up to date?"
                            : (err?.message ?? "failed to load"));
  }
}

async function runClear(action, what) {
  try {
    const res = await action(serverUrl());
    showToast(`Cleared ${what}: ${res.deleted_files ?? 0} files, ${formatBytes(res.deleted_bytes)}`, "saved");
  } catch (err) {
    showToast(`Failed to clear ${what}: ${err.message}`, "err");
  }
  await refreshStorage();
}

$("btnRefreshStorage").addEventListener("click", refreshStorage);
$("btnClearCache").addEventListener("click", () => runClear(clearCache, "detection cache"));
$("btnClearStorage").addEventListener("click", () => {
  if (!confirm("Remove the files the server keeps?\n\n" +
               "Censored images that open pages still show will no longer load until the page is reloaded.")) return;
  runClear(clearStorage, "stored files");
});
// Load the numbers when the tab is opened.
document.querySelector('.tab[data-tab="advanced"]').addEventListener("click", refreshStorage);

// ── Server check (POST /censor_config/validate) ──────────────────────────────
// Runs after every save, so problems the extension can't see on its own
// (labels no model produces, shape: mask on a detect model, ...) show up
// straight away. Settings are still saved when invalid: the content scripts
// then fall back to the server's censor config.

let validateTimer      = null;
let validateController = null;

function setValidateStatus(kind, text) {
  $("validateDot").className    = `dot ${kind}`;
  $("validateStatus").className = `status-text ${kind === "testing" ? "" : kind}`;
  $("validateStatus").textContent = text;
}

function showValidateMessages(errors, warnings) {
  const list = $("validateList");
  list.innerHTML = "";
  for (const [cls, msgs] of [["err", errors], ["warn", warnings]]) {
    for (const msg of msgs) {
      const li = document.createElement("li");
      li.className = cls;
      li.textContent = msg;
      list.appendChild(li);
    }
  }
}

/** Validates the current settings shortly after the last change. */
function scheduleValidation() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(runValidation, 400);
}

async function runValidation() {
  validateController?.abort();
  const controller = validateController = new AbortController();

  const profile = backendInfo?.profile;
  if (!profile || backendInfo.offline || !state.general || !state.defaults) {
    setValidateStatus("", "not checked — backend unreachable");
    showValidateMessages([], []);
    return;
  }

  setValidateStatus("testing", "checking…");
  try {
    // Image and video configs only differ in enable_overlays; check both.
    const results = await Promise.all(["image", "video"].map(media =>
        validateCensorConfig(serverUrl(), buildCensorConfig(state, profile, serverCensorConfig(), media),
                             { signal: controller.signal })));
    if (controller !== validateController) return;

    const unique   = key => [...new Set(results.flatMap(r => r[key]))];
    const errors   = unique("errors");
    const warnings = unique("warnings");
    const valid    = results.every(r => r.valid);

    showValidateMessages(errors, warnings);
    if (!valid) {
      setValidateStatus("fail", "rejected by the server — pages use the server's censor config instead");
    } else if (warnings.length) {
      setValidateStatus("warn", `accepted, with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
    } else {
      setValidateStatus("ok", "accepted by the server");
    }
  } catch (err) {
    if (err.name === "AbortError" || controller !== validateController) return;
    showValidateMessages([], []);
    setValidateStatus("warn", err.status === 404
        ? "not checked — the server has no /censor_config/validate"
        : `not checked — ${err.message}`);
  }
}

// ── Field builders ────────────────────────────────────────────────────────────

function makeField(labelText) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const lbl = document.createElement("label");
  lbl.textContent = labelText;
  wrap.appendChild(lbl);
  return { wrap, lbl };
}

function makeSubWrap(wrapId) {
  const div = document.createElement("div");
  div.dataset.wrap = wrapId;
  div.className = "sub-fields";
  return div;
}

function makeSelect(id, labelText, value, options, onChange) {
  const { wrap, lbl } = makeField(labelText);
  lbl.setAttribute("for", id);
  const sel = document.createElement("select");
  sel.id = id;
  sel.className = "cfg-select";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    if (opt === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  wrap.appendChild(sel);
  return wrap;
}

function makeToggle(id, labelText, value, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "field field-toggle";
  const lbl = document.createElement("span");
  lbl.className = "toggle-label";
  lbl.textContent = labelText;
  wrap.appendChild(lbl);
  wrap.appendChild(buildToggleSwitch(id, value, onChange));
  return wrap;
}

function makeInt(id, labelText, value, onChange) {
  const { wrap, lbl } = makeField(labelText);
  lbl.setAttribute("for", id);
  const inp = document.createElement("input");
  inp.type = "number";
  inp.id = id;
  inp.value = value;
  inp.step = "1";
  inp.min = "0";
  inp.className = "cfg-input";
  inp.addEventListener("blur", () => {
    const v = parseInt(inp.value, 10);
    if (!isNaN(v) && v >= 0) onChange(v);
  });
  wrap.appendChild(inp);
  return wrap;
}

function makeFloat(id, labelText, value, min, max, onChange) {
  const { wrap, lbl } = makeField(labelText);
  lbl.setAttribute("for", id);
  const inp = document.createElement("input");
  inp.type = "number";
  inp.id = id;
  inp.value = value;
  inp.step = "0.01";
  if (min !== null && min !== undefined) inp.min = String(min);
  if (max !== null && max !== undefined) inp.max = String(max);
  inp.className = "cfg-input";
  inp.addEventListener("blur", () => {
    const v = parseFloat(inp.value);
    if (!isNaN(v)) onChange(v);
  });
  wrap.appendChild(inp);
  return wrap;
}

function makeColor(id, labelText, value, onChange) {
  const { wrap, lbl } = makeField(labelText);
  lbl.setAttribute("for", id);
  const row = document.createElement("div");
  row.className = "color-row";
  const inp = document.createElement("input");
  inp.type = "color";
  inp.id = id;
  inp.value = value;
  inp.className = "cfg-color";
  const hex = document.createElement("span");
  hex.className = "color-hex";
  hex.textContent = value;
  inp.addEventListener("input", () => { hex.textContent = inp.value; });
  inp.addEventListener("change", () => onChange(inp.value));
  row.appendChild(inp);
  row.appendChild(hex);
  wrap.appendChild(row);
  return wrap;
}

function makeText(id, labelText, value, onChange) {
  const { wrap, lbl } = makeField(labelText);
  lbl.setAttribute("for", id);
  const inp = document.createElement("input");
  inp.type = "text";
  inp.id = id;
  inp.value = value;
  inp.className = "cfg-input";
  inp.addEventListener("blur", () => onChange(inp.value));
  wrap.appendChild(inp);
  return wrap;
}

function makeNote(text) {
  const p = document.createElement("p");
  p.className = "field-desc field-note";
  p.textContent = text;
  return p;
}

function makeSpoiler(labelText) {
  const spoiler = document.createElement("details");
  spoiler.className = "spoiler";
  const summary = document.createElement("summary");
  summary.className = "spoiler-label";
  summary.textContent = labelText;
  spoiler.appendChild(summary);
  return spoiler;
}

/** A list of checkboxes; onChange receives the selected options as an array. */
function makeMultiCheck(id, labelText, options, selected, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "field field-multi";
  const lbl = document.createElement("span");
  lbl.className = "toggle-label";
  lbl.textContent = labelText;
  wrap.appendChild(lbl);

  const list = document.createElement("div");
  list.className = "multi-check";
  const chosen = new Set(selected ?? []);
  options.forEach((opt, i) => {
    const row = document.createElement("label");
    row.className = "multi-check-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `${id}-${i}`;
    cb.checked = chosen.has(opt);
    cb.addEventListener("change", () => {
      cb.checked ? chosen.add(opt) : chosen.delete(opt);
      onChange(options.filter(o => chosen.has(o)));
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(opt));
    list.appendChild(row);
  });
  wrap.appendChild(list);
  return wrap;
}

function buildToggleSwitch(id, checked, onChange) {
  const label = document.createElement("label");
  label.className = "toggle-switch";
  label.setAttribute("for", id);
  const inp = document.createElement("input");
  inp.type = "checkbox";
  inp.id = id;
  inp.checked = checked;
  inp.addEventListener("change", () => onChange(inp.checked));
  const track = document.createElement("span");
  track.className = "toggle-track";
  const thumb = document.createElement("span");
  thumb.className = "toggle-thumb";
  track.appendChild(thumb);
  label.appendChild(inp);
  label.appendChild(track);
  return label;
}

// ── Config fields renderer ────────────────────────────────────────────────────

/**
 * Renders the censor box fields for `cfg` (flat format, see censor_schema.js).
 * `clipLabels` are the labels offered for clip_to (default: the profile's labels).
 */
function buildConfigFields(container, cfg, onChange, clipLabels = profileLabels()) {
  if (typeof container === "string") container = $(container);
  container.innerHTML = "";
  // Use a unique prefix per container to avoid duplicate IDs
  const pfx = container.id || Math.random().toString(36).slice(2);
  const set = (key, refresh = false) => val => {
    cfg[key] = val;
    if (refresh) refreshConditionals(container, cfg);
    onChange();
  };

  // Censor style
  container.appendChild(makeSelect(`censor_style-${pfx}`, "Censor style", cfg.censor_style,
      CENSOR_STYLES, set("censor_style", true)));

  const blurWrap = makeSubWrap("blur-wrap");
  blurWrap.appendChild(makeInt(`blur_strength-${pfx}`, "Blur strength", cfg.blur_strength, set("blur_strength")));
  container.appendChild(blurWrap);

  const pixelWrap = makeSubWrap("pixel-wrap");
  pixelWrap.appendChild(makeInt(`pixel_factor-${pfx}`, "Pixel factor", cfg.pixel_factor, set("pixel_factor")));
  container.appendChild(pixelWrap);

  const barWrap = makeSubWrap("bar-wrap");
  barWrap.appendChild(makeColor(`bar_color-${pfx}`, "Bar color", cfg.bar_color, set("bar_color")));
  container.appendChild(barWrap);

  const debugWrap = makeSubWrap("debug-wrap");
  debugWrap.appendChild(makeColor(`debug_color-${pfx}`, "Debug color", cfg.debug_color, set("debug_color")));
  container.appendChild(debugWrap);

  const aiWrap = makeSubWrap("ai_remove-wrap");
  aiWrap.appendChild(makeNote(
      "Inpaints the area with ComfyUI. Requires a ComfyUI server configured on the backend. Slow."));
  container.appendChild(aiWrap);

  // Border
  container.appendChild(makeToggle(`border-${pfx}`, "Border", cfg.border, set("border", true)));

  const borderWrap = makeSubWrap("border-sub-wrap");
  borderWrap.appendChild(makeInt(`border_thickness-${pfx}`, "Border thickness", cfg.border_thickness, set("border_thickness")));
  borderWrap.appendChild(makeColor(`border_color-${pfx}`, "Border color", cfg.border_color, set("border_color")));
  container.appendChild(borderWrap);

  container.appendChild(makeToggle(`inverse-${pfx}`, "Inverse", cfg.inverse, set("inverse")));

  container.appendChild(makeSelect(`shape-${pfx}`, "Shape", cfg.shape, SHAPES, set("shape")));

  // Overlay
  container.appendChild(makeSelect(`overlay_type-${pfx}`, "Overlay", cfg.overlay_type, OVERLAY_TYPES, val => {
    if (val !== "off" && state.general && !state.general.enable_image_overlays) {
      warnAfterSave(IMAGE_OVERLAYS_OFF_WARNING);
    }
    set("overlay_type", true)(val);
  }));

  const overlayTextWrap = makeSubWrap("overlay-text-wrap");
  overlayTextWrap.appendChild(makeFloat(`overlay_probability-${pfx}`, "Probability", cfg.overlay_probability, 0, 1, set("overlay_probability")));
  overlayTextWrap.appendChild(makeText(`overlay_values-${pfx}`, "Values", cfg.overlay_values, set("overlay_values")));
  overlayTextWrap.appendChild(makeColor(`overlay_color-${pfx}`, "Color", cfg.overlay_color, set("overlay_color")));
  overlayTextWrap.appendChild(makeInt(`overlay_thickness-${pfx}`, "Thickness", cfg.overlay_thickness, set("overlay_thickness")));
  overlayTextWrap.appendChild(makeFloat(`overlay_font_scale-${pfx}`, "Font scale", cfg.overlay_font_scale, null, null, set("overlay_font_scale")));
  container.appendChild(overlayTextWrap);

  const overlayStickerWrap = makeSubWrap("overlay-sticker-wrap");
  overlayStickerWrap.appendChild(makeFloat(`overlay_probability_sticker-${pfx}`, "Probability", cfg.overlay_probability, 0, 1, set("overlay_probability")));
  overlayStickerWrap.appendChild(makeStickerField(`overlay_stickers-${pfx}`, cfg, onChange));
  container.appendChild(overlayStickerWrap);

  // Advanced spoiler
  const spoiler = makeSpoiler("Advanced");
  spoiler.appendChild(makeFloat(`min_probability-${pfx}`, "Min probability", cfg.min_probability, 0, 1, set("min_probability")));
  spoiler.appendChild(makeFloat(`width_area_safety-${pfx}`, "Width area safety", cfg.width_area_safety, null, null, set("width_area_safety")));
  spoiler.appendChild(makeFloat(`height_area_safety-${pfx}`, "Height area safety", cfg.height_area_safety, null, null, set("height_area_safety")));
  spoiler.appendChild(makeFloat(`time_safety-${pfx}`, "Time safety (s)", cfg.time_safety, 0, null, set("time_safety")));
  spoiler.appendChild(makeNote("Videos only: keep the censor on screen this many seconds after the feature was last detected."));
  spoiler.appendChild(makeMultiCheck(`clip_to-${pfx}`, "Clip to", clipLabels, cfg.clip_to, set("clip_to")));
  container.appendChild(spoiler);

  refreshConditionals(container, cfg);
}

function refreshConditionals(container, cfg) {
  const show = (wrapId, visible) => {
    const el = container.querySelector(`[data-wrap="${wrapId}"]`);
    if (el) el.style.display = visible ? "" : "none";
  };
  show("blur-wrap",            cfg.censor_style === "blur");
  show("pixel-wrap",           cfg.censor_style === "pixel");
  show("bar-wrap",             cfg.censor_style === "bar");
  show("debug-wrap",           cfg.censor_style === "debug");
  show("ai_remove-wrap",       cfg.censor_style === "ai_remove");
  show("border-sub-wrap",      cfg.border === true);
  show("overlay-text-wrap",    cfg.overlay_type === "text");
  show("overlay-sticker-wrap", cfg.overlay_type === "sticker");
}

// ── General section ───────────────────────────────────────────────────────────

const IMAGE_OVERLAYS_OFF_WARNING =
    "Overlays won't show on images: turn on \"Enable image overlays\" in General";

/** True when the default box or any label override has an overlay selected. */
function anyBoxUsesOverlay() {
  const boxes = [
    state.defaults,
    ...Object.values(state.models).flatMap(m => Object.values(m.features ?? {}))
        .filter(f => !f.useDefault).map(f => f.config),
  ];
  return boxes.some(box => box && box.overlay_type !== "off");
}

function buildGeneralSection() {
  const container = $("general-fields");
  container.innerHTML = "";
  const g = state.general;
  const set = (key, refresh = false) => val => {
    g[key] = val;
    if (refresh) refreshGeneralConditionals();
    saveState();
  };

  container.appendChild(makeToggle("gen-force-inverse", "Force inverse censor", g.force_inverse_censor, set("force_inverse_censor")));

  // inverse_censor_style sub-section — always visible
  const inverseWrap = document.createElement("div");
  inverseWrap.id = "gen-inverse-sub";

  inverseWrap.appendChild(makeSelect("gen-inverse-style", "Inverse censor style", g.inverse_censor_style,
      INVERSE_CENSOR_STYLES, set("inverse_censor_style", true)));

  const invBlurWrap = makeSubWrap("gen-inv-blur-wrap");
  invBlurWrap.appendChild(makeInt("gen-inv-blur-strength", "Blur strength", g.inverse_blur_strength, set("inverse_blur_strength")));
  inverseWrap.appendChild(invBlurWrap);

  const invPixelWrap = makeSubWrap("gen-inv-pixel-wrap");
  invPixelWrap.appendChild(makeInt("gen-inv-pixel-factor", "Pixel factor", g.inverse_pixel_factor, set("inverse_pixel_factor")));
  inverseWrap.appendChild(invPixelWrap);

  const invBarWrap = makeSubWrap("gen-inv-bar-wrap");
  invBarWrap.appendChild(makeColor("gen-inv-bar-color", "Bar color", g.inverse_bar_color, set("inverse_bar_color")));
  inverseWrap.appendChild(invBarWrap);

  container.appendChild(inverseWrap);

  container.appendChild(makeToggle("gen-enable-image-overlays", "Enable image overlays", g.enable_image_overlays, val => {
    if (!val && anyBoxUsesOverlay()) warnAfterSave(IMAGE_OVERLAYS_OFF_WARNING);
    set("enable_image_overlays")(val);
  }));
  container.appendChild(makeToggle("gen-enable-video-overlays", "Enable video overlays", g.enable_video_overlays, set("enable_video_overlays")));

  // Advanced spoiler
  const spoiler = makeSpoiler("Advanced");
  spoiler.appendChild(makeToggle("gen-enable-watermark", "Enable watermark", g.enable_watermark, set("enable_watermark")));
  spoiler.appendChild(makeToggle("gen-merge-borders", "Merge overlapping borders", g.merge_overlapping_borders, set("merge_overlapping_borders")));
  spoiler.appendChild(makeText("gen-stickers-dir", "Stickers dir", g.stickers_dir, set("stickers_dir")));
  spoiler.appendChild(makeNote("Must be data/stickers or one of its subfolders on the server."));
  container.appendChild(spoiler);

  refreshGeneralConditionals();
}

function refreshGeneralConditionals() {
  const g = state.general;
  const sub = $("gen-inverse-sub");

  const show = (wrapId, visible) => {
    const el = sub ? sub.querySelector(`[data-wrap="${wrapId}"]`) : null;
    if (el) el.style.display = visible ? "" : "none";
  };
  show("gen-inv-blur-wrap",  g.inverse_censor_style === "blur");
  show("gen-inv-pixel-wrap", g.inverse_censor_style === "pixel");
  show("gen-inv-bar-wrap",   g.inverse_censor_style === "bar");
}

// ── Defaults section ──────────────────────────────────────────────────────────

function buildDefaultsSection() {
  buildConfigFields("defaults-fields", state.defaults, () => saveState());
}

// ── Profile section ───────────────────────────────────────────────────────────

function setProfileStatus(kind, text) {
  $("profileDot").className    = `dot ${kind}`;
  $("profileStatus").className = `status-text ${kind}`;
  $("profileStatus").textContent = text;
}

function buildProfileSection() {
  const profile = backendInfo?.profile;
  $("profileName").textContent = profile?.name ?? "—";
  $("btnResetGeneral").disabled = !serverCensorConfig();

  if (!backendInfo) {
    setProfileStatus("fail", "backend unreachable — check the Connection tab");
  } else if (backendInfo.offline) {
    const when = new Date(backendInfo.fetchedAt).toLocaleString();
    setProfileStatus("warn", `offline — showing the profile cached at ${when}`);
  } else if (!serverCensorConfig()) {
    setProfileStatus("warn", "connected — server has no /censor_config, using built-in defaults");
  } else {
    setProfileStatus("ok", `connected — ${profile.labels.length} labels`);
  }
}

$("btnRefreshProfile").addEventListener("click", refreshBackend);

$("btnResetGeneral").addEventListener("click", async () => {
  if (!confirm("Replace the General and Defaults settings with the server's censor config?")) return;
  resetGeneralAndDefaultsToServer();
  await saveState();
  buildGeneralSection();
  buildDefaultsSection();
});

// ── Model sections ────────────────────────────────────────────────────────────

const domId = str => str.replace(/[^\w-]/g, "_");

function makeButton(text, onClick, className = "btn-small") {
  const btn = document.createElement("button");
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}

function buildModelSections() {
  const container = $("model-sections");
  container.innerHTML = "";

  const groups = labelGroups();
  for (const [model, labels] of Object.entries(groups)) {
    container.appendChild(buildModelCard(model, labels, groups));
  }
  buildInactiveModels(groups);
}

function buildModelCard(model, labels, groups) {
  const features = state.models[model].features;

  const card = document.createElement("div");
  card.className = "card model-card";

  const header = document.createElement("div");
  header.className = "model-header";
  const title = document.createElement("p");
  title.className = "card-label";
  title.textContent = `Model · ${model}`;
  const count = document.createElement("span");
  count.className = "model-count";
  const updateCount = () => {
    const enabled = labels.filter(l => features[l].enabled).length;
    count.textContent = `${enabled}/${labels.length} enabled`;
  };
  header.append(title, count);
  card.appendChild(header);

  const rebuild = () => card.replaceWith(buildModelCard(model, labels, labelGroups()));

  // Actions
  const actions = document.createElement("div");
  actions.className = "model-actions";

  const setAll = enabled => async () => {
    for (const l of labels) features[l].enabled = enabled;
    await saveState();
    rebuild();
  };
  actions.appendChild(makeButton("Enable all", setAll(true)));
  actions.appendChild(makeButton("Disable all", setAll(false)));

  const resetBtn = makeButton("Reset to server", async () => {
    if (!confirm(`Replace the settings of "${model}" with the server's censor config?`)) return;
    resetModelToServer(model);
    await saveState();
    rebuild();
  });
  resetBtn.disabled = !serverCensorConfig();
  actions.appendChild(resetBtn);

  const sources = Object.keys(state.models).filter(m => m !== model).sort();
  if (sources.length) {
    const sel = document.createElement("select");
    sel.className = "cfg-select model-import-select";
    sel.appendChild(new Option("Import from…", ""));
    for (const m of sources) {
      sel.appendChild(new Option(m in groups ? m : `${m} (inactive)`, m));
    }
    sel.addEventListener("change", async () => {
      const from = sel.value;
      sel.value = "";
      if (!from) return;
      if (!confirm(`Replace the settings of "${model}" with those of "${from}"?\n` +
                   `Labels "${from}" doesn't have get the server's settings.`)) return;
      importIntoModel(from, model);
      await saveState();
      showToast(`Imported settings from ${from}`, "saved");
      rebuild();
    });
    actions.appendChild(sel);
  }
  card.appendChild(actions);

  // Labels
  const list = document.createElement("div");
  list.className = "feature-list";
  for (const label of labels) {
    list.appendChild(buildFeatureItem(model, label, features[label], updateCount));
  }
  card.appendChild(list);

  updateCount();
  return card;
}

function buildFeatureItem(model, label, fState, onEnabledChange) {
  const id = domId(`${model}-${label}`);

  const item = document.createElement("div");
  item.className = "accordion-item" + (fState.enabled ? "" : " disabled");

  // Header
  const header = document.createElement("div");
  header.className = "accordion-header";

  const enabledTog = buildToggleSwitch(`feat-enabled-${id}`, fState.enabled, val => {
    fState.enabled = val;
    item.classList.toggle("disabled", !val);
    onEnabledChange();
    saveState();
  });

  const name = document.createElement("span");
  name.className = "accordion-name";
  name.textContent = label.replace(/_/g, " ");

  const chevron = document.createElement("span");
  chevron.className = "accordion-chevron";
  chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

  header.append(enabledTog, name, chevron);

  // Body
  const body = document.createElement("div");
  body.className = "accordion-body";

  const useDefaultRow = document.createElement("div");
  useDefaultRow.className = "field field-toggle use-default-row";
  const udLabel = document.createElement("span");
  udLabel.className = "toggle-label";
  udLabel.textContent = "Use default";

  const overrideSection = document.createElement("div");
  overrideSection.className = "override-section";
  overrideSection.id = `override-fields-${id}`;
  overrideSection.style.display = fState.useDefault ? "none" : "";

  const udTog = buildToggleSwitch(`feat-usedefault-${id}`, fState.useDefault, val => {
    fState.useDefault = val;
    overrideSection.style.display = val ? "none" : "";
    if (!val && overrideSection.innerHTML === "") {
      fState.config = deepClone(state.defaults);
      buildConfigFields(overrideSection, fState.config, () => saveState());
    }
    saveState();
  });

  useDefaultRow.append(udLabel, udTog);
  body.append(useDefaultRow, overrideSection);

  if (!fState.useDefault) {
    buildConfigFields(overrideSection, fState.config, () => saveState());
  }

  item.append(header, body);

  header.addEventListener("click", e => {
    if (e.target.closest(".toggle-switch")) return;
    item.classList.toggle("open");
  });

  return item;
}

// ── Inactive saved configs ────────────────────────────────────────────────────

function buildInactiveModels(groups) {
  const card = $("inactive-card");
  const list = $("inactive-list");
  list.innerHTML = "";

  const inactive = Object.keys(state.models).filter(m => !(m in groups)).sort();
  card.style.display = inactive.length ? "" : "none";

  for (const model of inactive) {
    const row = document.createElement("div");
    row.className = "field inactive-row";
    const name = document.createElement("span");
    name.className = "toggle-label";
    const n = Object.keys(state.models[model].features ?? {}).length;
    name.textContent = `${model} · ${n} labels`;
    row.appendChild(name);
    row.appendChild(makeButton("Delete", async () => {
      if (!confirm(`Delete the saved settings of "${model}"?`)) return;
      delete state.models[model];
      await saveState();
      buildModelSections();
    }, "btn-small btn-danger"));
    list.appendChild(row);
  }
}
