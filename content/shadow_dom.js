/**
 * shadow_dom.js – Finding videos inside shadow roots
 *
 * document.querySelectorAll() and a MutationObserver on the document don't
 * see into shadow roots, where sites built from web components keep their
 * <video> (e.g. Reddit's player). Firefox gives content scripts
 * `openOrClosedShadowRoot`, which also opens closed roots.
 *
 *   findVideosDeep(root) – every <video> under root, through nested shadow
 *                          roots; each shadow root it passes is reported to
 *                          onShadowRoot (content.js observes it).
 *   hookAttachShadow()   – reports shadow roots the page creates from now on.
 *                          Runs at document_start, before the page's scripts.
 *
 * Only videos are looked for in shadow roots; images there are not censored.
 */

/** Set by content.js: called once for each shadow root found. */
let onShadowRoot = null;

const _knownShadowRoots = new WeakSet();

/** The element's shadow root (closed ones too), or null. */
function shadowRootOf(el) {
    try {
        return el.openOrClosedShadowRoot ?? el.shadowRoot ?? null;
    } catch {
        return null;
    }
}

function _reportShadowRoot(root) {
    if (_knownShadowRoots.has(root)) return;
    _knownShadowRoots.add(root);
    onShadowRoot?.(root);
}

/**
 * Every <video> in `root` (a document, element or shadow root), including
 * `root` itself and those inside nested shadow roots.
 */
function findVideosDeep(root) {
    const videos = [];
    const visit = (scope) => {
        const elements = scope.nodeType === Node.ELEMENT_NODE
            ? [scope, ...scope.querySelectorAll("*")]
            : scope.querySelectorAll("*");
        for (const el of elements) {
            if (el.tagName === "VIDEO") videos.push(el);
            const shadow = shadowRootOf(el);
            if (shadow) {
                _reportShadowRoot(shadow);
                visit(shadow);
            }
        }
    };
    visit(root);
    return videos;
}

/**
 * Wraps the page's Element.prototype.attachShadow so every shadow root the
 * page creates is reported, also those of elements not in the document yet.
 * The root is still empty then: its content arrives as mutations.
 */
function hookAttachShadow() {
    const pageWindow = window.wrappedJSObject;
    if (!pageWindow || typeof exportFunction !== "function") return;
    const proto    = pageWindow.Element.prototype;
    const original = proto.attachShadow;
    if (typeof original !== "function") return;

    exportFunction(function attachShadow(init) {
        const root = original.call(this, init);
        try {
            // `this` is the page's view of the host; the Xray view has openOrClosedShadowRoot.
            const shadow = shadowRootOf(XPCNativeWrapper(this));
            if (shadow) _reportShadowRoot(shadow);
        } catch (err) {
            console.debug("[VideoCensor] Couldn't follow a new shadow root:", err);
        }
        return root;
    }, proto, { defineAs: "attachShadow" });
}

hookAttachShadow();
