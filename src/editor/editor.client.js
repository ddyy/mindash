
"use strict";
const state = JSON.parse(document.getElementById("editor-state").textContent);
let draft = JSON.parse(JSON.stringify(state.doc));
let baseVersion = state.version;
let selected = null; // {kind:"widget"|"column"|"page", pageIdx, colIdx?, wid?}
let pageIdx = (() => {
  const m = /#p=([0-9]+)/.exec(location.hash);
  const i = m ? Number(m[1]) : 0;
  return i >= 0 && i < state.doc.pages.length ? i : 0;
})();
let dirty = false;
// restore the inspector selection a reload would otherwise lose
(() => {
  const m = /;s=(w:[^;&]+|r:[0-9]+|c:[0-9]+.[0-9]+|pg)/.exec(location.hash);
  // No remembered selection means arriving fresh - most often the
  // dashboard's Edit link, which names a page and nothing finer. Open on
  // that page's own settings rather than an empty inspector.
  if (!m) {
    selected = { kind: "page", pageIdx };
    return;
  }
  const tok = m[1];
  const page = state.doc.pages[pageIdx];
  if (tok === "pg") selected = { kind: "page", pageIdx };
  else if (tok.startsWith("w:")) {
    const wid = tok.slice(2);
    const exists = state.doc.pages.some((pg) => pg.rows.some((r) => r.columns.some((c) => c.widgets.some((w) => w.id === wid))));
    if (exists) selected = { kind: "widget", wid };
  } else if (tok.startsWith("r:")) {
    const ri = Number(tok.slice(2));
    if (page && ri < page.rows.length) selected = { kind: "row", rowIdx: ri };
  } else if (tok.startsWith("c:")) {
    const bits = tok.slice(2).split(".");
    const ri = Number(bits[0]);
    const ci = Number(bits[1]);
    if (page && page.rows[ri] && ci < page.rows[ri].columns.length) {
      selected = { kind: "column", pageIdx, rowIdx: ri, colIdx: ci };
    }
  }
})();
let tmpCounter = 0;
const undoStack = [];
const formsByType = Object.fromEntries(state.forms.map((f) => [f.type, f]));

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function findWidget(id) {
  for (let pi = 0; pi < draft.pages.length; pi++) {
    const p = draft.pages[pi];
    for (let ri = 0; ri < p.rows.length; ri++) {
      const cols = p.rows[ri].columns;
      for (let ci = 0; ci < cols.length; ci++) {
        const wi = cols[ci].widgets.findIndex((w) => w.id === id);
        if (wi !== -1) return { pageIdx: pi, rowIdx: ri, colIdx: ci, idx: wi, widget: cols[ci].widgets[wi] };
      }
    }
  }
  return null;
}

// Handlers mutate the draft BEFORE calling changed(), so snapshotting the
// live draft would push the post-mutation state (first Undo = no-op).
// lastStable always holds the pre-mutation serialization: snapshot pushes
// it, then re-captures. Reset it wherever the draft is wholesale replaced.
let lastStable = JSON.stringify(draft); // pre-mutation serialization
function snapshot() {
  undoStack.push(lastStable);
  $("undo-btn").disabled = false;
  lastStable = JSON.stringify(draft);
  if (undoStack.length > 60) undoStack.shift();
}
let draftRev = 0; // bumps on every dirtying edit; guards mid-save edits
function markDirty() {
  dirty = true;
  draftRev++;
  $("dirty").textContent = "unsaved changes";
  $("save-btn").disabled = false;
}
function changed(instant) {
  snapshot();
  markDirty();
  renderAll();
  if (instant) {
    clearTimeout(previewTimer);
    refreshPreview();
  } else {
    schedulePreview();
  }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Stable row labels: letters assigned at creation so a swapped row keeps
// its identity ("Row B" stays Row B wherever it lands).
function rowLetter(i) {
  let out = "";
  do { out = String.fromCharCode(65 + (i % 26)) + out; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return out;
}
function nextRowName() {
  const used = new Set();
  for (const pg of draft.pages) for (const r of pg.rows) if (r.name) used.add(r.name);
  for (let i = 0; ; i++) {
    const cand = "Row " + rowLetter(i);
    if (!used.has(cand)) return cand;
  }
}
function newRow(widgets) {
  return { name: nextRowName(), columns: [{ width: "full", widgets: widgets || [] }] };
}
function rowLabelOf(row, ri) {
  return row.name || "Row " + (ri + 1);
}

// Exit lands on the page being edited - same slug rules as the server's
// pageSlugs (kebab-cased names, deduped by position).
function pagePath(idx) {
  if (idx === 0) return "/";
  const seen = new Set();
  let target = "/";
  draft.pages.forEach((p, i) => {
    let slug = (p.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page-" + (i + 1);
    if (seen.has(slug)) slug = slug + "-" + (i + 1);
    seen.add(slug);
    if (i === idx) target = "/p/" + encodeURIComponent(slug);
  });
  return target;
}

function updateExitLink() {
  // Both exits follow the page being edited: the Dashboard pill, and the
  // Edit pill, which toggles back out to the same place.
  for (const sel of ["#nav-dashboard", "#nav-edit"]) {
    const a = document.querySelector(sel);
    if (a) a.href = pagePath(pageIdx);
  }
}


// MCP widgets: the description field carries the query ("tool · args").
// It prefills on add and follows tool/args edits until the user writes
// their own text (same auto-follow pattern as clock labels).
function mcpQueryText(w) {
  const args = w.args && Object.keys(w.args).length ? " · " + JSON.stringify(w.args).slice(0, 120) : "";
  return (w.tool || "") + args;
}
function syncMcpDescription(w, oldAuto) {
  if (!w.description || w.description === oldAuto) {
    const next = mcpQueryText(w);
    if (next) w.description = next;
    else delete w.description;
  }
}

// ---------- page tabs ----------
let draggedPageIdx = null;

function movePage(from, to) {
  if (from === to || from < 0 || to < 0 || from >= draft.pages.length || to > draft.pages.length) return;
  const viewed = draft.pages[pageIdx];
  const [moved] = draft.pages.splice(from, 1);
  draft.pages.splice(Math.min(to, draft.pages.length), 0, moved);
  pageIdx = draft.pages.indexOf(viewed);
  if (selected && selected.kind === "page") selected = { kind: "page", pageIdx: draft.pages.indexOf(moved) };
  changed();
}

function renderTabs() {
  const tabs = $("page-tabs");
  tabs.textContent = "";
  draft.pages.forEach((p, i) => {
    const b = el("button", null, p.name);
    b.setAttribute("aria-selected", String(i === pageIdx));
    b.title = "Drag to reorder - the first page serves at / (Shift+arrows also move it)";
    // Only PUBLIC pages carry a marker: private is the default, so an
    // unmarked dashboard stays quiet and anything exposed stands out.
    // The state rides in the accessible name too - a glyph alone would
    // leave it invisible to screen readers.
    if (p.public === true) {
      const indexed = p.indexable === true;
      const badge = el("span", "tab-public", "\u{1F310}");
      // The badge owns the visibility tooltip so the button keeps its
      // drag hint; aria-hidden because the button's label already says it.
      badge.title = indexed
        ? "Public - anyone with the URL can view it, and search engines may list it"
        : "Public - anyone with the URL can view it";
      badge.setAttribute("aria-hidden", "true");
      b.appendChild(badge);
      b.setAttribute("aria-label", p.name + (indexed ? ", public and indexed by search engines" : ", public"));
    }
    b.addEventListener("click", () => {
      if (i === pageIdx) {
        selected = { kind: "page", pageIdx: i };
        renderInspector();
      } else {
        pageIdx = i;
        selected = { kind: "page", pageIdx: i };
        renderAll();
        schedulePreview();
      }
    });
    // drag to reorder; Shift+arrows as the non-dragging equivalent
    b.draggable = true;
    b.addEventListener("dragstart", (e) => {
      draggedPageIdx = i;
      b.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    b.addEventListener("dragend", () => {
      draggedPageIdx = null;
      b.classList.remove("dragging");
    });
    b.addEventListener("dragover", (e) => {
      if (draggedPageIdx === null || draggedPageIdx === i) return;
      e.preventDefault();
      b.classList.add("drop-hover");
    });
    b.addEventListener("dragleave", () => b.classList.remove("drop-hover"));
    b.addEventListener("drop", (e) => {
      e.preventDefault();
      b.classList.remove("drop-hover");
      if (draggedPageIdx === null || draggedPageIdx === i) return;
      movePage(draggedPageIdx, i);
      draggedPageIdx = null;
    });
    b.addEventListener("keydown", (e) => {
      if (!e.shiftKey) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); movePage(i, i - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); movePage(i, i + 1); }
    });
    tabs.appendChild(b);
  });
  updateExitLink();
  // keep the active tab reachable when the strip scrolls (many pages, or
  // a reorder that moved it out of view)
  const active = tabs.querySelector('[aria-selected="true"]');
  if (active) active.scrollIntoView({ inline: "nearest", block: "nearest" });
  const add = el("button", "ol-mini", "+ page");
  add.addEventListener("click", () => {
    draft.pages.push({ name: "Page " + (draft.pages.length + 1), rows: [newRow()] });
    pageIdx = draft.pages.length - 1;
    selected = { kind: "page", pageIdx };
    changed();
  });
  tabs.appendChild(add);
}

// ---------- outline ----------
function moveWidget(id, dir) {
  const loc = findWidget(id);
  if (!loc) return;
  const row = draft.pages[loc.pageIdx].rows[loc.rowIdx];
  const col = row.columns[loc.colIdx];
  if (dir === "up" || dir === "down") {
    const j = dir === "up" ? loc.idx - 1 : loc.idx + 1;
    if (j < 0 || j >= col.widgets.length) return;
    [col.widgets[loc.idx], col.widgets[j]] = [col.widgets[j], col.widgets[loc.idx]];
  } else {
    const cj = dir === "left" ? loc.colIdx - 1 : loc.colIdx + 1;
    if (cj < 0 || cj >= row.columns.length) return;
    col.widgets.splice(loc.idx, 1);
    row.columns[cj].widgets.push(loc.widget);
  }
  changed();
}

function renderOutline() {
  const root = $("outline");
  root.textContent = "";
  const page = draft.pages[pageIdx];
  if (!page) return;
  const pageHead = el("div", "ol-page");
  const pageLabel = el("strong", null, page.name);
  pageLabel.style.cursor = "pointer";
  pageLabel.title = "Edit page";
  pageLabel.tabIndex = 0;
  pageLabel.setAttribute("role", "button");
  const selPage = () => { selected = { kind: "page", pageIdx }; renderAll(); };
  pageLabel.addEventListener("click", selPage);
  pageLabel.addEventListener("keydown", (e) => { if (e.key === "Enter") selPage(); });
  pageHead.appendChild(pageLabel);
  root.appendChild(pageHead);

  page.rows.forEach((row, ri) => {
    const rowBox = el("div", "ol-row");
    const rowHead = el("div", "ol-col-head" + (selected?.kind === "row" && selected.rowIdx === ri ? " selected" : ""));
    const rowLabel = el("strong", "t", rowLabelOf(row, ri) + (row.title ? " · " + row.title : ""));
    rowLabel.style.cursor = "pointer";
    rowLabel.addEventListener("click", () => { selected = { kind: "row", rowIdx: ri }; renderAll(); highlightPreview(); });
    rowHead.appendChild(rowLabel);
    const addColBtn = el("button", "ol-mini", "+ col");
    addColBtn.title = "Add column to row " + (ri + 1);
    addColBtn.addEventListener("click", () => {
      row.columns.push({ width: "1/2", widgets: [] });
      pendingEnter = '.row[data-row="' + ri + '"] .col[data-col="' + (row.columns.length - 1) + '"]';
      changed(true);
    });
    rowHead.appendChild(addColBtn);
    for (const [sym, delta, lbl] of [["↑", -1, "Move row up"], ["↓", 1, "Move row down"]]) {
      const mv = el("button", "ol-mini", sym);
      mv.title = lbl;
      mv.setAttribute("aria-label", lbl + ": row " + (ri + 1));
      mv.disabled = ri + delta < 0 || ri + delta >= page.rows.length;
      mv.addEventListener("click", (e) => { e.stopPropagation(); moveRowStep(ri, delta); });
      rowHead.appendChild(mv);
    }
    if (page.rows.length > 1) {
      const delRow = el("button", "ol-mini ol-del", "✕");
      delRow.title = "Delete row " + (ri + 1);
      delRow.addEventListener("click", (e) => { e.stopPropagation(); deleteRowAt(ri); });
      rowHead.appendChild(delRow);
    }
    rowBox.appendChild(rowHead);

    row.columns.forEach((col, ci) => {
    const colBox = el("div", "ol-col");
    const head = el("div", "ol-col-head" + (selected?.kind === "column" && selected.rowIdx === ri && selected.colIdx === ci ? " selected" : ""));
    const title = el("span", "t", "Column " + (ci + 1) + " (" + col.width + ")" + (col.title ? " · " + col.title : ""));
    title.style.cursor = "pointer";
    title.addEventListener("click", () => {
      selected = { kind: "column", pageIdx, rowIdx: ri, colIdx: ci };
      renderAll();
    });
    head.appendChild(title);
    if (row.columns.length > 1) {
      const delCol = el("button", "ol-mini ol-del", "✕");
      delCol.title = "Delete column " + (ci + 1);
      delCol.addEventListener("click", (e) => { e.stopPropagation(); deleteColumnAt(ri, ci); });
      head.appendChild(delCol);
    }
    colBox.appendChild(head);

    col.widgets.forEach((w) => {
      const row = el("div", "ol-widget" + (selected?.wid === w.id ? " selected" : ""));
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      const text = el("span", "ol-w-text");
      const tIcon = formsByType[w.type] && formsByType[w.type].icon;
      text.appendChild(el("span", "t", (tIcon ? tIcon + " " : "") + widgetTitle(w)));
      text.appendChild(el("span", "ty", w.type));
      row.appendChild(text);
      const wIdx = col.widgets.indexOf(w);
      const canMove = { up: wIdx > 0, down: wIdx < col.widgets.length - 1, left: ci > 0, right: ci < page.rows[ri].columns.length - 1 };
      for (const [sym, dir, label] of [["\u2191", "up", "Move up"], ["\u2193", "down", "Move down"], ["\u2190", "left", "Move to previous column"], ["\u2192", "right", "Move to next column"]]) {
        const b = el("button", "ol-mini", sym);
        b.title = label;
        b.disabled = !canMove[dir];
        b.setAttribute("aria-label", label + ": " + widgetTitle(w));
        b.addEventListener("click", (e) => { e.stopPropagation(); moveWidget(w.id, dir); });
        row.appendChild(b);
      }
      const qd = el("button", "ol-mini ol-del", "✕");
      qd.title = "Delete widget";
      qd.setAttribute("aria-label", "Delete " + widgetTitle(w));
      qd.addEventListener("click", (e) => { e.stopPropagation(); deleteWidgetById(w.id); });
      row.appendChild(qd);
      const sel = () => { selected = { kind: "widget", wid: w.id }; renderAll(); highlightPreview(); };
      row.addEventListener("click", sel);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sel(); } });
      colBox.appendChild(row);
    });

    const addW = el("button", "ol-mini ol-add", "+ widget");
    addW.addEventListener("click", () => openGallery(ri, ci));
    colBox.appendChild(addW);
    rowBox.appendChild(colBox);
    });
    root.appendChild(rowBox);
  });

  const addRow = el("button", "ol-mini ol-add", "+ row");
  addRow.addEventListener("click", () => {
    page.rows.push(newRow());
    pendingEnter = '.row[data-row="' + (page.rows.length - 1) + '"]';
    changed(true);
  });
  root.appendChild(addRow);
}

