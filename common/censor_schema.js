// ── Censor config schema ──────────────────────────────────────────────────────
// Shared by the options page and the content scripts.
//
// The backend (CensorTool) is leading: names and defaults follow its
// censor_config.md. Internally the extension stores censor boxes and general
// settings in a *flat* format that is convenient for the UI (e.g. it remembers
// the blur strength while the style is set to pixel). The functions below
// convert between the flat format and the backend format.

const CENSOR_STYLES         = ["blur", "pixel", "bar", "debug", "ai_remove"];
const INVERSE_CENSOR_STYLES = ["blur", "pixel", "bar"];
const SHAPES                = ["default", "rectangle", "ellipse", "circle", "mask"];
const OVERLAY_TYPES         = ["off", "text", "sticker"];

// ── Defaults (flat format) ────────────────────────────────────────────────────
// Values the backend uses when a key is left out. Where the backend has no
// default (bar/debug color, border settings) a sensible value is picked.

const BOX_DEFAULTS = {
  censor_style:        "blur",
  blur_strength:       31,
  pixel_factor:        20,
  bar_color:           "#000000",
  debug_color:         "#00ff00",
  min_probability:     0.5,
  shape:               "default",
  width_area_safety:   0.1,
  height_area_safety:  0.1,
  border:              false,
  border_thickness:    2,
  border_color:        "#ff0000",
  overlay_type:        "off",
  overlay_probability: 1.0,
  overlay_values:      "",
  overlay_color:       "#ffffff",
  overlay_thickness:   1,
  overlay_font_scale:  1.0,
  overlay_stickers:    [],   // folders and/or single images, relative to stickers_dir; [] = all
  inverse:             false,
  clip_to:             [],
};

