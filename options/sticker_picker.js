// ── Sticker picker ────────────────────────────────────────────────────────────
// A dialog to choose the stickers of a sticker overlay: folders (categories,
// subfolders included) and/or single images, as listed by GET /stickers.
// The selection is a list of paths relative to stickers_dir; [] = all stickers.
//
// Depends on: backend_api.js (fetchStickers), shared.js (state, $)

const STICKER_ROOT = "";

const parentDir = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : STICKER_ROOT;
const baseName  = path => path.slice(path.lastIndexOf("/") + 1);

/** All ancestor folders of a path, nearest first: "a/b/c.png" → ["a/b", "a"] */
function ancestorDirs(path) {
  const out = [];
  for (let dir = parentDir(path); dir !== STICKER_ROOT; dir = parentDir(dir)) out.push(dir);
  return out;
}

/** Builds the folder tree of a sticker listing. */
function buildStickerTree(listing) {
  const nodes = new Map();
  const node = path => {
    if (!nodes.has(path)) {
      nodes.set(path, { path, name: baseName(path), folders: [], stickers: [], total: 0 });
      if (path !== STICKER_ROOT) node(parentDir(path)).folders.push(nodes.get(path));
    }
    return nodes.get(path);
  };
  node(STICKER_ROOT);
  for (const c of listing.categories) node(c);
  for (const s of listing.stickers) {
    node(parentDir(s.path)).stickers.push(s);
    for (const dir of ancestorDirs(s.path)) node(dir).total++;   // every folder above it
  }
  nodes.get(STICKER_ROOT).total = listing.stickers.length;
  for (const n of nodes.values()) {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.stickers.sort((a, b) => a.path.localeCompare(b.path));
  }
  return nodes;
}

/** The stickers a selection picks from (all stickers when it is empty). */
function stickerPool(selected, listing) {
  if (!selected.length) return listing.stickers;
  const set = new Set(selected);
  return listing.stickers.filter(s => set.has(s.path) || ancestorDirs(s.path).some(d => set.has(d)));
}

/** Short description of a selection, e.g. "2 folders, 1 sticker". */
function describeStickerSelection(selected, listing = null) {
  if (!selected.length) return "All stickers";
  const folders = listing ? selected.filter(e => listing.categories.includes(e)).length
                          : selected.filter(e => !/\.[a-z0-9]+$/i.test(e)).length;
  const singles = listing ? selected.filter(e => listing.stickers.some(s => s.path === e)).length
                          : selected.length - folders;
  const missing = selected.length - folders - singles;
  const parts = [];
  if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  if (singles) parts.push(`${singles} sticker${singles === 1 ? "" : "s"}`);
  if (missing) parts.push(`${missing} missing`);
  return parts.join(", ");
}

// ── Field ─────────────────────────────────────────────────────────────────────

/** The "Stickers" field of a censor box: a summary button that opens the picker. */
function makeStickerField(id, cfg, onChange) {
  const { wrap, lbl } = makeField("Stickers");
  lbl.setAttribute("for", id);

  const btn = document.createElement("button");
  btn.id = id;
  btn.type = "button";
  btn.className = "btn-small sticker-field-btn";
  const update = () => { btn.textContent = `${describeStickerSelection(cfg.overlay_stickers ?? [])} — choose…`; };
  update();

  btn.addEventListener("click", async () => {
    const result = await openStickerPicker(cfg.overlay_stickers ?? []);
    if (result === null) return;
    cfg.overlay_stickers = result;
    update();
    onChange();
  });

  wrap.appendChild(btn);
  return wrap;
}

// ── Dialog ────────────────────────────────────────────────────────────────────