// ---------- preview ----------
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 350);
}
// FLIP keys: widgets by id; rows/cols by their contained widget ids, so
// reorders (stable signature, new position) slide while edits (changed
// signature) re-render in place.
function flipEach(fn) {
  const idsOf = (n) => Array.from(n.querySelectorAll("section.widget[data-wid]")).map((x) => x.dataset.wid).join(",");
  for (const n of document.querySelectorAll("#preview .row")) { const k = idsOf(n); if (k) fn("r:" + k, n); }
  for (const n of document.querySelectorAll("#preview .col")) { const k = idsOf(n); if (k) fn("c:" + k, n); }
  for (const n of document.querySelectorAll("#preview section.widget[data-wid]")) fn("w:" + n.dataset.wid, n);
}
function flipSnapshot() {
  const map = new Map();
  flipEach((k, n) => map.set(k, n.getBoundingClientRect()));
  return map;
}
function flipPlay(before) {
  const moved = new Set();
  flipEach((k, n) => {
    const old = before.get(k);
    if (!old) return;
    // parent already sliding: the child rides along, don't double-animate
    for (let a = n.parentElement; a; a = a.parentElement) if (moved.has(a)) return;
    const r = n.getBoundingClientRect();
    const dx = old.left - r.left;
    const dy = old.top - r.top;
    if (Math.abs(dx) + Math.abs(dy) < 4 || Math.abs(dx) + Math.abs(dy) > 2000) return;
    moved.add(n);
    n.animate(
      [{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }],
      { duration: 180, easing: "ease" },
    );
  });
}

async function refreshPreview() {
  const { data } = await api("/settings/editor/preview", { doc: draft, pageIndex: pageIdx });
  if (data.error) {
    $("preview").textContent = "";
    $("preview").appendChild(el("p", "error", "Draft invalid: " + data.error));
    return;
  }
  const flipBefore = flipSnapshot();
  $("preview").innerHTML = data.html; // server-rendered, escaped upstream
  highlightPreview();
  // Delegated selection: click a widget to inspect it, anywhere else in a
  // column to inspect the column, anywhere else in a row to inspect the row.
  const mainEl = $("preview").querySelector("main");
  if (mainEl) {
    mainEl.addEventListener("click", (e) => {
      if (e.target.closest(".ph-widget, .ph-row, .ph-col, .row-handle, .col-handle, .qd, .qd-inline")) return;
      const sec = e.target.closest("section.widget");
      if (sec) {
        selected = { kind: "widget", wid: sec.dataset.wid };
        renderAll();
        highlightPreview();
        return;
      }
      const colEl = e.target.closest(".col");
      if (colEl) {
        const rowEl = colEl.closest(".row");
        selected = { kind: "column", pageIdx, rowIdx: Number(rowEl.dataset.row), colIdx: Number(colEl.dataset.col) };
        renderAll();
        highlightPreview();
        return;
      }
      const rowEl = e.target.closest(".row");
      if (rowEl) {
        selected = { kind: "row", rowIdx: Number(rowEl.dataset.row) };
        renderAll();
        highlightPreview();
        return;
      }
      // background of the page (outside any row): inspect the page
      selected = { kind: "page", pageIdx };
      renderAll();
      highlightPreview();
    });
  }
  decoratePreview();
  applyThemePreview();
  flipPlay(flipBefore);
  if (pendingEnter) {
    document.querySelector("#preview " + pendingEnter)?.classList.add("enter");
    pendingEnter = null;
  }
  applyProbes();
}

// ---------- drag & drop + placeholders (preview decoration) ----------
// Drag-and-drop is an ENHANCEMENT: the outline's move buttons and the
// move-to picker remain the non-dragging mechanisms (WCAG 2.2 / G219).
let draggedWid = null;
let draggedRowIdx = null;
let draggedColRef = null; // {ri, ci}

function dragPayload() {
  if (draggedWid !== null) return { kind: "widget", wid: draggedWid };
  if (draggedRowIdx !== null) return { kind: "row", ri: draggedRowIdx };
  if (draggedColRef !== null) return { kind: "col", ...draggedColRef };
  return null;
}
function clearDrag() { draggedWid = null; draggedRowIdx = null; draggedColRef = null; }

function moveRow(fromRi, toRi) {
  const rows = draft.pages[pageIdx].rows;
  if (fromRi === toRi || fromRi === toRi - 1 && false) {}
  const [row] = rows.splice(fromRi, 1);
  if (toRi > fromRi) toRi--;
  rows.splice(toRi, 0, row);
  selected = null;
  changed();
}

function moveRowStep(ri, delta) {
  const rows = draft.pages[pageIdx].rows;
  const j = ri + delta;
  if (j < 0 || j >= rows.length) return;
  [rows[ri], rows[j]] = [rows[j], rows[ri]];
  if (selected && selected.kind === "row") selected = { kind: "row", rowIdx: j };
  changed();
}

function moveColStep(ri, ci, delta) {
  const cols = draft.pages[pageIdx].rows[ri].columns;
  const j = ci + delta;
  if (j < 0 || j >= cols.length) return;
  [cols[ci], cols[j]] = [cols[j], cols[ci]];
  if (selected && selected.kind === "column") selected = { kind: "column", pageIdx, rowIdx: ri, colIdx: j };
  changed();
}

function moveColumn(from, toRi, toCi) {
  const rows = draft.pages[pageIdx].rows;
  const srcRow = rows[from.ri];
  if (!srcRow) return;
  const [col] = srcRow.columns.splice(from.ci, 1);
  if (from.ri === toRi && toCi !== null && toCi > from.ci) toCi--;
  const dstRow = rows[toRi];
  if (!dstRow) return;
  if (toCi === null) dstRow.columns.push(col);
  else dstRow.columns.splice(toCi, 0, col);
  if (srcRow.columns.length === 0 && from.ri !== toRi) {
    srcRow.columns.push({ width: "full", widgets: [] });
  }
  selected = null;
  changed();
}

function moveWidgetTo(id, ri, ci, beforeWid) {
  const loc = findWidget(id);
  if (!loc) return;
  draft.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx].widgets.splice(loc.idx, 1);
  const col = draft.pages[pageIdx].rows[ri]?.columns[ci];
  if (!col) return;
  let idx = beforeWid ? col.widgets.findIndex((x) => x.id === beforeWid) : col.widgets.length;
  if (idx === -1) idx = col.widgets.length;
  col.widgets.splice(idx, 0, loc.widget);
  changed();
}

function moveToNewRow(id, position) {
  const loc = findWidget(id);
  if (!loc) return;
  draft.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx].widgets.splice(loc.idx, 1);
  const row = newRow([loc.widget]);
  const page = draft.pages[pageIdx];
  page.rows.splice(position === "top" ? 0 : page.rows.length, 0, row);
  changed();
}

const SPANS = { full: 12, "1/2": 6, "1/3": 4, "2/3": 8, "1/4": 3, "3/4": 9, "1/6": 2, "5/6": 10 };
const SPAN_NAMES = { 2: "1/6", 3: "1/4", 4: "1/3", 6: "1/2", 8: "2/3", 9: "3/4", 10: "5/6", 12: "full" };
let pendingEnter = null; // selector to animate after the next reconcile

function splitColumnAt(ri, ci) {
  const row = draft.pages[pageIdx].rows[ri];
  const col = row && row.columns[ci];
  if (!col || !SPLITS[col.width]) return;
  const halves = SPLITS[col.width];
  col.width = halves[0];
  row.columns.splice(ci + 1, 0, { width: halves[1], widgets: [] });
  pendingEnter = '.row[data-row="' + ri + '"] .col[data-col="' + (ci + 1) + '"]';
  changed(true);
}

const SPLITS = {
  full: ["1/2", "1/2"],
  "3/4": ["1/2", "1/4"],
  "2/3": ["1/3", "1/3"],
  "1/2": ["1/4", "1/4"],
  "5/6": ["1/2", "1/3"],
  "1/3": ["1/6", "1/6"],
};
function widthForTracks(tracks) {
  let best = null;
  for (const [w, n] of Object.entries(SPANS)) {
    if (n <= tracks && (best === null || n > SPANS[best])) best = w;
  }
  return best;
}

let toastTimer = null;
function showToast(msg, undoable) {
  let t = document.getElementById("toast");
  if (!t) {
    t = el("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = "";
  t.appendChild(el("span", null, msg));
  if (undoable) {
    const u = el("button", "btn-accent", "Undo");
    u.addEventListener("click", () => { undo(); hideToast(); });
    t.appendChild(u);
  }
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5000);
}
function hideToast() {
  document.getElementById("toast")?.classList.remove("show");
}

// Optimistic removal: take the node out of the preview immediately; the
// debounced server re-render reconciles the real state right after.
function vanish(selector) {
  const n = document.querySelector(selector);
  if (!n) return;
  n.classList.add("vanish");
  setTimeout(() => n.remove(), 150);
}

// Draft-widget probes: live-fetch an unsaved widget's data server-side so
// the preview fills with real content before save. Results are cached by
// widget id and re-applied after every preview reconcile.
const probedBodies = new Map();
let probeTimer = null;

function applyProbes() {
  for (const [id, result] of probedBodies) {
    const sec = document.querySelector('#preview section.widget[data-wid="' + id + '"]');
    if (!sec || sec.dataset.probed === "1") continue;
    const pend = sec.querySelector(".pending") || sec.querySelector(".probe-body");
    if (!pend) continue;
    if (result.html) {
      const holder = el("div", "probe-body");
      holder.innerHTML = result.html; // server-rendered, escaped upstream
      pend.replaceWith(holder);
    } else {
      pend.textContent = "fetch failed: " + String(result.error || "unknown").slice(0, 90);
      pend.className = "pending error";
    }
    sec.dataset.probed = "1";
  }
}

async function probeWidget(id) {
  const loc = findWidget(id);
  if (!loc) return;
  const w = loc.widget;
  if (["heartbeat", "iframe", "clock", "countdown", "bookmarks", "search", "note"].includes(w.type)) return;
  const { data } = await api("/settings/editor/probe", { widget: w });
  probedBodies.set(id, data.html ? { html: data.html } : { error: data.error || "no data" });
  applyProbes();
}

function reprobe(id) {
  probedBodies.delete(id);
  document.querySelector('#preview section.widget[data-wid="' + id + '"]')?.removeAttribute("data-probed");
  return probeWidget(id);
}

function scheduleProbe(id) {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => reprobe(id), 700);
}

// Instant feedback for adds: a skeleton card appears immediately; the
// server re-render replaces it with the real widget moments later.
function optimisticWidget(ri, ci, title) {
  const colEl = document.querySelector('#preview .row[data-row="' + ri + '"] .col[data-col="' + ci + '"]');
  if (!colEl) return;
  const sk = el("section", "widget optimistic enter");
  sk.appendChild(el("h2", null, title));
  sk.appendChild(el("p", "pending", "loading…"));
  const ph = colEl.querySelector(".ph-widget");
  if (ph) colEl.insertBefore(sk, ph);
  else colEl.appendChild(sk);
}

// Display name: explicit title, else the type's gallery title - the
// auto-generated instance name only as a last resort.
function widgetTitle(w) {
  return w.title || (formsByType[w.type] && formsByType[w.type].title) || w.name || w.type;
}

function widgetNamesOf(ws) {
  const names = ws.map(widgetTitle);
  return names.slice(0, 8).join(", ") + (names.length > 8 ? " and " + (names.length - 8) + " more" : "");
}

// Shared delete flows: used by both the inspector buttons and the
// hover quick-delete controls, so confirmation copy can never drift.
function deleteWidgetById(id) {
  const loc = findWidget(id);
  if (!loc) return;
  const w = loc.widget;
  draft.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx].widgets.splice(loc.idx, 1);
  if (selected && selected.wid === id) selected = null;
  vanish('#preview section.widget[data-wid="' + id + '"]');
  changed(true);
  showToast("Deleted " + widgetTitle(w), true);
}

function deleteColumnAt(ri, ci) {
  const row = draft.pages[pageIdx].rows[ri];
  const col = row && row.columns[ci];
  if (!col) return;
  const n = col.widgets.length;
  if (
    n > 0 &&
    !confirm("Delete this column and its " + n + " widget" + (n === 1 ? "" : "s") + " (" + widgetNamesOf(col.widgets) + ")? They’ll be removed when you save (run history is preserved).")
  ) return;
  row.columns.splice(ci, 1);
  if (row.columns.length === 0) row.columns.push({ width: "full", widgets: [] });
  selected = null;
  vanish('#preview .row[data-row="' + ri + '"] .col[data-col="' + ci + '"]');
  changed(true);
  showToast("Deleted column" + (n ? " and " + n + " widget" + (n === 1 ? "" : "s") : ""), true);
}

function deleteRowAt(ri) {
  const page = draft.pages[pageIdx];
  const row = page.rows[ri];
  if (!row) return;
  if (page.rows.length <= 1) { alert("A page needs at least one row."); return; }
  const ws = row.columns.flatMap((c) => c.widgets);
  if (
    ws.length > 0 &&
    !confirm("Delete " + rowLabelOf(row, ri) + " and its " + ws.length + " widget" + (ws.length === 1 ? "" : "s") + " (" + widgetNamesOf(ws) + ")? They’ll be removed when you save (run history is preserved).")
  ) return;
  page.rows.splice(ri, 1);
  selected = null;
  vanish('#preview .row[data-row="' + ri + '"]');
  changed(true);
  showToast("Deleted " + rowLabelOf(row, ri) + (ws.length ? " and " + ws.length + " widget" + (ws.length === 1 ? "" : "s") : ""), true);
}

function addRowAt(position) {
  const page = draft.pages[pageIdx];
  const at = position === "top" ? 0 : page.rows.length;
  page.rows.splice(at, 0, newRow());
  pendingEnter = '.row[data-row="' + at + '"]';
  changed(true);
}