const GENERAL_DEFAULTS = {
  force_inverse_censor:      false,
  inverse_censor_style:      "blur",
  inverse_blur_strength:     31,
  inverse_pixel_factor:      20,
  inverse_bar_color:         "#000000",
  merge_overlapping_borders: false,
  enable_overlays:           true,
  enable_watermark:          false,
  stickers_dir:              "data/stickers",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const cloneJson = obj => JSON.parse(JSON.stringify(obj));

/** "#rrggbb" → [R, G, B] */
function hexToRgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

/** [R, G, B] → "#rrggbb". Strings are passed through. */
function rgbToHex(rgb) {
  if (typeof rgb === "string") return rgb;
  return "#" + rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** "a, b ,c" → ["a", "b", "c"] */
function parseList(str) {
  return (str ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

/** ["a", "b"] → "a, b". Strings are passed through. */
function joinList(arr) {
  if (typeof arr === "string") return arr;
  return (arr ?? []).join(", ");
}

const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Applies a backend feature override to a backend censor box, the way the
 * backend does it: top-level keys replace, nested settings (censor_style,
 * border, overlay) are replaced as a whole.
 */
function mergeBox(base, override) {
  return { ...(base ?? {}), ...(override ?? {}) };
}

// ── Censor box conversion ─────────────────────────────────────────────────────

/** Flat censor box → backend censor box. */
function toBackendBox(flat) {
  const f = { ...BOX_DEFAULTS, ...flat };

  const styles = {
    blur:      { strength: f.blur_strength },
    pixel:     { factor:   f.pixel_factor },
    bar:       { color:    hexToRgb(f.bar_color) },
    debug:     { color:    hexToRgb(f.debug_color) },
    ai_remove: {},
  };
  const style = styles[f.censor_style] ? f.censor_style : BOX_DEFAULTS.censor_style;

  const overlays = {
    text: {
      type:        "text",
      probability: f.overlay_probability,
      values:      parseList(f.overlay_values),
      color:       hexToRgb(f.overlay_color),
      thickness:   f.overlay_thickness,
      font_scale:  f.overlay_font_scale,
    },
    sticker: {
      type:        "sticker",
      probability: f.overlay_probability,
      stickers:    [...(f.overlay_stickers ?? [])],
    },
  };

  return {
    censor_style:       { type: style, ...styles[style] },
    min_probability:    f.min_probability,
    shape:              f.shape,
    width_area_safety:  f.width_area_safety,
    height_area_safety: f.height_area_safety,
    border:  f.border ? { color: hexToRgb(f.border_color), thickness: f.border_thickness } : null,
    overlay: overlays[f.overlay_type] ?? null,
    inverse: f.inverse,
    clip_to: [...(f.clip_to ?? [])],
  };
}

/**
 * Backend censor box → flat censor box. Keys left out of `box` get the backend
 * defaults. Pass the merged box (see mergeBox) for feature overrides.
 */
function fromBackendBox(box) {
  const flat = cloneJson(BOX_DEFAULTS);
  if (!isObject(box)) return flat;

  const style = box.censor_style;
  if (isObject(style) && CENSOR_STYLES.includes(style.type)) {
    flat.censor_style = style.type;
    if (style.type === "blur"  && style.strength !== undefined) flat.blur_strength = style.strength;
    if (style.type === "pixel" && style.factor   !== undefined) flat.pixel_factor  = style.factor;
    if (style.type === "bar"   && style.color    !== undefined) flat.bar_color     = rgbToHex(style.color);
    if (style.type === "debug" && style.color    !== undefined) flat.debug_color   = rgbToHex(style.color);
  }

  for (const key of ["min_probability", "width_area_safety", "height_area_safety", "inverse"]) {
    if (box[key] !== undefined && box[key] !== null) flat[key] = box[key];
  }
  if (SHAPES.includes(box.shape)) flat.shape = box.shape;
  if (Array.isArray(box.clip_to)) flat.clip_to = [...box.clip_to];

  if (isObject(box.border)) {
    flat.border = true;
    if (box.border.thickness !== undefined) flat.border_thickness = box.border.thickness;
    if (box.border.color     !== undefined) flat.border_color     = rgbToHex(box.border.color);
  }

  const ov = box.overlay;
  if (isObject(ov) && (ov.type === "text" || ov.type === "sticker")) {
    flat.overlay_type = ov.type;
    if (ov.probability !== undefined) flat.overlay_probability = ov.probability;
    if (ov.type === "text") {
      if (ov.values     !== undefined) flat.overlay_values     = joinList(ov.values);
      if (ov.color      !== undefined) flat.overlay_color      = rgbToHex(ov.color);
      if (ov.thickness  !== undefined) flat.overlay_thickness  = ov.thickness;
      if (ov.font_scale !== undefined) flat.overlay_font_scale = ov.font_scale;
    } else {
      // `categories` is the deprecated form of `stickers`
      const entries = [
        ...(Array.isArray(ov.stickers)   ? ov.stickers   : []),
        ...(Array.isArray(ov.categories) ? ov.categories : []),
      ].map(String);
      flat.overlay_stickers = [...new Set(entries)];
    }
  }

  return flat;
}

// ── General settings conversion ───────────────────────────────────────────────

/** Flat general settings → backend top-level settings. */
function toBackendGeneral(flat) {
  const g = { ...GENERAL_DEFAULTS, ...flat };
  const styles = {
    blur:  { strength: g.inverse_blur_strength },
    pixel: { factor:   g.inverse_pixel_factor },
    bar:   { color:    hexToRgb(g.inverse_bar_color) },
  };
  const style = styles[g.inverse_censor_style] ? g.inverse_censor_style : GENERAL_DEFAULTS.inverse_censor_style;

  const out = {
    inverse_censor_style:      { type: style, ...styles[style] },
    force_inverse_censor:      g.force_inverse_censor,
    merge_overlapping_borders: g.merge_overlapping_borders,
    enable_overlays:           g.enable_overlays,
    enable_watermark:          g.enable_watermark,
  };
  if (g.stickers_dir && g.stickers_dir.trim()) out.stickers_dir = g.stickers_dir.trim();
  return out;
}

/** Backend top-level settings → flat general settings (missing keys → defaults). */
function fromBackendGeneral(cfg) {
  const flat = cloneJson(GENERAL_DEFAULTS);
  if (!isObject(cfg)) return flat;

  const style = cfg.inverse_censor_style;
  if (isObject(style) && INVERSE_CENSOR_STYLES.includes(style.type)) {
    flat.inverse_censor_style = style.type;
    if (style.type === "blur"  && style.strength !== undefined) flat.inverse_blur_strength = style.strength;
    if (style.type === "pixel" && style.factor   !== undefined) flat.inverse_pixel_factor  = style.factor;
    if (style.type === "bar"   && style.color    !== undefined) flat.inverse_bar_color     = rgbToHex(style.color);
  }

  for (const key of ["force_inverse_censor", "merge_overlapping_borders", "enable_overlays", "enable_watermark"]) {
    if (typeof cfg[key] === "boolean") flat[key] = cfg[key];
  }
  if (typeof cfg.stickers_dir === "string") flat.stickers_dir = cfg.stickers_dir;

  return flat;
}
