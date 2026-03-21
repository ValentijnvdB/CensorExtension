// ── Config tab ────────────────────────────────────────────────────────────────
// Depends on: shared.js (state, FEATURES, CONFIG_DEFAULTS, $, deepClone, saveState)


async function resetCache() {
  const url = state.baseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${url}${CONNECTION_DEFAULTS.reset_cache}`, { method: "GET", cache: "no-store" });
    const data = await res.json();
    if (res.ok && data.status === "success") {
      showToast("Reset cache successfully", "saved");
    } else {
      showToast(`Failed to reset cache: ${data.message ?? res.statusText}`, "err");
    }
  } catch (err) {
    showToast(`Failed to reset cache: ${err.message}`, "err");
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

function buildConfigFields(container, cfg, onChange) {
  if (typeof container === "string") container = $(container);
  container.innerHTML = "";
  // Use a unique prefix per container to avoid duplicate IDs
  const pfx = container.id || Math.random().toString(36).slice(2);

  container.appendChild(makeSelect(`censor_style-${pfx}`, "Censor style", cfg.censor_style,
      ["blur", "pixel", "bar"], val => {
        cfg.censor_style = val;
        refreshConditionals(container, cfg);
        onChange();
      }
  ));

  const blurWrap = makeSubWrap("blur-wrap");
  blurWrap.appendChild(makeInt(`blur_strength-${pfx}`, "Blur strength", cfg.blur_strength, val => {
    cfg.blur_strength = val; onChange();
  }));
  container.appendChild(blurWrap);

  const pixelWrap = makeSubWrap("pixel-wrap");
  pixelWrap.appendChild(makeInt(`pixel_factor-${pfx}`, "Pixel factor", cfg.pixel_factor, val => {
    cfg.pixel_factor = val; onChange();
  }));
  container.appendChild(pixelWrap);

  const barWrap = makeSubWrap("bar-wrap");
  barWrap.appendChild(makeColor(`bar_color-${pfx}`, "Bar color", cfg.bar_color, val => {
    cfg.bar_color = val; onChange();
  }));
  container.appendChild(barWrap);

  container.appendChild(makeToggle(`border-${pfx}`, "Border", cfg.border, val => {
    cfg.border = val;
    refreshConditionals(container, cfg);
    onChange();
  }));

  const borderWrap = makeSubWrap("border-sub-wrap");
  borderWrap.appendChild(makeInt(`border_thickness-${pfx}`, "Border thickness", cfg.border_thickness, val => {
    cfg.border_thickness = val; onChange();
  }));
  borderWrap.appendChild(makeColor(`border_color-${pfx}`, "Border color", cfg.border_color, val => {
    cfg.border_color = val; onChange();
  }));
  container.appendChild(borderWrap);

  container.appendChild(makeToggle(`inverse-${pfx}`, "Inverse", cfg.inverse, val => {
    cfg.inverse = val; onChange();
  }));

  container.appendChild(makeSelect(`shape-${pfx}`, "Shape", cfg.shape,
      ["default", "ellipse", "circle", "rectangle"], val => {
        cfg.shape = val; onChange();
      }
  ));

  // Overlay
  container.appendChild(makeSelect(`overlay_type-${pfx}`, "Overlay", cfg.overlay_type,
      ["off", "text", "sticker"], val => {
        cfg.overlay_type = val;
        refreshConditionals(container, cfg);
        onChange();
      }
  ));

  const overlayTextWrap = makeSubWrap("overlay-text-wrap");
  overlayTextWrap.appendChild(makeFloat(`overlay_prob-${pfx}`, "Probability", cfg.overlay_prob, 0, 1, val => {
    cfg.overlay_prob = val; onChange();
  }));
  overlayTextWrap.appendChild(makeText(`overlay_values-${pfx}`, "Values", cfg.overlay_values, val => {
    cfg.overlay_values = val; onChange();
  }));
  overlayTextWrap.appendChild(makeColor(`overlay_color-${pfx}`, "Color", cfg.overlay_color, val => {
    cfg.overlay_color = val; onChange();
  }));
  overlayTextWrap.appendChild(makeFloat(`overlay_font_scale-${pfx}`, "Font scale", cfg.overlay_font_scale, null, null, val => {
    cfg.overlay_font_scale = val; onChange();
  }));
  container.appendChild(overlayTextWrap);

  const overlayStickerWrap = makeSubWrap("overlay-sticker-wrap");
  overlayStickerWrap.appendChild(makeFloat(`overlay_prob_sticker-${pfx}`, "Probability", cfg.overlay_prob, 0, 1, val => {
    cfg.overlay_prob = val; onChange();
  }));
  overlayStickerWrap.appendChild(makeText(`overlay_categories-${pfx}`, "Categories", cfg.overlay_categories, val => {
    cfg.overlay_categories = val; onChange();
  }));
  container.appendChild(overlayStickerWrap);

  // Advanced spoiler
  const spoiler = document.createElement("details");
  spoiler.className = "spoiler";
  const summary = document.createElement("summary");
  summary.className = "spoiler-label";
  summary.textContent = "Advanced";
  spoiler.appendChild(summary);

  spoiler.appendChild(makeFloat(`min_prob-${pfx}`, "Min probability", cfg.min_prob, 0, 1, val => {
    cfg.min_prob = val; onChange();
  }));
  spoiler.appendChild(makeFloat(`width_area_safety-${pfx}`, "Width area safety", cfg.width_area_safety, null, null, val => {
    cfg.width_area_safety = val; onChange();
  }));
  spoiler.appendChild(makeFloat(`height_area_safety-${pfx}`, "Height area safety", cfg.height_area_safety, null, null, val => {
    cfg.height_area_safety = val; onChange();
  }));
  spoiler.appendChild(makeToggle(`intersect_human-${pfx}`, "intersect_human", cfg.intersect_human, val => {
    cfg.intersect_human = val; onChange();
  }));
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
  show("border-sub-wrap",      cfg.border === true);
  show("overlay-text-wrap",    cfg.overlay_type === "text");
  show("overlay-sticker-wrap", cfg.overlay_type === "sticker");
}

// ── General section ───────────────────────────────────────────────────────────

function buildGeneralSection() {
  const container = $("general-fields");
  container.innerHTML = "";
  const g = state.general;

  // force_inverse_censor toggle
  container.appendChild(makeToggle("gen-force-inverse", "Force inverse censor", g.force_inverse_censor, val => {
    g.force_inverse_censor = val;
    saveState();
  }));

  // inverse_censor_style sub-section — always visible
  const inverseWrap = document.createElement("div");
  inverseWrap.id = "gen-inverse-sub";

  inverseWrap.appendChild(makeSelect("gen-inverse-style", "Inverse censor style", g.inverse_censor_style,
      ["blur", "pixel", "bar"], val => {
        g.inverse_censor_style = val;
        refreshGeneralConditionals();
        saveState();
      }
  ));

  const invBlurWrap = makeSubWrap("gen-inv-blur-wrap");
  invBlurWrap.appendChild(makeInt("gen-inv-blur-strength", "Blur strength", g.inverse_blur_strength, val => {
    g.inverse_blur_strength = val; saveState();
  }));
  inverseWrap.appendChild(invBlurWrap);

  const invPixelWrap = makeSubWrap("gen-inv-pixel-wrap");
  invPixelWrap.appendChild(makeInt("gen-inv-pixel-factor", "Pixel factor", g.inverse_pixel_factor, val => {
    g.inverse_pixel_factor = val; saveState();
  }));
  inverseWrap.appendChild(invPixelWrap);

  const invBarWrap = makeSubWrap("gen-inv-bar-wrap");
  invBarWrap.appendChild(makeColor("gen-inv-bar-color", "Bar color", g.inverse_bar_color, val => {
    g.inverse_bar_color = val; saveState();
  }));
  inverseWrap.appendChild(invBarWrap);

  container.appendChild(inverseWrap);

  // enable_overlays toggle
  container.appendChild(makeToggle("gen-enable-overlays", "Enable overlays", g.enable_overlays, val => {
    g.enable_overlays = val; saveState();
  }));

  // Advanced spoiler
  const spoiler = document.createElement("details");
  spoiler.className = "spoiler";
  const summary = document.createElement("summary");
  summary.className = "spoiler-label";
  summary.textContent = "Advanced";
  spoiler.appendChild(summary);

  spoiler.appendChild(makeToggle("gen-enable-watermark", "Enable watermark", g.enable_watermark, val => {
    g.enable_watermark = val; saveState();
  }));
  spoiler.appendChild(makeToggle("gen-merge-boxes", "Merge overlapping censor boxes", g.merge_overlapping_censor_boxes, val => {
    g.merge_overlapping_censor_boxes = val; saveState();
  }));
  spoiler.appendChild(makeToggle("gen-merge-borders", "Merge overlapping borders", g.merge_overlapping_borders, val => {
    g.merge_overlapping_borders = val; saveState();
  }));

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

// ── Feature accordion ─────────────────────────────────────────────────────────

function buildFeatureList() {
  const list = $("feature-list");
  list.innerHTML = "";

  for (const featureId of FEATURES) {
    const fState = state.features[featureId];

    const item = document.createElement("div");
    item.className = "accordion-item" + (fState.enabled ? "" : " disabled");

    // Header
    const header = document.createElement("div");
    header.className = "accordion-header";

    const enabledTog = buildToggleSwitch(`feat-enabled-${featureId}`, fState.enabled, val => {
      fState.enabled = val;
      item.classList.toggle("disabled", !val);
      saveState();
    });

    const name = document.createElement("span");
    name.className = "accordion-name";
    name.textContent = featureId.replace(/_/g, " ");

    const chevron = document.createElement("span");
    chevron.className = "accordion-chevron";
    chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>`;

    header.appendChild(enabledTog);
    header.appendChild(name);
    header.appendChild(chevron);

    // Body
    const body = document.createElement("div");
    body.className = "accordion-body";

    // "Use default" row
    const useDefaultRow = document.createElement("div");
    useDefaultRow.className = "field field-toggle use-default-row";
    const udLabel = document.createElement("span");
    udLabel.className = "toggle-label";
    udLabel.textContent = "Use default";

    const overrideSection = document.createElement("div");
    overrideSection.className = "override-section";
    overrideSection.id = `override-fields-${featureId}`;
    overrideSection.style.display = fState.useDefault ? "none" : "";

    const udTog = buildToggleSwitch(`feat-usedefault-${featureId}`, fState.useDefault, val => {
      fState.useDefault = val;
      overrideSection.style.display = val ? "none" : "";
      if (!val && overrideSection.innerHTML === "") {
        fState.config = deepClone(state.defaults);
        buildConfigFields(overrideSection, fState.config, () => saveState());
      }
      saveState();
    });

    useDefaultRow.appendChild(udLabel);
    useDefaultRow.appendChild(udTog);
    body.appendChild(useDefaultRow);
    body.appendChild(overrideSection);

    if (!fState.useDefault) {
      buildConfigFields(overrideSection, fState.config, () => saveState());
    }

    item.appendChild(header);
    item.appendChild(body);
    list.appendChild(item);

    header.addEventListener("click", e => {
      if (e.target.closest(".toggle-switch")) return;
      item.classList.toggle("open");
    });
  }
}