function dropTarget(node, onDrop) {
  node.addEventListener("dragover", (e) => {
    if (!dragPayload()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    node.classList.add("drop-hover");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-hover"));
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    node.classList.remove("drop-hover");
    const payload = dragPayload();
    if (payload) onDrop(payload);
    clearDrag();
  });
}

function decoratePreview() {
  const preview = $("preview");
  const main = preview.querySelector("main");
  if (!main) return;

  // The page itself is a container too: <main> already wraps every row,
  // so it carries the frame rather than a new wrapper element (moving
  // rows into one would break the row/col selectors and the fit-screen
  // rules that key off `main >`). Clicking the bare background already
  // selected the page - this gives that target a visible edge and label.
  const page = draft.pages[pageIdx];
  main.classList.add("page-frame");
  const ph = el(
    "div",
    "page-handle" + (selected?.kind === "page" ? " selected" : ""),
    "Page · " + (page?.name || "Untitled"),
  );
  ph.setAttribute("role", "button");
  ph.tabIndex = 0;
  ph.title = "Edit page settings";
  const selPage = () => {
    selected = { kind: "page", pageIdx };
    renderAll();
    highlightPreview();
    decorateSelection();
  };
  ph.addEventListener("click", (e) => { e.stopPropagation(); selPage(); });
  ph.addEventListener("keydown", (e) => { if (e.key === "Enter") selPage(); });
  if (page?.public === true) {
    const badge = el("span", "tab-public", "\u{1F310}");
    badge.title = "Public - anyone with the URL can view it";
    badge.setAttribute("aria-hidden", "true");
    ph.appendChild(badge);
    ph.setAttribute("aria-label", "Edit page settings for " + (page.name || "Untitled") + ", public");
  }
  main.insertBefore(ph, main.firstChild);

  // widgets: draggable, and drop-before targets
  preview.querySelectorAll("section.widget").forEach((sec) => {
    sec.draggable = true;
    sec.addEventListener("dragstart", (e) => {
      if (e.target.closest && e.target.closest(".qd")) { e.preventDefault(); return; }
      draggedWid = sec.dataset.wid;
      sec.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", sec.dataset.wid);
    });
    sec.addEventListener("dragend", () => {
      sec.classList.remove("dragging");
      clearDrag();
    });
    const col = sec.closest(".col");
    const row = sec.closest(".row");
    if (col && row) {
      dropTarget(sec, (p) => {
        if (p.kind !== "widget" || p.wid === sec.dataset.wid) return;
        moveWidgetTo(p.wid, Number(row.dataset.row), Number(col.dataset.col), sec.dataset.wid);
      });
    }
    const qd = el("button", "qd", "✕");
    qd.title = "Delete " + widgetTitle(draft.pages[pageIdx].rows[Number(row.dataset.row)]?.columns[Number(col.dataset.col)]?.widgets.find((x) => x.id === sec.dataset.wid) || { type: "widget" });
    qd.draggable = false;
    qd.addEventListener("mousedown", (e) => e.stopPropagation());
    qd.addEventListener("click", (e) => { e.stopPropagation(); deleteWidgetById(sec.dataset.wid); });
    sec.appendChild(qd);
  });

  // row + column handles: click to inspect/edit the container itself
  preview.querySelectorAll(".row").forEach((rowEl) => {
    const ri = Number(rowEl.dataset.row);
    const rowDraft = draft.pages[pageIdx]?.rows[ri];
    const rh = el("div", "row-handle" + (selected?.kind === "row" && selected.rowIdx === ri ? " selected" : ""), (rowDraft ? rowLabelOf(rowDraft, ri) : "Row " + (ri + 1)) + (rowDraft?.title ? " · " + rowDraft.title : ""));
    rh.setAttribute("role", "button");
    rh.tabIndex = 0;
    const selRow = () => { selected = { kind: "row", rowIdx: ri }; renderAll(); highlightPreview(); decorateSelection(); };
    rh.addEventListener("click", selRow);
    rh.addEventListener("keydown", (e) => {
      if (e.key === "Enter") selRow();
      if (e.key === "ArrowUp") { e.preventDefault(); moveRowStep(ri, -1); }
      if (e.key === "ArrowDown") { e.preventDefault(); moveRowStep(ri, 1); }
    });
    rh.draggable = true;
    rh.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      draggedRowIdx = ri;
      rh.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "row:" + ri);
    });
    rh.addEventListener("dragend", () => { rh.classList.remove("dragging"); clearDrag(); });
    dropTarget(rh, (p) => {
      if (p.kind === "row" && p.ri !== ri) moveRow(p.ri, ri);
    });
    const rActions = el("span", "h-actions");
    const rowCount = draft.pages[pageIdx]?.rows.length || 0;
    for (const [sym, delta, label] of [["↑", -1, "Move row up"], ["↓", 1, "Move row down"]]) {
      const b = el("button", "mv-inline", sym);
      b.title = label + " (arrow key when focused)";
      b.disabled = delta === -1 ? ri === 0 : ri >= rowCount - 1;
      b.addEventListener("mousedown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => { e.stopPropagation(); moveRowStep(ri, delta); });
      rActions.appendChild(b);
    }
    if (draft.pages[pageIdx].rows.length > 1) {
      const rqd = el("button", "qd-inline", "✕");
      rqd.title = "Delete row " + (ri + 1);
      rqd.addEventListener("mousedown", (e) => e.stopPropagation());
      rqd.addEventListener("click", (e) => { e.stopPropagation(); deleteRowAt(ri); });
      rActions.appendChild(rqd);
    }
    rh.appendChild(rActions);
    rowEl.insertBefore(rh, rowEl.firstChild);
    rowEl.querySelectorAll(".col").forEach((colEl) => {
      const ci = Number(colEl.dataset.col);
      const width = draft.pages[pageIdx]?.rows[ri]?.columns[ci]?.width || "";
      const colDraft = draft.pages[pageIdx]?.rows[ri]?.columns[ci];
      const ch = el("div", "col-handle" + (selected?.kind === "column" && selected.rowIdx === ri && selected.colIdx === ci ? " selected" : ""), width + " col" + (colDraft?.title ? " · " + colDraft.title : ""));
      ch.setAttribute("role", "button");
      ch.tabIndex = 0;
      ch.title = "Edit column";
      const selCol = () => { selected = { kind: "column", pageIdx, rowIdx: ri, colIdx: ci }; renderAll(); highlightPreview(); decorateSelection(); };
      ch.addEventListener("click", selCol);
      ch.addEventListener("keydown", (e) => {
        if (e.key === "Enter") selCol();
        if (e.key === "ArrowLeft") { e.preventDefault(); moveColStep(ri, ci, -1); }
        if (e.key === "ArrowRight") { e.preventDefault(); moveColStep(ri, ci, 1); }
      });
      ch.draggable = true;
      ch.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        draggedColRef = { ri, ci };
        ch.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "col:" + ri + ":" + ci);
      });
      ch.addEventListener("dragend", () => { ch.classList.remove("dragging"); clearDrag(); });
      dropTarget(ch, (p) => {
        if (p.kind === "col" && !(p.ri === ri && p.ci === ci)) moveColumn({ ri: p.ri, ci: p.ci }, ri, ci);
      });
      const cActions = el("span", "h-actions");
      if (SPLITS[width]) {
        const sp = el("button", "mv-inline mv-split", "split");
        sp.title = "Split into " + SPLITS[width].join(" + ");
        sp.addEventListener("mousedown", (e) => e.stopPropagation());
        sp.addEventListener("click", (e) => { e.stopPropagation(); splitColumnAt(ri, ci); });
        cActions.appendChild(sp);
      }
      // inverse of split: grow into the row's unused tracks
      {
        const rowCols = draft.pages[pageIdx]?.rows[ri]?.columns || [];
        const spare = 12 - rowCols.reduce((a, c) => a + (SPANS[c.width] || 12), 0);
        const target = spare > 0 ? widthForTracks((SPANS[width] || 12) + spare) : null;
        if (target && SPANS[target] > (SPANS[width] || 12)) {
          const ex = el("button", "mv-inline mv-split", "expand");
          ex.title = "Expand to " + target + " (fills the row's free space)";
          ex.addEventListener("mousedown", (e) => e.stopPropagation());
          ex.addEventListener("click", (e) => {
            e.stopPropagation();
            const colDraft2 = draft.pages[pageIdx]?.rows[ri]?.columns[ci];
            if (colDraft2) { colDraft2.width = target; changed(true); }
          });
          cActions.appendChild(ex);
        }
      }
      const colCount = draft.pages[pageIdx]?.rows[ri]?.columns.length || 0;
      for (const [sym, delta, label] of [["←", -1, "Move column left"], ["→", 1, "Move column right"]]) {
        const b = el("button", "mv-inline", sym);
        b.title = label + " (arrow key when focused)";
        b.disabled = delta === -1 ? ci === 0 : ci >= colCount - 1;
        b.addEventListener("mousedown", (e) => e.stopPropagation());
        b.addEventListener("click", (e) => { e.stopPropagation(); moveColStep(ri, ci, delta); });
        cActions.appendChild(b);
      }
      if ((draft.pages[pageIdx]?.rows[ri]?.columns.length || 0) > 1) {
        const cqd = el("button", "qd-inline", "✕");
        cqd.title = "Delete column";
        cqd.addEventListener("mousedown", (e) => e.stopPropagation());
        cqd.addEventListener("click", (e) => { e.stopPropagation(); deleteColumnAt(ri, ci); });
        cActions.appendChild(cqd);
      }
      ch.appendChild(cActions);
      // drag the gap between adjacent columns to trade width, snapping to
      // the named fractions; commits to the draft on release
      const rowColsAll = draft.pages[pageIdx]?.rows[ri]?.columns || [];
      if (ci < rowColsAll.length - 1) {
        const grip = el("div", "col-resize");
        grip.title = "Drag to resize columns";
        grip.addEventListener("click", (e) => e.stopPropagation());
        grip.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const cols = draft.pages[pageIdx].rows[ri].columns;
          const left = cols[ci];
          const right = cols[ci + 1];
          if (!left || !right) return;
          const l0 = SPANS[left.width] || 12;
          const r0 = SPANS[right.width] || 12;
          const track = rowEl.getBoundingClientRect().width / 12;
          const rightEl = rowEl.querySelector('.col[data-col="' + (ci + 1) + '"]');
          const startX = e.clientX;
          let cur = 0;
          const move = (ev) => {
            const raw = Math.round((ev.clientX - startX) / track);
            let best = 0;
            let bestDist = Infinity;
            for (let d = -10; d <= 10; d++) {
              if (!SPAN_NAMES[l0 + d] || !SPAN_NAMES[r0 - d]) continue;
              const dist = Math.abs(d - raw);
              if (dist < bestDist) { bestDist = dist; best = d; }
            }
            if (best !== cur) {
              cur = best;
              colEl.style.gridColumn = "span " + (l0 + cur);
              if (rightEl) rightEl.style.gridColumn = "span " + (r0 - cur);
              // live width labels while dragging
              if (ch.firstChild) ch.firstChild.nodeValue = SPAN_NAMES[l0 + cur] + " col" + (left.title ? " · " + left.title : "");
              const rch = rightEl && rightEl.querySelector(".col-handle");
              if (rch && rch.firstChild) rch.firstChild.nodeValue = SPAN_NAMES[r0 - cur] + " col" + (right.title ? " · " + right.title : "");
            }
          };
          const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            if (cur !== 0) {
              left.width = SPAN_NAMES[l0 + cur];
              right.width = SPAN_NAMES[r0 - cur];
              changed(true);
            }
          };
          document.addEventListener("mousemove", move);
          document.addEventListener("mouseup", up);
        });
        colEl.appendChild(grip);
      }
      colEl.insertBefore(ch, colEl.firstChild);
      const ph = el("div", "ph-widget", "+ widget");
      ph.setAttribute("role", "button");
      ph.tabIndex = 0;
      ph.addEventListener("click", () => openGallery(ri, ci));
      ph.addEventListener("keydown", (e) => { if (e.key === "Enter") openGallery(ri, ci); });
      dropTarget(ph, (p) => { if (p.kind === "widget") moveWidgetTo(p.wid, ri, ci, null); });
      dropTarget(colEl, (p) => { if (p.kind === "widget") moveWidgetTo(p.wid, ri, ci, null); });
      colEl.appendChild(ph);
    });

    // "+ col" placeholder filling the row's unused tracks
    const rowCols = draft.pages[pageIdx]?.rows[ri]?.columns || [];
    const used = rowCols.reduce((n, c) => n + (SPANS[c.width] || 12), 0);
    const free = 12 - used;
    const fitWidth = free > 0 ? widthForTracks(free) : null;
    if (fitWidth) {
      const pc = el("div", "ph-col", "+ " + fitWidth + " col");
      pc.style.gridColumn = "span " + free;
      pc.setAttribute("role", "button");
      pc.tabIndex = 0;
      const addIt = (widget) => {
        const col = { width: fitWidth, widgets: widget ? [] : [] };
        draft.pages[pageIdx].rows[ri].columns.push(col);
        if (widget) col.widgets.push(widget);
        pendingEnter = '.row[data-row="' + ri + '"] .col[data-col="' + (draft.pages[pageIdx].rows[ri].columns.length - 1) + '"]';
        changed(true);
      };
      pc.addEventListener("click", () => addIt(null));
      pc.addEventListener("keydown", (e) => { if (e.key === "Enter") addIt(null); });
      dropTarget(pc, (p) => {
        if (p.kind === "widget") {
          const loc = findWidget(p.wid);
          if (!loc) return;
          draft.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx].widgets.splice(loc.idx, 1);
          draft.pages[pageIdx].rows[ri].columns.push({ width: fitWidth, widgets: [loc.widget] });
          changed();
        } else if (p.kind === "col") {
          moveColumn({ ri: p.ri, ci: p.ci }, ri, null);
        }
      });
      rowEl.appendChild(pc);
    }
  });

  // row placeholder at the bottom (click = add row, drop = new row with
  // the dragged widget/row/column; reach the top via drag-onto-row-1's
  // handle or the move-up controls)
  {
    const ph = el("div", "ph-row", "+ row");
    ph.setAttribute("role", "button");
    ph.tabIndex = 0;
    ph.addEventListener("click", () => addRowAt("bottom"));
    ph.addEventListener("keydown", (e) => { if (e.key === "Enter") addRowAt("bottom"); });
    dropTarget(ph, (p) => {
      if (p.kind === "widget") moveToNewRow(p.wid, "bottom");
      else if (p.kind === "row") moveRow(p.ri, draft.pages[pageIdx].rows.length);
      else if (p.kind === "col") {
        const rows = draft.pages[pageIdx].rows;
        const srcRow = rows[p.ri];
        const [col] = srcRow.columns.splice(p.ci, 1);
        if (srcRow.columns.length === 0) srcRow.columns.push({ width: "full", widgets: [] });
        rows.push({ columns: [col] });
        selected = null;
        changed(true);
      }
    });
    main.appendChild(ph);
  }
}
function highlightPreview() {
  $("preview").querySelectorAll("section.widget").forEach((sec) => {
    sec.classList.toggle("selected", selected?.kind === "widget" && sec.dataset.wid === selected.wid);
  });
  decorateSelection();
}
function decorateSelection() {
  $("preview").querySelectorAll(".row-handle").forEach((h) => {
    const ri = Number(h.parentElement.dataset.row);
    h.classList.toggle("selected", selected?.kind === "row" && selected.rowIdx === ri);
  });
  $("preview").querySelectorAll(".col-handle").forEach((h) => {
    const ri = Number(h.closest(".row")?.dataset.row);
    const ci = Number(h.parentElement.dataset.col);
    h.classList.toggle("selected", selected?.kind === "column" && selected.rowIdx === ri && selected.colIdx === ci);
  });
  $("preview").querySelectorAll(".page-handle").forEach((h) => {
    h.classList.toggle("selected", selected?.kind === "page");
  });
}

// ---------- inspector ----------
const SENSITIVE_KEYS = { url: 1, auth_secret: 1, token_secret: 1, expect_every: 1, anchor: 1, grace: 1, latitude: 1, longitude: 1 };

function fieldToLines(v) {
  return (v || []).map((f) => f.label + ": " + (f.path !== undefined ? f.path : f.tz)).join("\n");
}
function linesToFields(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    if (i === -1) continue;
    out.push({ label: t.slice(0, i).trim(), path: t.slice(i + 1).trim() });
  }
  return out;
}

let tzListCache = null;
function tzOptions() {
  if (!tzListCache) {
    try {
      tzListCache = Intl.supportedValuesOf("timeZone");
    } catch (e) {
      tzListCache = ["UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
        "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Australia/Sydney"];
    }
  }
  return tzListCache;
}
// Searchable timezone picker: type a city, pick from matches; the IANA
// zone is the stored value. mousedown (not click) so selection beats blur.
function tzPicker(value, onPick, allowEmpty) {
  let cur = value || "";
  const box = el("div", "tz-box");
  const input = el("input");
  input.type = "text";
  input.placeholder = allowEmpty ? "Search city (default UTC)" : "Search city";
  input.autocomplete = "off";
  input.value = cur;
  const results = el("div", "geo-results");
  const close = () => { results.textContent = ""; };
  const cityOf = (z) => z.split("/").pop().replace(/_/g, " ");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    close();
    if (!q) {
      if (allowEmpty) { cur = ""; onPick(""); }
      return;
    }
    const toks = q.split(/[ ]+/);
    const scored = [];
    for (const z of tzOptions()) {
      const hay = z.replace(/[_/]/g, " ").toLowerCase();
      if (!toks.every((t) => hay.includes(t))) continue;
      scored.push([cityOf(z).toLowerCase().startsWith(toks[0]) ? 0 : 1, z]);
    }
    scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    for (const [, z] of scored.slice(0, 12)) {
      const b = el("button", "geo-item", cityOf(z) + " - " + z);
      b.type = "button";
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        cur = z;
        input.value = z;
        close();
        onPick(z);
      });
      results.appendChild(b);
    }
    if (!results.childNodes.length) results.appendChild(el("p", "meta", "No matching city"));
  });
  input.addEventListener("blur", () => setTimeout(() => { input.value = cur; close(); }, 150));
  box.appendChild(input);
  box.appendChild(results);
  return box;
}