let stickerDialog = null;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function getStickerDialog() {
  if (stickerDialog) return stickerDialog;

  const dlg = el("dialog", "sticker-dialog");
  dlg.innerHTML = `
    <div class="sp-head">
      <div class="sp-title">
        <p class="card-label">Stickers</p>
        <span class="sp-dir"></span>
      </div>
      <input type="search" class="sp-search cfg-input" placeholder="Search…" spellcheck="false" />
    </div>
    <div class="sp-body">
      <div class="sp-list" tabindex="-1"></div>
      <aside class="sp-preview"></aside>
    </div>
    <div class="sp-missing"></div>
    <div class="sp-foot">
      <span class="sp-summary"></span>
      <div class="sp-actions">
        <button type="button" class="btn-small sp-clear">Clear</button>
        <button type="button" class="btn-small sp-cancel">Cancel</button>
        <button type="button" class="btn-small sp-done">Done</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  stickerDialog = dlg;
  return dlg;
}

/**
 * Opens the picker with `selected` and resolves with the new selection,
 * or null when it is cancelled.
 */
function openStickerPicker(selected) {
  const dlg = getStickerDialog();
  const q = sel => dlg.querySelector(sel);
  const list = q(".sp-list"), preview = q(".sp-preview"), missingBox = q(".sp-missing");
  const search = q(".sp-search"), summary = q(".sp-summary");

  const sel = new Set(selected);
  let listing = null;      // GET /stickers result, null while loading / on error
  let tree = null;
  let focused = null;      // { kind: "folder" | "sticker", path }
  const rows = new Map();  // path → { row, cb, kind, children?, chevron? }

  // ── Selection rules ──
  const impliedBy = path => ancestorDirs(path).find(d => sel.has(d)) ?? null;
  const known = path => listing && (listing.categories.includes(path) || listing.stickers.some(s => s.path === path));

  function toggle(path, on) {
    if (on) {
      sel.add(path);
      // A folder covers everything below it; drop the now redundant entries.
      for (const e of [...sel]) if (e.startsWith(path + "/")) sel.delete(e);
    } else {
      sel.delete(path);
    }
    refresh();
  }

  // ── Rendering ──
  function setFocus(kind, path) {
    focused = { kind, path };
    for (const [p, r] of rows) r.row.classList.toggle("focused", p === path);
    renderPreview();
  }

  function stickerRow(s, depth) {
    const row = el("div", "sp-row sp-sticker");
    row.style.setProperty("--depth", depth);
    row.tabIndex = 0;
    const cb = el("input"); cb.type = "checkbox";
    const img = el("img", "sp-thumb"); img.loading = "lazy"; img.alt = ""; img.src = s.url;
    const name = el("span", "sp-name", baseName(s.path));
    row.append(cb, img, name);
    cb.addEventListener("click", e => e.stopPropagation());
    cb.addEventListener("change", () => { toggle(s.path, cb.checked); setFocus("sticker", s.path); });
    row.addEventListener("click", () => setFocus("sticker", s.path));
    row.addEventListener("keydown", e => {
      if (e.key === " " && !cb.disabled) { e.preventDefault(); cb.click(); }
    });
    rows.set(s.path, { row, cb, kind: "sticker" });
    return row;
  }

  function folderBlock(node, depth, expanded) {
    const block = el("div", "sp-folder");
    const row = el("div", "sp-row sp-folder-row");
    row.style.setProperty("--depth", depth);
    row.tabIndex = 0;
    const chevron = el("button", "sp-chevron");
    chevron.type = "button";
    chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="9 6 15 12 9 18"/></svg>`;
    const cb = el("input"); cb.type = "checkbox";
    const name = el("span", "sp-name", node.name + "/");
    const count = el("span", "sp-count", String(node.total));
    row.append(chevron, cb, name, count);

    const children = el("div", "sp-children");
    for (const f of node.folders) children.appendChild(folderBlock(f, depth + 1, false));
    for (const s of node.stickers) children.appendChild(stickerRow(s, depth + 1));

    const setOpen = open => { block.classList.toggle("open", open); };
    setOpen(expanded);
    chevron.addEventListener("click", e => { e.stopPropagation(); setOpen(!block.classList.contains("open")); });
    cb.addEventListener("click", e => e.stopPropagation());
    cb.addEventListener("change", () => { toggle(node.path, cb.checked); setFocus("folder", node.path); });
    row.addEventListener("click", () => setFocus("folder", node.path));
    row.addEventListener("keydown", e => {
      if (e.key === " " && !cb.disabled) { e.preventDefault(); cb.click(); }
      if (e.key === "ArrowRight") setOpen(true);
      if (e.key === "ArrowLeft")  setOpen(false);
    });

    block.append(row, children);
    rows.set(node.path, { row, cb, kind: "folder", block, setOpen });
    return block;
  }

  function renderList() {
    list.innerHTML = "";
    rows.clear();
    if (!listing) return;
    const root = tree.get(STICKER_ROOT);
    if (!listing.stickers.length) {
      list.appendChild(el("p", "sp-empty", "No stickers found in this folder on the server."));
      return;
    }
    // Open the folders that contain a selected entry.
    const openDirs = new Set([...sel].flatMap(ancestorDirs));
    for (const f of root.folders) list.appendChild(folderBlock(f, 0, false));
    for (const s of root.stickers) list.appendChild(stickerRow(s, 0));
    for (const dir of openDirs) rows.get(dir)?.setOpen(true);
  }

  function renderPreview() {
    preview.innerHTML = "";
    if (!listing || !focused) {
      preview.appendChild(el("p", "sp-hint",
          listing ? "Select a sticker or folder to preview it." : ""));
      return;
    }
    const { kind, path } = focused;
    const via = impliedBy(path);
    const status = sel.has(path) ? "Selected" : via ? `Included via ${via}/` : "Not selected";

    if (kind === "sticker") {
      const s = listing.stickers.find(x => x.path === path);
      const frame = el("div", "sp-preview-frame");
      const img = el("img", "sp-preview-img"); img.alt = path; img.src = s.url;
      const dims = el("span", "sp-preview-meta", "");
      img.addEventListener("load", () => { dims.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; });
      frame.appendChild(img);
      preview.append(frame, el("p", "sp-preview-path", path), dims);
    } else {
      const node = tree.get(path);
      const mosaic = el("div", "sp-mosaic");
      const pool = stickerPool([path], listing);
      for (const s of pool.slice(0, 9)) {
        const img = el("img"); img.alt = ""; img.loading = "lazy"; img.src = s.url;
        mosaic.appendChild(img);
      }
      preview.append(mosaic, el("p", "sp-preview-path", path + "/"),
          el("span", "sp-preview-meta", `${node.total} image${node.total === 1 ? "" : "s"}, subfolders included`));
    }

    const statusEl = el("p", "sp-preview-status" + (sel.has(path) || via ? " on" : ""), status);
    const btn = el("button", "btn-small", sel.has(path) ? "Remove" : "Use this " + (kind === "folder" ? "folder" : "sticker"));
    btn.type = "button";
    btn.disabled = Boolean(via);
    btn.addEventListener("click", () => toggle(path, !sel.has(path)));
    preview.append(statusEl, btn);
  }

  function renderMissing() {
    missingBox.innerHTML = "";
    const entries = [...sel].filter(e => !known(e)).sort();
    if (!entries.length) { missingBox.style.display = "none"; return; }
    missingBox.style.display = "";
    missingBox.appendChild(el("p", "sp-missing-label",
        listing ? "Not found on the server (skipped when censoring)" : "Saved selection"));
    for (const e of entries) {
      const chip = el("span", "sp-chip", e);
      const x = el("button", "sp-chip-x", "×");
      x.type = "button";
      x.title = `Remove ${e}`;
      x.addEventListener("click", () => toggle(e, false));
      chip.appendChild(x);
      missingBox.appendChild(chip);
    }
  }

  function refresh() {
    for (const [path, r] of rows) {
      const via = impliedBy(path);
      r.cb.checked  = sel.has(path) || Boolean(via);
      r.cb.disabled = Boolean(via);
      r.row.classList.toggle("implied", Boolean(via));
      r.row.title = via ? `Included via ${via}/` : "";
    }
    applySearch();
    renderMissing();
    renderPreview();

    const desc = describeStickerSelection([...sel], listing);
    summary.textContent = !sel.size
        ? "Nothing selected: all stickers are used"
        : listing ? `${desc} · ${stickerPool([...sel], listing).length} images` : desc;
  }

  function applySearch() {
    const term = search.value.trim().toLowerCase();
    if (!tree) return;
    const visit = node => {
      let any = false;
      for (const f of node.folders) any = visit(f) || any;
      for (const s of node.stickers) {
        const show = !term || s.path.toLowerCase().includes(term);
        rows.get(s.path).row.style.display = show ? "" : "none";
        any = any || show;
      }
      if (node.path !== STICKER_ROOT) {
        const r = rows.get(node.path);
        const show = !term || any || node.path.toLowerCase().includes(term);
        r.block.style.display = show ? "" : "none";
        if (term) r.setOpen(any);
        return show;
      }
      return any;
    };
    visit(tree.get(STICKER_ROOT));
  }

  // ── Open ──
  search.value = "";
  focused = null;
  const dir = state.general?.stickers_dir || "";
  q(".sp-dir").textContent = dir;
  list.innerHTML = "";
  list.appendChild(el("p", "sp-empty", "Loading stickers…"));
  refresh();

  fetchStickers(state.baseUrl, dir).then(result => {
    listing = result;
    tree = buildStickerTree(listing);
    q(".sp-dir").textContent = listing.stickersDir;
    renderList();
    refresh();
  }).catch(err => {
    list.innerHTML = "";
    list.appendChild(el("p", "sp-empty sp-error", `Could not load stickers: ${err.message}`));
    refresh();
  });

  search.oninput = applySearch;

  return new Promise(resolve => {
    const finish = value => {
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    q(".sp-clear").onclick  = () => { sel.clear(); refresh(); };
    q(".sp-cancel").onclick = () => finish(null);
    q(".sp-done").onclick   = () => finish([...sel].sort());
    dlg.onclose = () => finish(null);   // Escape
    dlg.showModal();
    search.focus();
  });
}
