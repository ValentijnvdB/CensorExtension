

// ── Blur ────────────────────────────────────────────────────────

const BLUR_STRENGTH = 30;


function applyBlur(img) {
    img.style.filter=`blur(${BLUR_STRENGTH}px)`
}


function reverseBlur(img) {
    img.style.filter=""
}


// ── Pixelate ────────────────────────────────────────────────────────
//
// Done with an SVG filter referenced from CSS, like blur: the browser renders
// it, so there is no pixel work in JS, no canvas tainting on cross-origin
// images, it shows before the image finishes loading, and undoing it is just
// clearing the style. How it works: keep one source pixel per block (a 1px dot
// tiled every PIXELATE_STRENGTH px, intersected with the image), then dilate
// each dot to fill its block.

const PIXELATE_STRENGTH = 20;
const PIXELATE_FILTER_ID = "__image-censor-pixelate";
const SVG_NS = "http://www.w3.org/2000/svg";

function ensurePixelateFilter() {
    if (document.getElementById(PIXELATE_FILTER_ID)) return;

    const s    = PIXELATE_STRENGTH;
    const half = Math.floor(s / 2);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    // Not display:none: some browsers then ignore filters inside it.
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    const el = (tag, attrs) => {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
        return node;
    };

    const filter = el("filter", {
        id: PIXELATE_FILTER_ID, x: 0, y: 0, width: 1, height: 1,
        "color-interpolation-filters": "sRGB",
    });
    filter.append(
        el("feFlood",     { x: half, y: half, width: 1, height: 1, result: "dot" }),
        el("feComposite", { in: "dot", in2: "dot", x: 0, y: 0, width: s, height: s, result: "cell" }),
        el("feTile",      { in: "cell", result: "grid" }),
        el("feComposite", { in: "SourceGraphic", in2: "grid", operator: "in" }),
        el("feMorphology",{ operator: "dilate", radius: half }),
    );
    svg.appendChild(filter);

    (document.body || document.documentElement).appendChild(svg);
}

function applyPixelate(img) {
    ensurePixelateFilter();
    img.style.filter = `url(#${PIXELATE_FILTER_ID})`;
}

function reversePixelate(img) {
    img.style.filter = "";
}


// ── Main functions ────────────────────────────────────────────────────────

function applyLoadBehavior(img) {
    if (settings.loadBehavior === 'blur') {
        applyBlur(img);
    } else if (settings.loadBehavior === 'pixelate') {
        applyPixelate(img);
    } else {
        setSrc(img, browser.runtime.getURL("assets/loading.png"))
    }
}

function reverseLoadBehavior(img) {
    if (settings.loadBehavior === 'blur') {
        reverseBlur(img);
    } else if (settings.loadBehavior === 'pixelate') {
        reversePixelate(img);
    }
}