function control(desc, w) {
  const wrap = el("div");
  const label = el("label", null, desc.label);
  label.htmlFor = "f-" + desc.key;
  if (SENSITIVE_KEYS[desc.key]) label.appendChild(el("span", "sensitive-badge", "sensitive"));
  wrap.appendChild(label);
  if (desc.kind === "geosearch") {
    const inp = el("input");
    inp.placeholder = "Austin, TX · 94110 · Berlin";
    inp.value = w[desc.key] || "";
    const btn = el("button", "btn-accent", "Search");
    btn.style.marginTop = "0.3rem";
    const results = el("div", "geo-results");
    const run = async () => {
      results.textContent = "searching…";
      const { data } = await api("/settings/editor/geocode", { q: inp.value });
      results.textContent = "";
      for (const r of data.results || []) {
        const b = el("button", "geo-item", r.label);
        b.addEventListener("click", () => {
          w.latitude = r.lat;
          w.longitude = r.lon;
          w[desc.key] = r.label;
          if (!w.title) w.title = r.name;
          changed();
          if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
        });
        results.appendChild(b);
      }
      if (!(data.results || []).length) results.appendChild(el("p", "field-help", data.error || "no matches"));
    };
    btn.addEventListener("click", run);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
    wrap.appendChild(inp);
    wrap.appendChild(btn);
    wrap.appendChild(results);
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  if (desc.kind === "strlist") {
    wrap.appendChild(label);
    const list = el("div", "clock-rows");
    if (typeof w[desc.key] === "string") w[desc.key] = w[desc.key].split(/[,\s]+/).filter(Boolean);
    if (!Array.isArray(w[desc.key])) w[desc.key] = [];
    const rows = w[desc.key];
    // coin ids are unguessable and fail silently, so that list only
    // accepts picked entries; stock tickers stay typable (the search
    // source rate-limits and must not be the only door)
    const locked = desc.search === "coins";
    // youtube rows are {id, label} objects: the picker captures the channel
    // NAME, and the list shows it instead of the opaque UC… id
    const objMode = desc.search === "youtube";
    if (objMode) rows.forEach((v, i) => { if (typeof v === "string") rows[i] = { id: v }; });
    const entryText = (x) => (objMode ? String((x && x.id) || "").trim() : String(x).trim());
    const addBtn = el("button", "btn-accent", "+ Add");
    const commitList = () => {
      const valid = rows.filter((x) => entryText(x));
      if (valid.length) w[desc.key] = valid.map((x) => (objMode ? x : String(x).trim()));
      else delete w[desc.key];
      probedBodies.delete(w.id);
      changed();
      if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
    };
    function renderStrRows() {
      list.textContent = "";
      rows.forEach((val, i) => {
        const rowEl = el("div", "clock-row");
        if (locked) {
          rowEl.appendChild(el("span", "field-path str-chip", val));
        } else if (objMode && val.label) {
          const chip = el("span", "field-path str-chip", val.label);
          chip.title = val.id;
          rowEl.appendChild(chip);
        } else {
          const inp = el("input");
          inp.type = "text";
          inp.className = "field-path";
          inp.placeholder = desc.placeholder || "";
          inp.value = objMode ? val.id || "" : val;
          inp.addEventListener("change", () => {
            rows[i] = objMode ? { id: inp.value.trim() } : inp.value;
            commitList();
          });
          rowEl.appendChild(inp);
        }
        const rm = el("button", "ol-mini ol-del", "✕");
        rm.title = "Remove";
        rm.addEventListener("click", () => { rows.splice(i, 1); renderStrRows(); commitList(); });
        rowEl.appendChild(rm);
        list.appendChild(rowEl);
      });
      addBtn.disabled = rows.length >= 12;
    }
    addBtn.addEventListener("click", () => {
      rows.push(objMode ? { id: "" } : "");
      renderStrRows();
      const last = list.lastChild && list.lastChild.querySelector("input");
      if (last) last.focus();
    });
    renderStrRows();
    wrap.appendChild(list);
    if (!locked) wrap.appendChild(addBtn);
    if (desc.search) {
      const SEARCHES = {
        coins: { path: "/settings/editor/coinsearch", ph: "Search coins…" },
        stocks: { path: "/settings/editor/symbolsearch", ph: "Search companies…" },
        youtube: { path: "/settings/editor/ytsearch", ph: "Find channel: @handle or URL…" },
      };
      const searchPath = (SEARCHES[desc.search] || SEARCHES.stocks).path;
      const si = el("input");
      si.type = "search";
      si.placeholder = (SEARCHES[desc.search] || SEARCHES.stocks).ph;
      si.autocomplete = "off";
      si.style.marginTop = "0.35rem";
      const sres = el("div", "geo-results");
      let searchTimer = null;
      si.addEventListener("input", () => {
        clearTimeout(searchTimer);
        const q = si.value.trim();
        sres.textContent = "";
        if (q.length < 2) return;
        searchTimer = setTimeout(async () => {
          const { data } = await api(searchPath, { q });
          sres.textContent = "";
          if (data.error) { sres.appendChild(el("p", "error", String(data.error).slice(0, 90))); return; }
          for (const r of data.results || []) {
            const b = el("button", "geo-item", r.label + " - " + r.id);
            b.type = "button";
            b.addEventListener("mousedown", (e) => {
              e.preventDefault();
              const dupe = objMode ? rows.some((x) => x && x.id === r.id) : rows.includes(r.id);
              if (!dupe) {
                rows.push(objMode ? { id: r.id, label: r.label } : r.id);
                renderStrRows();
                commitList();
              }
              si.value = "";
              sres.textContent = "";
            });
            sres.appendChild(b);
          }
          if (!sres.childNodes.length) sres.appendChild(el("p", "meta", "No matches."));
        }, 300);
      });
      si.addEventListener("blur", () => setTimeout(() => { sres.textContent = ""; }, 150));
      wrap.appendChild(si);
      wrap.appendChild(sres);
    }
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  if (desc.kind === "linklist") {
    wrap.appendChild(label);
    const list = el("div", "clock-rows");
    if (!Array.isArray(w[desc.key])) w[desc.key] = [];
    const rows = w[desc.key];
    const addBtn = el("button", "btn-accent", "+ Add link");
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www./, ""); } catch (e) { return "Title (optional)"; } };
    function renderLinkRows() {
      list.textContent = "";
      rows.forEach((lnk, i) => {
        const rowEl = el("div", "clock-row");
        const ti = el("input");
        ti.type = "text";
        ti.placeholder = lnk.url ? hostOf(lnk.url) : "Title (optional)";
        ti.value = lnk.title || "";
        ti.addEventListener("change", () => { lnk.title = ti.value; changed(); });
        const ui = el("input");
        ui.type = "text";
        ui.className = "field-path";
        ui.placeholder = "https://…";
        ui.value = lnk.url || "";
        ui.addEventListener("change", () => {
          lnk.url = ui.value;
          ti.placeholder = lnk.url ? hostOf(lnk.url) : "Title (optional)";
          changed();
        });
        const rm = el("button", "ol-mini ol-del", "✕");
        rm.title = "Remove link";
        rm.addEventListener("click", () => { rows.splice(i, 1); renderLinkRows(); changed(); });
        rowEl.appendChild(ti);
        rowEl.appendChild(ui);
        rowEl.appendChild(rm);
        list.appendChild(rowEl);
      });
      addBtn.disabled = rows.length >= 30;
    }
    addBtn.addEventListener("click", () => {
      rows.push({ title: "", url: "" });
      renderLinkRows();
      const last = list.lastChild && list.lastChild.querySelector(".field-path");
      if (last) last.focus();
    });
    renderLinkRows();
    wrap.appendChild(list);
    wrap.appendChild(addBtn);
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  if (desc.kind === "clocklist") {
    wrap.appendChild(label);
    const list = el("div", "clock-rows");
    if (!Array.isArray(w[desc.key])) w[desc.key] = [];
    const rows = w[desc.key];
    const addBtn = el("button", "btn-accent", "+ Add clock");
    function renderRows() {
      list.textContent = "";
      rows.forEach((c, i) => {
        if (c.tz === undefined && c.path !== undefined) { c.tz = c.path; delete c.path; }
        const rowEl = el("div", "clock-row");
        const li = el("input");
        li.type = "text";
        li.placeholder = "Label";
        li.value = c.label || "";
        li.addEventListener("change", () => { c.label = li.value; changed(); });
        const ts = tzPicker(c.tz || "UTC", (z) => {
          const cityOf = (zone) => (zone || "").split("/").pop().replace(/_/g, " ");
          // empty or still the previous city's auto-name -> follow the new city
          if (!li.value.trim() || li.value.trim() === cityOf(c.tz)) {
            c.label = cityOf(z);
            li.value = c.label;
          }
          c.tz = z;
          changed();
        });
        ts.setAttribute("aria-label", "Timezone");
        const rm = el("button", "ol-mini ol-del", "✕");
        rm.title = "Remove clock";
        rm.addEventListener("click", () => { rows.splice(i, 1); renderRows(); changed(); });
        rowEl.appendChild(li);
        rowEl.appendChild(ts);
        rowEl.appendChild(rm);
        list.appendChild(rowEl);
      });
      addBtn.disabled = rows.length >= 8;
    }
    addBtn.addEventListener("click", () => { rows.push({ label: "", tz: "UTC" }); renderRows(); changed(); });
    renderRows();
    wrap.appendChild(list);
    wrap.appendChild(addBtn);
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  if (desc.kind === "timezone") {
    wrap.appendChild(label);
    wrap.appendChild(tzPicker(w[desc.key] || "", (z) => {
      if (z) w[desc.key] = z;
      else delete w[desc.key];
      changed();
    }, true));
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  if (desc.kind === "color") {
    wrap.appendChild(label);
    const rowEl = el("div", "clock-row share-row");
    const isHexC = (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v || ""));
    const pick = el("input", "color-swatch");
    pick.type = "color";
    pick.value = isHexC(w[desc.key]) ? w[desc.key] : "#3d99f5";
    const inp = el("input");
    inp.type = "text";
    inp.placeholder = "inherit theme accent";
    inp.value = w[desc.key] ?? "";
    const writeColor = (v) => {
      if (v) w[desc.key] = v;
      else delete w[desc.key];
      probedBodies.delete(w.id);
      changed();
    };
    pick.addEventListener("input", () => {
      inp.value = pick.value;
      writeColor(pick.value);
    });
    inp.addEventListener("change", () => {
      const v = inp.value.trim();
      writeColor(v || null);
      if (isHexC(v)) pick.value = v;
    });
    rowEl.appendChild(pick);
    rowEl.appendChild(inp);
    wrap.appendChild(rowEl);
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  if (desc.kind === "fieldmap") {
    wrap.appendChild(label);
    const list = el("div", "clock-rows");
    const fields = Array.isArray(w[desc.key])
      ? w[desc.key].map((f) => ({ label: f.label || "", path: f.path || "" }))
      : [];
    const GENERIC_SEGS = ["text", "value", "data", "content", "result", "results", "item", "items", "body"];
    const derivedLabel = (path) => {
      const seg = String(path).split(".").filter((x) => !/^[0-9]+$/.test(x) && !GENERIC_SEGS.includes(x.toLowerCase())).pop();
      if (!seg) return "(no label)";
      return seg.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
    };
    // Rows commit to the draft without a full re-render (which would tear
    // down this UI mid-edit); rows with an empty path stay local-only.
    function commitFields() {
      const valid = fields
        .filter((f) => f.path.trim())
        .map((f) => ({ ...(f.label.trim() ? { label: f.label.trim() } : {}), path: f.path.trim() }));
      if (valid.length) w[desc.key] = valid;
      else delete w[desc.key];
      probedBodies.delete(w.id);
      snapshot();
      markDirty();
      clearTimeout(previewTimer);
      refreshPreview();
      if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
    }
    const addBtn = el("button", "btn-accent", "+ Add field");
    function renderRows() {
      list.textContent = "";
      fields.forEach((f, i) => {
        const rowEl = el("div", "clock-row");
        const li = el("input");
        li.type = "text";
        li.placeholder = f.path ? derivedLabel(f.path) : "Label (optional)";
        li.value = f.label;
        li.addEventListener("change", () => { f.label = li.value; commitFields(); });
        const pi = el("input");
        pi.type = "text";
        pi.className = "field-path";
        pi.placeholder = "dot.path";
        pi.value = f.path;
        pi.addEventListener("change", () => {
          f.path = pi.value;
          li.placeholder = f.path ? derivedLabel(f.path) : "Label (optional)";
          commitFields();
        });
        const rm = el("button", "ol-mini ol-del", "✕");
        rm.title = "Remove field";
        rm.addEventListener("click", () => { fields.splice(i, 1); renderRows(); commitFields(); });
        rowEl.appendChild(li);
        rowEl.appendChild(pi);
        rowEl.appendChild(rm);
        list.appendChild(rowEl);
      });
    }
    addBtn.addEventListener("click", () => {
      fields.push({ label: "", path: "" });
      renderRows();
      const last = list.lastChild && list.lastChild.querySelector(".field-path");
      if (last) last.focus();
    });
    renderRows();
    wrap.appendChild(list);
    wrap.appendChild(addBtn);
    if (w.type === "mcp" || w.type === "json-api") {
      const pickBtn = el("button", "btn-accent pick-btn", "◎ Pick from live response");
      const pickList = el("div", "pick-list");
      pickBtn.addEventListener("click", async () => {
        pickBtn.disabled = true;
        const sp = el("span", "btn-spinner");
        pickBtn.appendChild(sp);
        const { data } = await api("/settings/editor/sample", { widget: w });
        sp.remove();
        pickBtn.disabled = false;
        pickList.textContent = "";
        if (data.error) {
          pickList.appendChild(el("p", "error", String(data.error).slice(0, 120)));
          return;
        }
        for (const leaf of data.leaves || []) {
          const row = el("button", "pick-item");
          row.type = "button";
          const mark = el("span", "pick-mark", fields.some((f) => f.path === leaf.path) ? "✓ " : "+ ");
          row.appendChild(mark);
          row.appendChild(el("span", "pick-path", leaf.path));
          row.appendChild(el("span", "pick-val", String(leaf.preview)));
          row.title = "Toggle this field";
          row.addEventListener("click", () => {
            const idx = fields.findIndex((f) => f.path === leaf.path);
            if (idx >= 0) {
              fields.splice(idx, 1);
              mark.textContent = "+ ";
            } else {
              fields.push({ label: "", path: leaf.path });
              mark.textContent = "✓ ";
            }
            renderRows();
            commitFields();
          });
          pickList.appendChild(row);
        }
        if (!pickList.childNodes.length) pickList.appendChild(el("p", "meta", "No mappable fields in the response."));
      });
      wrap.appendChild(pickBtn);
      wrap.appendChild(pickList);
    }
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  if (desc.kind === "upload") {
    wrap.appendChild(label);
    const rowEl = el("div", "clock-row");
    const inp = el("input");
    inp.type = "text";
    inp.placeholder = desc.placeholder || "";
    inp.value = w[desc.key] ?? "";
    inp.addEventListener("change", () => {
      if (inp.value.trim() === "") delete w[desc.key];
      else w[desc.key] = inp.value.trim();
      probedBodies.delete(w.id);
      changed();
      if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
    });
    const file = el("input");
    file.type = "file";
    file.accept = "image/png,image/jpeg,image/webp";
    file.hidden = true;
    const up = el("button", "btn-accent", "Upload…");
    up.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      up.disabled = true;
      const sp = el("span", "btn-spinner");
      up.appendChild(sp);
      const res = await fetch("/settings/editor/upload-asset?kind=widget", {
        method: "POST",
        headers: { "content-type": f.type || "application/octet-stream", "x-csrf": state.csrf },
        body: f,
      });
      const data = await res.json().catch(() => ({}));
      sp.remove();
      up.disabled = false;
      if (!data.path) { alert(data.error || "upload failed"); return; }
      inp.value = data.path;
      w[desc.key] = data.path;
      probedBodies.delete(w.id);
      changed();
      if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
    });
    rowEl.appendChild(inp);
    rowEl.appendChild(up);
    rowEl.appendChild(file);
    wrap.appendChild(rowEl);
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  // Refresh cadence: a quantity plus a unit, so the vocabulary is visible
  // and an invalid value is unreachable. Stored unchanged as "<n><unit>"
  // (the YAML view and MCP writes keep using the same string). Seconds
  // are not offered for new values: the sweep cron runs every two
  // minutes, so a sub-minute promise would be one the scheduler cannot
  // keep. The unit only appears when an existing config already uses it,
  // and the 60-SECOND FLOOR IS ENFORCED HERE TOO - parseInterval rejects
  // anything shorter from every path (editor, YAML, MCP), so the editor
  // must never commit a value the server will refuse.
  if (desc.kind === "interval") {
    wrap.appendChild(label);
    const UNITS = [["m", "minutes"], ["h", "hours"], ["d", "days"]];
    const parse = (v) => {
      const m = /^([0-9]+)([smhd])$/.exec(String(v ?? "").trim());
      return m ? { qty: m[1], unit: m[2] } : { qty: "", unit: "" };
    };
    const UNIT_SECS = { s: 1, m: 60, h: 3600, d: 86400 };
    const initial = parse(w[desc.key] ?? desc.prefill ?? desc.placeholder);
    const row = el("div", "interval-row");
    const qty = el("input");
    qty.type = "number";
    qty.min = "1";
    qty.step = "1";
    qty.className = "interval-qty";
    qty.value = initial.qty;
    const unit = el("select");
    unit.className = "interval-unit";
    const opts = initial.unit === "s" ? [["s", "seconds"], ...UNITS] : UNITS;
    for (const [value, text] of opts) {
      const o = el("option", null, text);
      o.value = value;
      unit.appendChild(o);
    }
    unit.value = initial.unit || "m";
    // the browser enforces the floor too, so the spinner and native
    // validation agree with the server's minimum
    const syncMin = () => {
      qty.min = unit.value === "s" ? "60" : "1";
      qty.title = unit.value === "s" ? "60 seconds or more" : "whole numbers, at least one minute total";
    };
    syncMin();
    const commit = () => {
      const raw = String(qty.value).trim();
      const n = Number(raw);
      // Fractions are NOT truncated: a number input accepts "1.5" despite
      // step=1, and parseInt would have quietly stored 1h. Whole numbers
      // only, native validity respected, and the computed duration must
      // clear the same 60s floor parseInterval enforces.
      const usable =
        raw !== "" &&
        qty.validity.valid &&
        Number.isInteger(n) &&
        n >= 1 &&
        n * (UNIT_SECS[unit.value] || 60) >= 60;
      if (!usable) {
        // Clearing an optional field is the one benign "empty": anything
        // else stays on screen flagged, never rewritten to another value.
        if (raw === "" && !desc.required && qty.validity.valid) {
          qty.classList.remove("invalid");
          delete w[desc.key];
          probedBodies.delete(w.id);
          changed();
          return;
        }
        qty.classList.add("invalid");
        return;
      }
      qty.classList.remove("invalid");
      w[desc.key] = String(n) + unit.value;
      probedBodies.delete(w.id);
      changed();
      if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
    };
    qty.addEventListener("change", commit);
    unit.addEventListener("change", () => { syncMin(); commit(); });
    row.appendChild(qty);
    row.appendChild(unit);
    wrap.appendChild(row);
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  let input;
  if (desc.kind === "textarea") {
    input = el("textarea");
    input.rows = desc.rows || 5;
    input.placeholder = desc.placeholder || "";
    input.value = w[desc.key] ?? "";
  } else if (desc.kind === "json") {
    input = el("textarea");
    input.rows = 3;
    input.placeholder = desc.placeholder || "";
    input.value = w[desc.key] !== undefined ? JSON.stringify(w[desc.key], null, 1) : "";
  } else if (desc.kind === "select") {
    input = el("select");
    for (const o of desc.options || []) {
      const opt = el("option", null, o);
      opt.value = o;
      input.appendChild(opt);
    }
    // unset field displays the first option, which is the runtime default
    input.value = w[desc.key] ?? (desc.options && desc.options[0]) ?? "";
  } else if (desc.kind === "secret" || desc.kind === "connection") {
    input = el("select");
    input.appendChild(el("option", null, "(none)")).value = "";
    const names = desc.kind === "secret" ? state.secretOptions[w.type] || [] : state.connectionOptions || [];
    for (const name of names) {
      const opt = el("option", null, name);
      opt.value = name;
      input.appendChild(opt);
    }
    input.value = w[desc.key] ?? "";
  } else {
    input = el("input");
    input.type = desc.kind === "number" ? "number" : "text";
    input.placeholder = desc.placeholder || "";
    input.value = w[desc.key] ?? "";
  }
  if (desc.key === "tool" && w.type === "mcp") {
    const listBtn = el("button", "btn-accent pick-btn", "◎ List available tools");
    const toolList = el("div", "pick-list");
    listBtn.addEventListener("click", async () => {
      listBtn.disabled = true;
      const sp = el("span", "btn-spinner");
      listBtn.appendChild(sp);
      const { data } = await api("/settings/editor/mcptools", { url: w.url, auth_secret: w.auth_secret, connection: w.connection });
      sp.remove();
      listBtn.disabled = false;
      toolList.textContent = "";
      if (data.error) {
        toolList.appendChild(el("p", "error", String(data.error).slice(0, 120)));
        return;
      }
      for (const t of data.tools || []) {
        const row = el("button", "pick-item");
        row.type = "button";
        const mark = el("span", "pick-mark", w.tool === t.name ? "✓ " : "· ");
        row.appendChild(mark);
        row.appendChild(el("span", "pick-path", t.name));
        if (t.description) row.appendChild(el("span", "pick-val", t.description));
        row.addEventListener("click", () => {
          const oldAuto = mcpQueryText(w);
          w.tool = t.name;
          syncMcpDescription(w, oldAuto);
          // the server's own tool description explains what this is -
          // richer than the bare query, same auto-follow ownership rules
          if (t.description && (!w.description || w.description === mcpQueryText(w))) {
            w.description = (t.name + " - " + t.description).slice(0, 140);
          }
          input.value = t.name;
          toolList.querySelectorAll(".pick-mark").forEach((m) => { m.textContent = "· "; });
          mark.textContent = "✓ ";
          probedBodies.delete(w.id);
          snapshot();
          markDirty();
          clearTimeout(previewTimer);
          refreshPreview();
          if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
        });
        toolList.appendChild(row);
      }
      if (!toolList.childNodes.length) toolList.appendChild(el("p", "meta", "Server reported no tools."));
    });
    input.id = "f-" + desc.key;
    input.addEventListener("change", () => {
      const oldAuto = mcpQueryText(w);
      let v = input.value;
      if (v === "") delete w[desc.key];
      else w[desc.key] = v;
      syncMcpDescription(w, oldAuto);
      probedBodies.delete(w.id);
      changed();
      if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
    });
    wrap.appendChild(input);
    wrap.appendChild(listBtn);
    wrap.appendChild(toolList);
    if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
    return wrap;
  }
  input.id = "f-" + desc.key;
  const flagRequired = () => {
    if (!desc.required) return;
    const empty = w[desc.key] === undefined || w[desc.key] === "";
    input.classList.toggle("invalid", empty);
  };
  flagRequired();
  input.addEventListener("change", () => {
    let v = input.value;
    if (desc.kind === "number") v = v === "" ? undefined : Number(v);
    if (desc.kind === "json") {
      if (v.trim() === "") v = undefined;
      else {
        try {
          v = JSON.parse(v);
          input.classList.remove("invalid");
        } catch (e) {
          input.classList.add("invalid");
          return;
        }
      }
    }
    if (desc.kind === "url") {
      try { new URL(v); input.classList.remove("invalid"); }
      catch { input.classList.add("invalid"); }
    }
    const oldAuto = w.type === "mcp" ? mcpQueryText(w) : null;
    if (v === "" || v === undefined) delete w[desc.key];
    else w[desc.key] = v;
    if (oldAuto !== null && (desc.key === "args" || desc.key === "tool")) syncMcpDescription(w, oldAuto);
    // stale probe html must not overwrite renders under the new settings
    probedBodies.delete(w.id);
    flagRequired();
    changed();
    if (String(w.id).startsWith("tmp_")) scheduleProbe(w.id);
  });
  wrap.appendChild(input);
  if (desc.help) wrap.appendChild(el("p", "field-help", desc.help));
  return wrap;
}

// ---------- theme panel (empty-selection inspector) ----------
const THEME_FONT_OPTS = [["", "system (default)"], ["serif", "serif"], ["mono", "mono"], ["rounded", "rounded"]];
const THEME_RADIUS_OPTS = [["", "rounded (default)"], ["0", "square"], ["4", "subtle"], ["10", "rounded"], ["16", "soft"]];
const THEME_SIZE_OPTS = [["", "default"], ["13", "compact"], ["15", "default (15px)"], ["17", "large"], ["20", "x-large"]];
const THEME_TITLE_OPTS = [["", "default"], ["small", "small"], ["large", "large"], ["x-large", "x-large"]];

// Write a theme's DERIVED tokens onto any element (not the *-override
// indirection: vars declared at :root resolve their var() references at
// :root, where an element-scoped override is invisible).
function applyThemeVars(target, t) {
  const setVar = (name, val) => { if (val) target.style.setProperty(name, val); else target.style.removeProperty(name); };
  const asColor = (v) => (v ? (String(v).startsWith("#") ? v : "hsl(" + v + ")") : null);
  setVar("--accent", asColor(t.accent));
  setVar("--positive", asColor(t.positive));
  setVar("--negative", asColor(t.negative));
  setVar("--bg", asColor(t.background));
  setVar("--text", asColor(t.text));
  setVar("--muted", asColor(t.muted));
  setVar("--border", asColor(t.border));
  const cardBase = asColor(t.card) || "var(--card-scheme)";
  const op = t.card_opacity !== undefined && t.card_opacity !== "" ? Number(t.card_opacity) : null;
  if (t.card || op !== null) {
    setVar("--card", op !== null ? "color-mix(in srgb, " + cardBase + " " + op + "%, transparent)" : cardBase);
  } else {
    setVar("--card", null);
  }
  const r = t.radius !== undefined && t.radius !== "" ? Number(t.radius) : null;
  setVar("--radius", r !== null ? r + "px" : null);
  setVar("--radius-sm", r !== null ? Math.round(r * 0.6) + "px" : null);
  const fonts = { system: "ui-sans-serif, system-ui, -apple-system, sans-serif", serif: "Iowan Old Style, Georgia, 'Times New Roman', serif", mono: "ui-monospace, SFMono-Regular, Menlo, monospace", rounded: "ui-rounded, 'SF Pro Rounded', system-ui, sans-serif" };
  setVar("--font", fonts[t.font] || null);
  setVar("--font-size", t.font_size !== undefined && t.font_size !== "" ? t.font_size + "px" : null);
  const titleSizes = { small: "0.7rem", large: "0.95rem", "x-large": "1.15rem" };
  setVar("--title-size", titleSizes[t.title_size] || null);
}

// After a publish, the editor's own chrome adopts the now-live theme -
// its baked-in page-load vars would otherwise be stale until a reload.
function applyThemeToChrome() {
  applyThemeVars(document.documentElement, draft.theme || {});
}

let themeEditTarget = null; // null = global theme; string = config preset name

function applyThemePreview() {
  const overlay = themeEditTarget !== null ? themeEditTarget : (draft.pages[pageIdx] || {}).theme;
  const overlayFields = overlay ? ((draft.themes || {})[overlay] || (state.builtinThemes || {})[overlay] || {}) : {};
  const t = Object.assign({}, draft.theme || {}, overlayFields);
  const pv = $("preview");
  const setVar = (name, val) => { if (val) pv.style.setProperty(name, val); else pv.style.removeProperty(name); };
  const asColor = (v) => (v ? (String(v).startsWith("#") ? v : "hsl(" + v + ")") : null);
  applyThemeVars(pv, t);
  pv.style.background = asColor(t.background) || "";
  pv.style.color = asColor(t.text) || "";
  // the whole preview pane frames in the theme background, not just the
  // rendered page area - otherwise the draft looks like a card floating
  // on editor chrome
  const center = document.getElementById("center");
  if (center) center.style.background = asColor(t.background) || "";
  pv.style.backgroundImage = t.background_image ? 'url("' + t.background_image + '")' : "";
  pv.style.backgroundSize = t.background_image ? "cover" : "";
  pv.style.backgroundPosition = t.background_image ? "center" : "";
}

function renderThemePanel(root) {
  root.appendChild(el("h2", null, "Theme"));
  root.appendChild(el("p", "meta", "Dashboard-wide appearance. Select a widget, column, or page to edit it instead."));
  if (!draft.theme) draft.theme = {};
  if (!draft.themes) draft.themes = {};
  if (themeEditTarget !== null && !draft.themes[themeEditTarget]) themeEditTarget = null;
  // page presets: named theme overlays stored IN CONFIG; pages select one
  // in their inspector. (Distinct from the browser-local style presets
  // below, which are copy/paste conveniences.)
  const targetWrap = el("div");
  targetWrap.appendChild(el("label", null, "Editing"));
  const targetSel = el("select");
  const optGlobal = el("option", null, "Global theme");
  optGlobal.value = "";
  targetSel.appendChild(optGlobal);
  for (const name of Object.keys(draft.themes)) {
    const o = el("option", null, "Page preset: " + name);
    o.value = name;
    targetSel.appendChild(o);
  }
  const og = el("optgroup");
  og.label = "Built-in (copy to customize)";
  for (const name of Object.keys(state.builtinThemes || {})) {
    if (draft.themes[name]) continue; // already copied
    const o = el("option", null, name);
    o.value = " builtin:" + name;
    og.appendChild(o);
  }
  if (og.childNodes.length) targetSel.appendChild(og);
  const optNew = el("option", null, "+ New page preset…");
  optNew.value = " new";
  targetSel.appendChild(optNew);
  targetSel.value = themeEditTarget ?? "";
  targetSel.addEventListener("change", () => {
    if (targetSel.value.startsWith(" builtin:")) {
      const name = targetSel.value.slice(9);
      draft.themes[name] = Object.assign({}, (state.builtinThemes || {})[name]);
      themeEditTarget = name;
      changed();
      applyThemePreview();
      renderInspector();
      return;
    }
    if (targetSel.value === " new") {
      const name = prompt("Preset name (kebab-case, e.g. night):");
      if (!name || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) {
        if (name) alert("Preset names are kebab-case, up to 24 chars.");
        targetSel.value = themeEditTarget ?? "";
        return;
      }
      if (!draft.themes[name]) draft.themes[name] = {};
      themeEditTarget = name;
      changed();
    } else {
      themeEditTarget = targetSel.value === "" ? null : targetSel.value;
    }
    applyThemePreview();
    renderInspector();
  });
  targetWrap.appendChild(targetSel);
  if (themeEditTarget !== null) {
    targetWrap.appendChild(el("p", "field-help", "Overrides the global theme on pages that select this preset (page inspector). Empty fields inherit; the preview shows it applied."));
  }
  root.appendChild(targetWrap);
  if (themeEditTarget !== null) {
    const delBtn = el("button", "btn-danger", "✕ Delete page preset");
    delBtn.addEventListener("click", () => {
      const uses = draft.pages.filter((pg) => pg.theme === themeEditTarget).map((pg) => pg.name);
      if (!confirm("Delete preset “" + themeEditTarget + "”?" + (uses.length ? " Pages using it revert to the global theme: " + uses.join(", ") : ""))) return;
      delete draft.themes[themeEditTarget];
      for (const pg of draft.pages) if (pg.theme === themeEditTarget) delete pg.theme;
      themeEditTarget = null;
      changed();
      applyThemePreview();
      renderInspector();
    });
    const delRow = el("div", "theme-actions");
    delRow.appendChild(delBtn);
    root.appendChild(delRow);
  }
  const t = themeEditTarget !== null ? draft.themes[themeEditTarget] : draft.theme;
  const themeChanged = () => { changed(); applyThemePreview(); };
  const PRESET_KEYS = ["accent", "positive", "negative", "background", "text", "muted", "card", "border", "font", "font_size", "radius", "title_size", "card_opacity"];
  {
    // fill the CURRENT edit target from a built-in palette (appearance
    // fields only) - one preset system; this is just a starting point
    const wrapEl = el("div");
    wrapEl.appendChild(el("label", null, "Start from palette"));
    const sel = el("select");
    const ph = el("option", null, "Apply a built-in palette…");
    ph.value = "";
    sel.appendChild(ph);
    for (const name of Object.keys(state.builtinThemes || {})) {
      const o = el("option", null, name);
      o.value = name;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      const preset = (state.builtinThemes || {})[sel.value];
      if (!preset) return;
      for (const k of PRESET_KEYS) delete t[k];
      for (const [k, v] of Object.entries(preset)) if (PRESET_KEYS.includes(k)) t[k] = v;
      themeChanged();
      renderInspector();
    });
    wrapEl.appendChild(sel);
    root.appendChild(wrapEl);
  }

  const actionsRow = el("div", "theme-actions");
  const reset = el("button", "btn-danger", "↺ Reset to defaults");
  reset.addEventListener("click", () => {
    if (!confirm("Reset every theme setting (colors, fonts, images, title) to the defaults?")) return;
    for (const k of Object.keys(t)) delete t[k];
    themeChanged();
    renderInspector();
  });
  actionsRow.appendChild(reset);
  root.appendChild(actionsRow);

  const field = (labelText, key, placeholder, help) => {
    const wrapEl = el("div");
    wrapEl.appendChild(el("label", null, labelText));
    const inp = el("input");
    inp.type = "text";
    inp.placeholder = placeholder || "";
    inp.value = t[key] ?? "";
    inp.addEventListener("change", () => {
      if (String(inp.value).trim() === "") delete t[key];
      else t[key] = inp.value.trim();
      themeChanged();
    });
    wrapEl.appendChild(inp);
    if (help) wrapEl.appendChild(el("p", "field-help", help));
    root.appendChild(wrapEl);
    return inp;
  };

  // native color picker + hex text field, kept in sync; legacy HSL
  // triplet values stay readable in the text field until re-picked
  const isHex = (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v || ""));
  // legacy "H S% L%" triplets convert to hex so the swatch shows the real
  // color and the native drag-around picker opens preloaded with it
  const tripletToHex = (v) => {
    const m = /^([0-9.]+) ([0-9.]+)% ([0-9.]+)%$/.exec(String(v || "").trim());
    if (!m) return null;
    const h = Number(m[1]) / 360;
    const sat = Number(m[2]) / 100;
    const l = Number(m[3]) / 100;
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const pq = 2 * l - q;
    const chan = (tc) => {
      let x = tc;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      let c;
      if (x < 1 / 6) c = pq + (q - pq) * 6 * x;
      else if (x < 1 / 2) c = q;
      else if (x < 2 / 3) c = pq + (q - pq) * (2 / 3 - x) * 6;
      else c = pq;
      return Math.round(c * 255).toString(16).padStart(2, "0");
    };
    return "#" + chan(h + 1 / 3) + chan(h) + chan(h - 1 / 3);
  };
  const toHex = (v) => (isHex(v) ? String(v) : tripletToHex(v));
  const colorField = (labelText, key, placeholder) => {
    const wrapEl = el("div");
    wrapEl.appendChild(el("label", null, labelText));
    const rowEl = el("div", "clock-row");
    const pick = el("input", "color-swatch");
    pick.type = "color";
    pick.title = "Pick a color";
    pick.value = toHex(t[key]) || toHex(placeholder) || "#888888";
    const inp = el("input");
    inp.type = "text";
    inp.className = "field-path";
    inp.placeholder = placeholder || "";
    inp.value = t[key] ?? "";
    const write = (v) => {
      if (v) t[key] = v;
      else delete t[key];
      themeChanged();
    };
    pick.addEventListener("input", () => {
      inp.value = pick.value;
      write(pick.value);
    });
    inp.addEventListener("change", () => {
      const v = inp.value.trim();
      write(v || null);
      const hx = toHex(v.length === 4 && isHex(v) ? "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3] : v);
      if (hx) pick.value = hx;
      else {
        const ph = toHex(placeholder);
        if (ph) pick.value = ph;
      }
    });
    rowEl.appendChild(pick);
    rowEl.appendChild(inp);
    wrapEl.appendChild(rowEl);
    root.appendChild(wrapEl);
  };

  const selectField = (labelText, key, opts, numeric) => {
    const wrapEl = el("div");
    wrapEl.appendChild(el("label", null, labelText));
    const sel = el("select");
    for (const [val, text] of opts) {
      const o = el("option", null, text);
      o.value = val;
      sel.appendChild(o);
    }
    sel.value = t[key] !== undefined ? String(t[key]) : "";
    if (![...sel.options].some((o) => o.value === sel.value)) sel.value = "";
    sel.addEventListener("change", () => {
      if (sel.value === "") delete t[key];
      else t[key] = numeric ? Number(sel.value) : sel.value;
      themeChanged();
    });
    wrapEl.appendChild(sel);
    root.appendChild(wrapEl);
  };

  const uploadField = (labelText, key, kind, help) => {
    const wrapEl = el("div");
    wrapEl.appendChild(el("label", null, labelText));
    const rowEl = el("div", "clock-row");
    const file = el("input");
    file.type = "file";
    file.accept = "image/png,image/jpeg,image/webp";
    file.hidden = true;
    const up = el("button", "btn-accent", t[key] ? "Replace…" : "Upload…");
    up.addEventListener("click", () => file.click());
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      up.disabled = true;
      const sp = el("span", "btn-spinner");
      up.appendChild(sp);
      const res = await fetch("/settings/editor/upload-asset?kind=" + kind, {
        method: "POST",
        headers: { "content-type": f.type || "application/octet-stream", "x-csrf": state.csrf },
        body: f,
      });
      const data = await res.json().catch(() => ({}));
      sp.remove();
      up.disabled = false;
      if (!data.path) { alert(data.error || "upload failed"); return; }
      t[key] = data.path;
      themeChanged();
      renderInspector();
    });
    rowEl.appendChild(up);
    if (t[key]) {
      const cur = el("span", "field-path str-chip", String(t[key]).split("/").pop());
      rowEl.appendChild(cur);
      const rm = el("button", "ol-mini ol-del", "✕");
      rm.title = "Remove";
      rm.addEventListener("click", () => { delete t[key]; themeChanged(); renderInspector(); });
      rowEl.appendChild(rm);
    }
    rowEl.appendChild(file);
    wrapEl.appendChild(rowEl);
    if (help) wrapEl.appendChild(el("p", "field-help", help));
    root.appendChild(wrapEl);
  };

  field("Dashboard title", "title", "mindash");
  uploadField("Logo", "logo", "logo", "Shown beside the title. PNG/JPEG/WebP, 5 MB max.");
  uploadField("Favicon", "favicon", "favicon", "Browser-tab icon; PNG works best (32-64px). Default is the mindash mark.");
  selectField("Font", "font", THEME_FONT_OPTS, false);
  selectField("Corner radius", "radius", THEME_RADIUS_OPTS, true);
  selectField("Font size", "font_size", THEME_SIZE_OPTS, true);
  selectField("Widget title size", "title_size", THEME_TITLE_OPTS, false);
  colorField("Accent", "accent", "#3d99f5");
  colorField("Positive", "positive", "#2eb85b");
  colorField("Negative", "negative", "#dd3c3c");
  colorField("Background", "background", "#16181d");
  colorField("Text", "text", "#dcdfe5");
  colorField("Muted text", "muted", "#8b93a1");
  colorField("Card", "card", "#1e2229");
  colorField("Border", "border", "#313640");
  uploadField("Background image", "background_image", "background", "Wallpaper behind the cards; combine with card opacity.");
  const op = field("Card opacity", "card_opacity", "100", "20–100. Semi-transparent cards over a background image.");
  op.type = "number";
  op.min = "20";
  op.max = "100";
  const mw = field("Max width (px)", "max_width", "none - full width", "480–3840; centers the dashboard when set.");
  mw.type = "number";
}

