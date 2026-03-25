// ── Settings reader ───────────────────────────────────────────────────────────
// Reads the config from browser.storage.local and returns a structured object.
// Can be imported independently — has no dependency on the options page scripts.

const READER_GENERAL_DEFAULTS = {
  force_inverse_censor:           false,
  inverse_censor_style:           "blur",
  inverse_blur_strength:          31,
  inverse_pixel_factor:           20,
  inverse_bar_color:              "#000000",
  enable_overlays:                true,
  enable_watermark:               false,
  merge_overlapping_censor_boxes: true,
  merge_overlapping_borders:      true,
};

const READER_CONFIG_DEFAULTS = {
  censor_style:       "blur",
  blur_strength:      31,
  pixel_factor:       20,
  bar_color:          "#000000",
  overlay_prob:       0.5,
  border:             false,
  border_thickness:   2,
  border_color:       "#ff0000",
  inverse:            false,
  intersect_human:          false,
  shape:              "default",
  min_prob:           0.5,
  width_area_safety:  0.1,
  height_area_safety: 0.1,
  time_safety:        0.0,
  overlay_type:       "off",
  overlay_values:     "",
  overlay_color:      "#000000",
  overlay_font_scale: 2.2,
  overlay_categories: "",
};

const READER_FEATURES = [
  'exposed_anus',
  'exposed_vulva',
  'exposed_breast',
  'exposed_buttocks',
  'covered_vulva',
  'covered_breast',
  'covered_buttocks',
  'face_femme',
  'exposed_belly',
  'covered_belly',
  'exposed_feet',
  'covered_feet',
  'exposed_armpits',
  'exposed_penis',
  'exposed_chest',
  'face_masc',
  'eyes_femme',
  'eyes_masc',
];

/**
 * Parses a comma-separated string into a trimmed, non-empty array of strings.
 */
function parseList(str) {
  return (str ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Converts a hex color string (e.g. "#ff0000") to an [B, G, R] array (0–255).
 */
function hexToBGR(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [b, g, r];
}

/**
 * Reshapes a flat stored config object into the structured output format.
 */
function reshapeConfig(flat) {
  const D = READER_CONFIG_DEFAULTS;

  // censor_style sub-object — only include the relevant style field
  const style = flat.censor_style ?? D.censor_style;
  const styleDetails = {
    blur:  { strength:  flat.blur_strength ?? D.blur_strength },
    pixel: { factor:    flat.pixel_factor  ?? D.pixel_factor  },
    bar:   { color:     hexToBGR(flat.bar_color ?? D.bar_color) },
  };

  // overlay sub-object — null if off, otherwise only the relevant fields
  const overlayType = flat.overlay_type ?? D.overlay_type;
  const overlayDetails = {
    text: {
      type:        "text",
      probability: flat.overlay_prob ?? D.overlay_prob,
      values:      parseList(flat.overlay_values ?? D.overlay_values),
      color:       hexToBGR(flat.overlay_color ?? D.overlay_color),
      font_scale:  flat.overlay_font_scale ?? D.overlay_font_scale,
    },
    sticker: {
      type:        "sticker",
      probability: flat.overlay_prob ?? D.overlay_prob,
      categories:  parseList(flat.overlay_categories ?? D.overlay_categories),
    },
  };

  return {
    censor_style: {
      type: style,
      ...styleDetails[style],
    },
    border: flat.border
        ? { thickness: flat.border_thickness ?? D.border_thickness,
          color:     hexToBGR(flat.border_color ?? D.border_color) }
        : null,
    overlay: overlayType === "off" ? null : overlayDetails[overlayType],
    inverse:            flat.inverse            ?? D.inverse,
    intersect_human:    flat.intersect_human    ?? D.intersect_human,
    shape:              flat.shape              ?? D.shape,
    min_prob:           flat.min_prob           ?? D.min_prob,
    width_area_safety:  flat.width_area_safety  ?? D.width_area_safety,
    height_area_safety: flat.height_area_safety ?? D.height_area_safety,
    time_safety:        flat.time_safety        ?? D.time_safety,
  };
}

/**
 * Reshapes the flat general settings object into the structured output format.
 */
function reshapeGeneral(g) {
  const D = READER_GENERAL_DEFAULTS;
  const style = g.inverse_censor_style ?? D.inverse_censor_style;
  const styleDetails = {
    blur:  { strength: g.inverse_blur_strength ?? D.inverse_blur_strength },
    pixel: { factor:   g.inverse_pixel_factor  ?? D.inverse_pixel_factor  },
    bar:   { color:    hexToBGR(g.inverse_bar_color ?? D.inverse_bar_color) },
  };

  return {
    force_inverse_censor: g.force_inverse_censor ?? D.force_inverse_censor,
    inverse_censor_style: g.force_inverse_censor
        ? { type: style, ...styleDetails[style] }
        : null,
    enable_overlays:                g.enable_overlays                ?? D.enable_overlays,
    enable_watermark:               g.enable_watermark               ?? D.enable_watermark,
    merge_overlapping_censor_boxes: g.merge_overlapping_censor_boxes ?? D.merge_overlapping_censor_boxes,
    merge_overlapping_borders:      g.merge_overlapping_borders      ?? D.merge_overlapping_borders,
  };
}

/**
 * Reads saved settings from storage and returns them as:
 * {
 *   force_inverse_censor:           bool,
 *   inverse_censor_style:           object | null,
 *   enable_overlays:                bool,
 *   enable_watermark:               bool,
 *   merge_overlapping_censor_boxes: bool,
 *   merge_overlapping_borders:      bool,
 *   features_to_censor:             string[],
 *   default_censor_config:          object,
 *   feature_overrides:              { [feature]: object }
 * }
 */
async function readCensorSettings() {
  let raw = null;

  try {
    const result = await browser.storage.local.get({ appState: null });
    if (result.appState) {
      raw = JSON.parse(result.appState);
    }
  } catch { /* fall through to defaults */ }

  const flatDefaults = raw?.defaults ?? { ...READER_CONFIG_DEFAULTS };
  const flatGeneral  = raw?.general  ?? {};

  const features_to_censor = [];
  const feature_overrides  = {};

  for (const featureId of READER_FEATURES) {
    const fState = raw?.features?.[featureId];

    const enabled    = fState?.enabled    ?? true;
    const useDefault = fState?.useDefault ?? true;

    if (enabled) {
      features_to_censor.push(featureId);
    }

    if (!useDefault && fState?.config) {
      feature_overrides[featureId] = reshapeConfig(fState.config);
    }
  }

  return {
    ...reshapeGeneral(flatGeneral),
    features_to_censor,
    default_censor_config: reshapeConfig(flatDefaults),
    feature_overrides,
  };
}