// Mobile: the inspector is a bottom sheet that selection slides up, and
// until now nothing slid it back down - you had to select something else.
// Its header carries the same name and magnifier the desktop panel uses,
// so the two surfaces read as one panel. Because it belongs to the sheet,
// it rises into the conventional top-edge position when the sheet opens.
// Desktop hides it (the side panel has its own toggle).
// ONE collapsed flag for both surfaces. The desktop rail toggle and the
// mobile sheet header write the same persisted value, so the choice
// survives a resize (or a phone turning into a laptop) instead of each
// surface keeping a private idea of whether the panel is open.
function inspectorCollapsed() {
  return document.querySelector(".editor-grid").classList.contains("inspector-collapsed");
}

function setInspectorCollapsed(collapsed) {
  const grid = document.querySelector(".editor-grid");
  grid.classList.toggle("inspector-collapsed", collapsed);
  localStorage.setItem("mindash-inspector-collapsed", collapsed ? "1" : "0");
  // the mobile sheet rides the same state; on desktop .open is inert
  $("inspector").classList.toggle("open", !collapsed);
  document.dispatchEvent(new CustomEvent("mindash-inspector-toggled"));
}

function syncSheetHandle() {
  const handle = document.querySelector(".sheet-handle");
  if (!handle) return;
  const open = $("inspector").classList.contains("open");
  handle.title = open ? "Hide the inspector" : "Show the inspector";
  handle.setAttribute("aria-label", handle.title);
  handle.setAttribute("aria-expanded", String(open));
}

function sheetHandle(root) {
  const handle = el("button", "sheet-handle");
  handle.type = "button";
  handle.appendChild(el("span", "sh-title", "\u{1F50D} Inspector"));
  // Empty fixed-size box: CSS draws the chevron inside it. Rotating that
  // box around its centre changes direction without shifting the glyph.
  handle.appendChild(el("span", "sh-chev"));
  handle.addEventListener("click", (e) => {
    e.stopPropagation();
    setInspectorCollapsed($("inspector").classList.contains("open"));
  });
  root.appendChild(handle);
  syncSheetHandle();
}

function renderInspector() {
  const root = $("inspector");
  root.textContent = "";
  // selection raises the mobile sheet, but never overrides a deliberate
  // collapse - that flag is shared with desktop and outranks selection
  root.classList.toggle("open", selected !== null && !inspectorCollapsed());
  sheetHandle(root);
  document.dispatchEvent(new CustomEvent("mindash-inspector-toggled"));
  if (!selected) { renderThemePanel(root); return; }


  if (selected.kind === "page") {
    const p = draft.pages[selected.pageIdx];
    root.appendChild(el("h2", null, "Page"));

    const nameWrap = el("div");
    nameWrap.appendChild(el("label", null, "Name"));
    const inp = el("input");
    inp.value = p.name;
    inp.addEventListener("change", () => { p.name = inp.value; changed(); });
    nameWrap.appendChild(inp);
    root.appendChild(nameWrap);
    const fitWrap = el("label", null, null);
    const cb = el("input");
    cb.type = "checkbox";
    cb.style.width = "auto";
    cb.checked = p.fit_screen === true;
    cb.addEventListener("change", () => {
      if (cb.checked) p.fit_screen = true;
      else delete p.fit_screen;
      changed();
    });
    fitWrap.appendChild(cb);
    fitWrap.appendChild(document.createTextNode(" Fit to screen height"));
    root.appendChild(fitWrap);
    root.appendChild(el("p", "field-help", "Rows share the viewport height and columns scroll internally - no page scrolling. Shown on the live dashboard, not in this preview."));
    const hideWrap = el("label", null, null);
    const hide = el("input");
    hide.type = "checkbox";
    hide.style.width = "auto";
    hide.checked = p.hidden === true;
    hide.addEventListener("change", () => {
      if (hide.checked) p.hidden = true;
      else delete p.hidden;
      changed();
    });
    hideWrap.appendChild(hide);
    hideWrap.appendChild(document.createTextNode(" Hide from page menu"));
    root.appendChild(hideWrap);
    root.appendChild(el("p", "field-help", "The page stays reachable by its URL; it just isn't listed in the dashboard's tabs."));
    const pubWrap = el("label", null, null);
    const pub = el("input");
    pub.type = "checkbox";
    pub.style.width = "auto";
    pub.checked = p.public === true;
    pub.addEventListener("change", () => {
      if (pub.checked) p.public = true;
      else delete p.public;
      changed();
    });
    pubWrap.appendChild(pub);
    pubWrap.appendChild(document.createTextNode(" Public (viewable without sign-in)"));
    root.appendChild(pubWrap);
    root.appendChild(el("p", "field-help", "Anyone with the URL can see this page and everything its widgets display. Editing always requires sign-in."));
    if (p.public === true) {
      const idxWrap = el("label", null, null);
      const idx = el("input");
      idx.type = "checkbox";
      idx.style.width = "auto";
      idx.checked = p.indexable === true;
      idx.addEventListener("change", () => {
        if (idx.checked) p.indexable = true;
        else delete p.indexable;
        changed();
      });
      idxWrap.appendChild(idx);
      idxWrap.appendChild(document.createTextNode(" Allow search engines to index this page"));
      root.appendChild(idxWrap);
      root.appendChild(el("p", "field-help", "Off: reachable by URL but sends noindex. On: search engines may list it."));
      const descWrap = el("div");
      descWrap.appendChild(el("label", null, "Description (shown under the header; also link previews)"));
      const desc = el("textarea", "desc-input");
      desc.rows = 3;
      desc.maxLength = 160;
      desc.placeholder = "Shown under the title in search results and chat link previews";
      desc.value = p.description || "";
      desc.addEventListener("change", () => {
        if (desc.value.trim()) p.description = desc.value.trim();
        else delete p.description;
        changed();
      });
      descWrap.appendChild(desc);
      root.appendChild(descWrap);
    }
    const presetWrap = el("div");
    presetWrap.appendChild(el("label", null, "Theme"));
    const presetSel = el("select");
    const dflt = el("option", null, "default (global theme)");
    dflt.value = "";
    presetSel.appendChild(dflt);
    const customNames = Object.keys(draft.themes || {});
    if (customNames.length) {
      const ogC = el("optgroup");
      ogC.label = "Custom";
      for (const name of customNames) {
        const o = el("option", null, name);
        o.value = name;
        ogC.appendChild(o);
      }
      presetSel.appendChild(ogC);
    }
    const ogB = el("optgroup");
    ogB.label = "Built-in";
    for (const name of Object.keys(state.builtinThemes || {})) {
      if (customNames.includes(name)) continue; // shadowed by custom
      const o = el("option", null, name);
      o.value = name;
      ogB.appendChild(o);
    }
    if (ogB.childNodes.length) presetSel.appendChild(ogB);
    const known = (n) => (draft.themes && draft.themes[n]) || (state.builtinThemes && state.builtinThemes[n]);
    presetSel.value = p.theme && known(p.theme) ? p.theme : "";
    presetSel.addEventListener("change", () => {
      if (presetSel.value === "") delete p.theme;
      else p.theme = presetSel.value;
      changed();
      applyThemePreview();
    });
    presetWrap.appendChild(presetSel);
    presetWrap.appendChild(el("p", "field-help", "Page presets are defined in the Theme panel (Theme button or Esc)."));
    root.appendChild(presetWrap);
    const shareWrap = el("div");
    const renderShare = () => {
      shareWrap.textContent = "";
      if (p.public !== true) return;
      shareWrap.appendChild(el("label", null, "Share link"));
      const rowEl = el("div", "clock-row share-row");
      const urlStr = location.origin + pagePath(selected.pageIdx);
      const inp = el("input");
      inp.type = "text";
      inp.readOnly = true;
      inp.value = urlStr;
      inp.addEventListener("focus", () => inp.select());
      const cp = el("button", "btn-accent", "Copy");
      cp.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(urlStr);
          cp.textContent = "Copied ✓";
          setTimeout(() => { cp.textContent = "Copy"; }, 1500);
        } catch (e) {
          inp.focus();
        }
      });
      rowEl.appendChild(inp);
      rowEl.appendChild(cp);
      shareWrap.appendChild(rowEl);
      shareWrap.appendChild(el("p", "field-help", "Live once saved. Renaming the page changes the link."));
    };
    renderShare();
    pub.addEventListener("change", renderShare);
    root.appendChild(shareWrap);
    if (draft.pages.length > 1) {
      const dz = el("div", "danger-zone");
      const del = el("button", "btn-danger", "✕ Delete page");
      del.addEventListener("click", () => {
        const n = p.rows.reduce((a, r) => a + r.columns.reduce((b, c) => b + c.widgets.length, 0), 0);
        if (
          n > 0 &&
          !confirm("Delete page “" + p.name + "” and its " + n + " widget" + (n === 1 ? "" : "s") + " (" + widgetNamesOf(p.rows.flatMap((r) => r.columns.flatMap((c) => c.widgets))) + ")? They’ll be removed when you save (run history is preserved).")
        ) return;
        draft.pages.splice(selected.pageIdx, 1);
        pageIdx = 0; selected = null; changed();
      });
      dz.appendChild(del);
      root.appendChild(dz);
    }
    return;
  }

  const titleInput = (obj, placeholder) => {
    const wrap = el("div");
    wrap.appendChild(el("label", null, "Title (optional)"));
    const inp = el("input");
    inp.placeholder = placeholder;
    inp.maxLength = 60;
    inp.value = obj.title || "";
    inp.addEventListener("change", () => {
      if (inp.value.trim()) obj.title = inp.value.trim();
      else delete obj.title;
      changed();
    });
    wrap.appendChild(inp);
    return wrap;
  };

  if (selected.kind === "row") {
    const page = draft.pages[pageIdx];
    const row = page.rows[selected.rowIdx];
    if (!row) { selected = null; renderInspector(); return; }
    root.appendChild(el("h2", null, rowLabelOf(row, selected.rowIdx) + (row.title ? " · " + row.title : "")));
    root.appendChild(titleInput(row, "Section heading shown on the dashboard"));
    const hWrap = el("div");
    if (page.fit_screen !== true) hWrap.hidden = true;
    hWrap.appendChild(el("label", null, "Height (fit pages)"));
    const hSel = el("select");
    for (const opt of ["auto", "1/6", "1/4", "1/3", "1/2", "2/3", "3/4"]) {
      const o = el("option", null, opt === "auto" ? "auto (share leftover)" : opt + " of the screen");
      o.value = opt;
      hSel.appendChild(o);
    }
    hSel.value = row.height || "auto";
    hSel.addEventListener("change", () => {
      if (hSel.value === "auto") delete row.height;
      else row.height = hSel.value;
      changed();
    });
    hWrap.appendChild(hSel);
    hWrap.appendChild(el("p", "field-help", "Applies when the page is set to fit the screen; proportions, not exact pixels."));
    root.appendChild(hWrap);
    const fillWrap = el("label", null, null);
    if (page.fit_screen === true) fillWrap.hidden = true; // fit pages flex on their own
    const fillCb = el("input");
    fillCb.type = "checkbox";
    fillCb.style.width = "auto";
    fillCb.checked = row.fill !== false;
    fillCb.addEventListener("change", () => {
      if (fillCb.checked) delete row.fill;
      else row.fill = false;
      changed();
    });
    fillWrap.appendChild(fillCb);
    fillWrap.appendChild(document.createTextNode(" Fill height (align card bottoms)"));
    root.appendChild(fillWrap);
    if (page.fit_screen !== true) {
      root.appendChild(el("p", "field-help", "Widgets stretch so every column in this row ends at the same height."));
    }
    root.appendChild(el("p", "meta", row.columns.length + " column" + (row.columns.length === 1 ? "" : "s") + ": " + row.columns.map((c) => c.width).join(" + ")));
    const widgetCount = row.columns.reduce((n, c) => n + c.widgets.length, 0);
    root.appendChild(el("p", "meta", widgetCount + " widget" + (widgetCount === 1 ? "" : "s")));
    const actions = el("div", "danger-zone");
    const addCol = el("button", null, "+ Add column");
    addCol.addEventListener("click", () => {
      row.columns.push({ width: "1/2", widgets: [] });
      pendingEnter = '.row[data-row="' + selected.rowIdx + '"] .col[data-col="' + (row.columns.length - 1) + '"]';
      changed(true);
    });
    actions.appendChild(addCol);
    {
      const up = el("button", null, "↑ Move row up");
      up.disabled = selected.rowIdx === 0;
      up.addEventListener("click", () => {
        const i = selected.rowIdx;
        [page.rows[i - 1], page.rows[i]] = [page.rows[i], page.rows[i - 1]];
        selected = { kind: "row", rowIdx: i - 1 };
        changed();
      });
      actions.appendChild(up);
    }
    {
      const down = el("button", null, "↓ Move row down");
      down.disabled = selected.rowIdx === page.rows.length - 1;
      down.addEventListener("click", () => {
        const i = selected.rowIdx;
        [page.rows[i + 1], page.rows[i]] = [page.rows[i], page.rows[i + 1]];
        selected = { kind: "row", rowIdx: i + 1 };
        changed();
      });
      actions.appendChild(down);
    }
    if (page.rows.length > 1) {
      const del = el("button", "btn-danger", "✕ Delete row");
      del.addEventListener("click", () => deleteRowAt(selected.rowIdx));
      actions.appendChild(del);
    }
    root.appendChild(actions);
    return;
  }

  if (selected.kind === "column") {
    const row = draft.pages[pageIdx].rows[selected.rowIdx];
    const col = row && row.columns[selected.colIdx];
    if (!col) { selected = null; return; }
    root.appendChild(el("h2", null, "Row " + (selected.rowIdx + 1) + " · Column " + (selected.colIdx + 1)));
    root.appendChild(titleInput(col, "Column heading (optional)"));
    const wrap = el("div");
    wrap.appendChild(el("label", null, "Width"));
    const sel = el("select");
    for (const o of ["full", "1/2", "1/3", "2/3", "1/4", "3/4", "1/6", "5/6"]) {
      const opt = el("option", null, o); opt.value = o; sel.appendChild(opt);
    }
    sel.value = col.width;
    sel.addEventListener("change", () => { col.width = sel.value; changed(); });
    wrap.appendChild(sel);
    root.appendChild(wrap);
    const dz = el("div", "danger-zone");
    if (SPLITS[col.width]) {
      const split = el("button", null, "Split into 2");
      split.title = "Split this column into " + SPLITS[col.width].join(" + ") + " (widgets stay in the left half)";
      split.addEventListener("click", () => splitColumnAt(selected.rowIdx, selected.colIdx));
      dz.appendChild(split);
    }
    if (selected.colIdx > 0) {
      const left = el("button", null, "← Move left");
      left.addEventListener("click", () => {
        const ci = selected.colIdx;
        [row.columns[ci - 1], row.columns[ci]] = [row.columns[ci], row.columns[ci - 1]];
        selected = { kind: "column", pageIdx, rowIdx: selected.rowIdx, colIdx: ci - 1 };
        changed();
      });
      dz.appendChild(left);
    }
    if (selected.colIdx < row.columns.length - 1) {
      const right = el("button", null, "→ Move right");
      right.addEventListener("click", () => {
        const ci = selected.colIdx;
        [row.columns[ci + 1], row.columns[ci]] = [row.columns[ci], row.columns[ci + 1]];
        selected = { kind: "column", pageIdx, rowIdx: selected.rowIdx, colIdx: ci + 1 };
        changed();
      });
      dz.appendChild(right);
    }
    if (row.columns.length > 1) {
      const del = el("button", "btn-danger", "✕ Delete column");
      del.addEventListener("click", () => deleteColumnAt(selected.rowIdx, selected.colIdx));
      dz.appendChild(del);
    }
    root.appendChild(dz);
    return;
  }

  const loc = findWidget(selected.wid);
  if (!loc) { selected = null; root.appendChild(el("p", "meta", "Widget removed.")); return; }
  const w = loc.widget;
  const form = formsByType[w.type];
  root.appendChild(el("h2", null, (form ? form.title : w.type)));
  const idLine = el("p", "field-help", "id: " + (String(w.id).startsWith("tmp_") ? "(assigned on save)" : w.name));
  if (w.type === "heartbeat" && w.name) idLine.textContent += " · push URL: /push/" + w.name;
  root.appendChild(idLine);
  if (!form) { root.appendChild(el("p", "error", "No form for type " + w.type + " - use the YAML view.")); return; }

  const basics = form.fields.filter((f) => !f.advanced);
  const advanced = form.fields.filter((f) => f.advanced);
  for (const f of basics) root.appendChild(control(f, w));
  if (advanced.length) {
    const det = el("details");
    det.appendChild(el("summary", null, "Advanced"));
    for (const f of advanced) det.appendChild(control(f, w));
    root.appendChild(det);
  }

  // move-to picker (accessible alternative to any dragging)
  const mv = el("div");
  mv.appendChild(el("label", null, "Move to"));
  const sel = el("select");
  sel.appendChild(el("option", null, "(choose destination)")).value = "";
  draft.pages.forEach((p, pi) =>
    p.rows.forEach((r, ri) =>
      r.columns.forEach((c, ci) => {
        const opt = el("option", null, p.name + " / row " + (ri + 1) + " / col " + (ci + 1) + " (" + c.width + ")");
        opt.value = pi + ":" + ri + ":" + ci;
        sel.appendChild(opt);
      }),
    ),
  );
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    const [pi, ri, ci] = sel.value.split(":").map(Number);
    const from = draft.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx].widgets;
    from.splice(from.indexOf(w), 1);
    draft.pages[pi].rows[ri].columns[ci].widgets.push(w);
    pageIdx = pi;
    changed();
  });
  mv.appendChild(sel);
  root.appendChild(mv);

  const dz = el("div", "danger-zone");
  if (w.type !== "heartbeat" && w.type !== "iframe") {
    const rf = el("button", "btn-accent", "↻ Refresh now");
    rf.addEventListener("click", async () => {
      rf.disabled = true;
      rf.textContent = "";
      rf.appendChild(el("span", "btn-spinner"));
      rf.appendChild(document.createTextNode("Refreshing…"));
      if (String(w.id).startsWith("tmp_")) {
        // unsaved widget: re-run the draft probe (nothing exists server-side)
        await reprobe(w.id);
        const res = probedBodies.get(w.id);
        rf.textContent = res && res.html ? "Refreshed ✓" : ("Failed: " + ((res && res.error) || "")).slice(0, 48);
      } else {
        const { data } = await api("/settings/editor/refresh", { id: w.id });
        rf.textContent = data.ok ? "Refreshed ✓" : ("Failed: " + (data.error || "")).slice(0, 48);
        schedulePreview();
      }
      rf.disabled = false;
    });
    dz.appendChild(rf);
  }
  const dup = el("button", null, "⧉ Duplicate");
  dup.addEventListener("click", () => {
    const copy = JSON.parse(JSON.stringify(w));
    copy.id = "tmp_" + ++tmpCounter;
    copy.name = (w.name + "-" + Math.random().toString(36).slice(2, 6)).slice(0, 48);
    draft.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx].widgets.splice(loc.idx + 1, 0, copy);
    selected = { kind: "widget", wid: copy.id };
    optimisticWidget(loc.rowIdx, loc.colIdx, widgetTitle(copy));
    pendingEnter = 'section.widget[data-wid="' + copy.id + '"]';
    changed(true);
    probeWidget(copy.id);
  });
  const del = el("button", "btn-danger", "✕ Delete");
  del.addEventListener("click", () => deleteWidgetById(w.id));
  dz.appendChild(dup);
  dz.appendChild(del);
  root.appendChild(dz);
}

// ---------- gallery ----------
let galleryTargetRow = 0;
let galleryTargetCol = 0;
function openGallery(rowIdx, colIdx) {
  galleryTargetRow = rowIdx;
  galleryTargetCol = colIdx;
  renderGallery("");
  $("gallery-dialog").showModal();
  $("gallery-search").value = "";
  $("gallery-search").focus();
}
function renderGallery(q) {
  const list = $("gallery-list");
  list.textContent = "";
  const cats = {};
  for (const f of state.forms) {
    const hay = (f.title + " " + f.description + " " + f.category + " " + f.type).toLowerCase();
    if (q && !hay.includes(q.toLowerCase())) continue;
    (cats[f.category] = cats[f.category] || []).push(f);
  }
  for (const [cat, forms] of Object.entries(cats)) {
    list.appendChild(el("p", "gc", cat));
    for (const f of forms) {
      const b = el("button", "gal-item");
      b.appendChild(el("span", "gt", (f.icon ? f.icon + " " : "") + f.title));
      b.appendChild(el("span", "gd", f.description));
      if (f.requirements) b.appendChild(el("span", "gr", f.requirements));
      b.addEventListener("click", () => {
        const w = { id: "tmp_" + ++tmpCounter, name: f.type + "-" + Math.random().toString(36).slice(2, 6), type: f.type };
        // Only explicit prefills become values (working examples and real
        // product defaults). Placeholders are hints; required fields
        // without a prefill stay empty and are flagged in the inspector.
        for (const fd of f.fields) {
          if (fd.kind === "clocklist" && fd.prefill) w[fd.key] = linesToFields(fd.prefill).map((f) => ({ label: f.label, tz: f.path }));
          else if (fd.kind === "linklist" && fd.prefill) w[fd.key] = linesToFields(fd.prefill).map((f) => ({ title: f.label, url: f.path }));
          else if (fd.kind === "strlist" && fd.prefill) w[fd.key] = fd.prefill.split(/[,s]+/).filter(Boolean);
          else if (fd.kind === "json" && fd.prefill) { try { w[fd.key] = JSON.parse(fd.prefill); } catch (e) {} }
          else if (fd.kind === "fieldmap" && fd.prefill) w[fd.key] = linesToFields(fd.prefill);
          else if (fd.prefill !== undefined && w[fd.key] === undefined) w[fd.key] = fd.kind === "number" ? Number(fd.prefill) : fd.prefill;
        }
        if (f.type === "mcp" && !w.description) w.description = mcpQueryText(w);
        draft.pages[pageIdx].rows[galleryTargetRow].columns[galleryTargetCol].widgets.push(w);
        selected = { kind: "widget", wid: w.id };
        $("gallery-dialog").close();
        optimisticWidget(galleryTargetRow, galleryTargetCol, w.title || f.title);
        pendingEnter = 'section.widget[data-wid="' + w.id + '"]';
        changed(true);
        probeWidget(w.id);
      });
      list.appendChild(b);
    }
  }
  if (!list.childNodes.length) list.appendChild(el("p", "meta", "No matches."));
}
$("gallery-search").addEventListener("input", (e) => renderGallery(e.target.value));

// ---------- yaml view ----------
let yamlOpen = false;
let yamlDirty = false;
async function applyYaml() {
  const { data } = await api("/settings/editor/parse", { yaml: $("yaml-text").value });
  if (data.error) {
    $("yaml-msg").textContent = data.error;
    $("yaml-msg").className = "error";
    return false;
  }
  draft = data.doc;
  if (pageIdx >= draft.pages.length) pageIdx = 0;
  selected = null;
  yamlDirty = false;
  $("yaml-msg").textContent = "applied to draft";
  $("yaml-msg").className = "meta";
  changed();
  return true;
}
async function toggleYaml() {
  if (!yamlOpen) {
    const { data } = await api("/settings/editor/yaml", { doc: draft });
    if (data.error) { alert("Draft invalid: " + data.error); return; }
    $("yaml-text").value = data.yaml;
    yamlDirty = false;
    $("yaml-msg").textContent = "";
    $("yaml-pane").hidden = false;
    $("preview").hidden = true;
    yamlOpen = true;
  } else {
    // never silently discard YAML edits: apply them, or stay here until
    // the user fixes or explicitly discards them
    if (yamlDirty) {
      const ok = await applyYaml();
      if (!ok) {
        $("yaml-msg").textContent += " - fix it, or press Discard to close without applying";
        return;
      }
    }
    $("yaml-pane").hidden = true;
    $("preview").hidden = false;
    yamlOpen = false;
  }
  $("yaml-btn").setAttribute("aria-pressed", String(yamlOpen));
}
$("yaml-text").addEventListener("input", () => {
  yamlDirty = true;
  $("yaml-msg").textContent = "unapplied YAML edits";
  $("yaml-msg").className = "meta";
});
$("yaml-apply").addEventListener("click", () => { applyYaml(); });
const yamlDiscard = el("button", null, "Discard YAML edits");
yamlDiscard.addEventListener("click", () => {
  yamlDirty = false;
  $("yaml-pane").hidden = true;
  $("preview").hidden = false;
  yamlOpen = false;
  $("yaml-btn").setAttribute("aria-pressed", "false");
});
$("yaml-apply").parentElement.appendChild(yamlDiscard);
$("yaml-btn").addEventListener("click", toggleYaml);

// ---------- version history ----------
function agoText(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const h = Math.round(mins / 60);
  if (h < 48) return h + "h ago";
  return Math.round(h / 24) + "d ago";
}

async function openHistory() {
  const { data } = await api("/settings/editor/history", {});
  const list = $("history-list");
  list.textContent = "";
  for (const item of data.items || []) {
    const rowEl = el("div", "hist-item");
    const head = el("div", "hist-head");
    const label = "v" + item.version + " · " + item.created_by + " · " + agoText(item.created_at) +
      (item.source_version ? " · restored from v" + item.source_version : "") +
      (item.version === data.currentVersion ? " · current" : "");
    head.appendChild(el("strong", null, label));
    if (item.version !== data.currentVersion) {
      const btn = el("button", "btn-accent", "Restore");
      btn.addEventListener("click", async () => {
        const summary = item.restoreSummary.length ? item.restoreSummary.join("\n• ") : "(no differences)";
        if (dirty && !confirm("You have unsaved changes that will be discarded. Continue?")) return;
        if (!confirm("Restore v" + item.version + "? This publishes a new version that:\n• " + summary)) return;
        const { status, data: res } = await api("/settings/editor/restore", { to_version: item.version, csrf: state.csrf });
        if (res.ok) {
          baseVersion = res.version;
          draft = JSON.parse(JSON.stringify(res.doc));
          lastStable = JSON.stringify(draft);
          if (pageIdx >= draft.pages.length) pageIdx = 0;
          dirty = false;
          undoStack.length = 0;
          $("undo-btn").disabled = true;
          $("dirty").textContent = "restored as v" + res.version;
          applyThemeToChrome();
          $("save-btn").disabled = true;
          selected = null;
          $("history-dialog").close();
          renderAll();
          schedulePreview();
          setTimeout(refreshPreview, 4500);
        } else if (status === 409) {
          alert("Config changed concurrently - reopen history and retry.");
        } else {
          alert(res.error || "restore failed");
        }
      });
      head.appendChild(btn);
    }
    rowEl.appendChild(head);
    const ul = el("ul", "hist-changes");
    for (const c of item.changes) ul.appendChild(el("li", null, c));
    rowEl.appendChild(ul);
    list.appendChild(rowEl);
  }
  if (!(data.items || []).length) list.appendChild(el("p", "meta", "No versions."));
  $("history-dialog").showModal();
}
$("history-btn").addEventListener("click", () => openHistory().catch((e) => alert(String(e))));
$("theme-btn").addEventListener("click", () => {
  selected = null;
  renderAll();
  highlightPreview();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && selected !== null && !document.querySelector("dialog[open]")) {
    selected = null;
    renderAll();
    highlightPreview();
  }
});

// ---------- save ----------
let saving = false;

// Success handling shared by plain and rebased saves. If the user edited
// while the request was in flight, those edits are NOT in the published
// doc - keep the local draft, adopt server-assigned ids (matched by the
// immutable widget name), and stay dirty instead of silently reverting.
function applySaveSuccess(data, revAtStart) {
  baseVersion = data.version;
  if (draftRev !== revAtStart) {
    const serverByName = new Map();
    for (const p of data.doc.pages || [])
      for (const r of p.rows || [])
        for (const c of r.columns || [])
          for (const w of c.widgets || []) if (w.name) serverByName.set(w.name, w.id);
    for (const p of draft.pages || [])
      for (const r of p.rows || [])
        for (const c of r.columns || [])
          for (const w of c.widgets || []) {
            if (String(w.id || "").startsWith("tmp_") && serverByName.has(w.name)) w.id = serverByName.get(w.name);
          }
    $("dirty").textContent = "saved v" + data.version + " · edits made during save are still unsaved";
    applyThemeToChrome();
    showToast("Saved v" + data.version + " - kept your newer edits");
    renderAll();
    schedulePreview();
    return;
  }
  draft = JSON.parse(JSON.stringify(data.doc));
  lastStable = JSON.stringify(draft);
  dirty = false;
  undoStack.length = 0;
  $("undo-btn").disabled = true;
  $("dirty").textContent = "saved v" + data.version;
  applyThemeToChrome();
  $("save-btn").disabled = true;
  selected = null;
  renderAll();
  schedulePreview();
  setTimeout(refreshPreview, 4500); // pick up background-fetched data for new widgets
}

// Conflict dialog with three phases: show incoming -> preview the rebased
// combination -> publish it. Blind overwrite of the other session's
// changes is not offered; overlapping edits block with an explanation.
function openConflict({ note, lines, confirmLabel, confirmDisabled, onConfirm }) {
  const list = $("conflict-incoming");
  list.textContent = "";
  for (const line of lines) list.appendChild(el("li", null, line));
  const dlg = $("conflict-dialog");
  dlg.querySelector(".error").textContent = note;
  const confirmBtn = dlg.querySelector('button[value="force"]');
  confirmBtn.textContent = confirmLabel;
  confirmBtn.disabled = !!confirmDisabled;
  dlg.showModal();
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "force") onConfirm();
    else if (dlg.returnValue === "reload") location.reload();
  }, { once: true });
}

function handleConflict(data) {
  openConflict({
    note: "“Merge” rebases your edits onto these changes - nothing from either session is overwritten.",
    lines: data.incoming || [],
    confirmLabel: "Merge my changes with latest",
    onConfirm: async () => {
      const { status, data: prev } = await api("/settings/editor/save", {
        doc: draft, base_version: baseVersion, csrf: state.csrf,
        rebase: true, preview: true, expected_current: data.currentVersion,
      });
      if (status === 409 && prev.conflict) return handleConflict(prev);
      if (prev.conflicts && prev.conflicts.length) {
        openConflict({
          note: "These edits overlap and can’t merge automatically - reload to start from latest, or adjust your draft.",
          lines: prev.conflicts,
          confirmLabel: "Merge my changes with latest",
          confirmDisabled: true,
          onConfirm: () => {},
        });
        return;
      }
      if (prev.error) { alert(prev.error); return; }
      openConflict({
        note: "Publishing applies this combined result.",
        lines: prev.summary || [],
        confirmLabel: "Publish merged result",
        onConfirm: async () => {
          const revAtStart = draftRev;
          const { status: st2, data: res } = await api("/settings/editor/save", {
            doc: draft, base_version: baseVersion, csrf: state.csrf,
            rebase: true, expected_current: data.currentVersion,
          });
          if (res.ok) return applySaveSuccess(res, revAtStart);
          if (st2 === 409 && res.conflict) return handleConflict(res);
          alert(res.error || "save failed");
        },
      });
    },
  });
}

async function doSave(base) {
  if (saving) return;
  saving = true;
  $("save-btn").disabled = true;
  const revAtStart = draftRev;
  try {
    const { status, data } = await api("/settings/editor/save", { doc: draft, base_version: base, csrf: state.csrf });
    if (data.ok) return applySaveSuccess(data, revAtStart);
    if (status === 409 && data.conflict) return handleConflict(data);
    alert(data.error || "save failed");
    $("save-btn").disabled = false;
  } finally {
    saving = false;
  }
}

$("save-btn").addEventListener("click", async () => {
  const { data } = await api("/settings/editor/diff", { doc: draft });
  if (data.error) { alert("Draft invalid: " + data.error); return; }
  const list = $("save-summary");
  list.textContent = "";
  if (!data.summary.length) list.appendChild(el("li", "meta", "No changes."));
  for (const line of data.summary) list.appendChild(el("li", null, line));
  const sens = $("save-sensitive");
  sens.hidden = data.sensitive.length === 0;
  sens.textContent = data.sensitive.length ? "Sensitive: " + data.sensitive.join("; ") : "";
  const cache = $("save-cache");
  cache.hidden = data.cacheClears === 0;
  cache.textContent = "This will clear " + data.cacheClears + " cached response" + (data.cacheClears === 1 ? "" : "s") + ".";
  const dlg = $("save-dialog");
  dlg.showModal();
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "confirm") doSave(baseVersion);
  }, { once: true });
});

// ---------- undo ----------
function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  draft = JSON.parse(prev);
  lastStable = prev;
  if (pageIdx >= draft.pages.length) pageIdx = 0;
  if (undoStack.length === 0) $("undo-btn").disabled = true;
  markDirty();
  renderAll();
  schedulePreview();
}
$("undo-btn").addEventListener("click", undo);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !yamlOpen) { e.preventDefault(); undo(); }
});
window.addEventListener("beforeunload", (e) => {
  if (!dirty && !yamlDirty) return;
  e.preventDefault();
  e.returnValue = ""; // legacy engines require returnValue for the prompt
});

// ---------- outline panel sizing ----------
// Narrower than this the panel stops being readable - even with the
// buttons wrapped to their own row, the title has nowhere to go. Collapse
// (0) is the way to reclaim the space, not a sliver of a panel.
const OUTLINE_MIN = 180;
const OUTLINE_MAX = 480;
function initOutlinePanel() {
  const grid = document.querySelector(".editor-grid");
  const saved = localStorage.getItem("mindash-outline-w");
  if (saved === "0") grid.classList.add("outline-collapsed");
  // a width stored before this minimum existed is clamped on the way in
  else if (saved) {
    const w = Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, parseInt(saved) || 230));
    document.body.style.setProperty("--outline-w", w + "px");
  }

  const bar = el("div", "outline-resizer");
  bar.title = "Drag to resize · double-click to collapse";
  bar.addEventListener("dblclick", () => {
    grid.classList.toggle("outline-collapsed");
    localStorage.setItem("mindash-outline-w", grid.classList.contains("outline-collapsed") ? "0" : String(parseInt(getComputedStyle(grid).getPropertyValue("--outline-w")) || 230));
  });
  bar.addEventListener("mousedown", (e) => {
    // a collapsed rail has no width to drag: resizing from here used to
    // silently expand it, which is the toggle's job (or a double-click)
    if (grid.classList.contains("outline-collapsed")) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = $("outline").getBoundingClientRect().width || 230;
    const move = (ev) => {
      const w = Math.min(OUTLINE_MAX, Math.max(OUTLINE_MIN, startW + ev.clientX - startX));
      grid.classList.remove("outline-collapsed");
      document.body.style.setProperty("--outline-w", w + "px");
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const w = parseInt(getComputedStyle(grid).getPropertyValue("--outline-w")) || 230;
      localStorage.setItem("mindash-outline-w", String(w));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  $("outline").after(bar);

  const toggle = el("button", "outline-toggle");
  const syncToggle = () => {
    const hidden = grid.classList.contains("outline-collapsed");
    // The icon is the panel's identity and never changes; expanded, the
    // label names the panel ("First" below it is a page name, which never
    // said what this panel IS) and the chevron says which way it goes.
    toggle.textContent = hidden ? "▤" : "« ▤ Page structure";
    toggle.title = hidden ? "Show structure panel" : "Hide structure panel";
    toggle.setAttribute("aria-label", hidden ? "Show structure panel" : "Hide structure panel");
    toggle.setAttribute("aria-expanded", String(!hidden));
  };
  toggle.addEventListener("click", () => {
    grid.classList.toggle("outline-collapsed");
    localStorage.setItem("mindash-outline-w", grid.classList.contains("outline-collapsed") ? "0" : String(parseInt(getComputedStyle(grid).getPropertyValue("--outline-w")) || 230));
    syncToggle();
  });
  bar.addEventListener("dblclick", syncToggle);
  syncToggle();
  // on the panel itself (its top-left), not in the top bar - a grid child
  // rather than an #outline child, so it survives the panel's re-renders
  // and stays visible once the panel is a rail
  grid.appendChild(toggle);
}
initOutlinePanel();

// ---------- inspector panel collapse ----------
// The mirror of the structure toggle, on the other side: 320px of
// inspector is a lot of canvas to give up when you are arranging a
// layout rather than configuring one widget. Mobile ignores this - the
// inspector is a bottom sheet there, driven by selection.
function initInspectorToggle() {
  const grid = document.querySelector(".editor-grid");
  if (localStorage.getItem("mindash-inspector-collapsed") === "1") grid.classList.add("inspector-collapsed");
  const toggle = el("button", "inspector-toggle");
  const sync = () => {
    const hidden = grid.classList.contains("inspector-collapsed");
    // mirrors the structure header opposite it: icon + name + the way out
    toggle.textContent = hidden ? "\u{1F50D}" : "\u{1F50D} Inspector »";
    toggle.title = hidden ? "Show inspector panel" : "Hide inspector panel";
    toggle.setAttribute("aria-label", hidden ? "Show inspector panel" : "Hide inspector panel");
    toggle.setAttribute("aria-expanded", String(!hidden));
  };
  toggle.addEventListener("click", () => setInspectorCollapsed(!inspectorCollapsed()));
  // the mobile sheet header writes the same flag, so this label follows it
  document.addEventListener("mindash-inspector-toggled", sync);
  document.addEventListener("mindash-inspector-toggled", syncSheetHandle);
  sync();
  // on the panel itself (its top-right), for the same reasons as the
  // structure toggle opposite it
  grid.appendChild(toggle);
  // The toggle sits beside the inspector's scrollbar, so it needs that
  // gutter's real width - it differs by platform (overlay scrollbars
  // measure 0). scrollbar-gutter: stable holds it constant, so measuring
  // once here stays correct as the panel's content changes.
  const insp = document.getElementById("inspector");
  const syncGutter = () => {
    document.body.style.setProperty("--insp-sb", Math.max(0, insp.offsetWidth - insp.clientWidth) + "px");
  };
  syncGutter();
  window.addEventListener("resize", syncGutter);
}
initInspectorToggle();

function selToken() {
  if (!selected) return "";
  if (selected.kind === "widget") return ";s=w:" + selected.wid;
  if (selected.kind === "row") return ";s=r:" + selected.rowIdx;
  if (selected.kind === "column") return ";s=c:" + selected.rowIdx + "." + selected.colIdx;
  if (selected.kind === "page") return ";s=pg";
  return "";
}

function renderAll() {
  history.replaceState(null, "", "#p=" + pageIdx + selToken());
  renderTabs();
  renderOutline();
  renderInspector();
}
renderAll();
refreshPreview();
