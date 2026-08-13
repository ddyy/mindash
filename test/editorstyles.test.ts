import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITOR_CSS } from "../src/editor/styles";
import { EDITOR_JS } from "../src/editor/client";

// The mobile layout has no inspector toggle, so a collapsed state
// persisted from desktop (localStorage) must not survive the breakpoint:
// visibility:hidden there would strand the panel with no way back. These
// assert the source contract; the rendered behaviour (resting row at the
// bottom, sliding open) was verified in a browser at 375px and 1280px.
const mobileQuery = (() => {
  const i = EDITOR_CSS.indexOf("@media (max-width: 900px)");
  assert.ok(i > 0, "mobile media query exists");
  return EDITOR_CSS.slice(i);
})();

test("a desktop-collapsed inspector is neutralized at the mobile breakpoint", () => {
  assert.match(
    mobileQuery,
    /\.editor-grid\.inspector-collapsed #inspector[^{]*\{[^}]*visibility: visible/,
    "the mobile query must out-specify the collapsed visibility:hidden",
  );
  assert.match(
    mobileQuery,
    /padding: 0 0 env\(safe-area-inset-bottom, 0px\)/,
    "the sheet keeps only safe-area bottom padding so its scrollbar reaches the edge",
  );
});

test("the Structure rail is completely absent on mobile", () => {
  assert.match(
    mobileQuery,
    /\.editor-grid \.outline-resizer,[\s\S]*\.editor-grid\.outline-collapsed \.outline-toggle,[\s\S]*\{ display: none; \}/,
    "the mobile rule out-specifies the desktop collapsed-rail display rule",
  );
  assert.match(
    mobileQuery,
    /#outline, \.editor-grid\.outline-collapsed #outline \{ display: none; \}/,
    "both expanded and persisted-collapsed Structure panels are hidden",
  );
});

test("the mobile inspector keeps its handle but hides its scrollbar when minimized", () => {
  assert.match(mobileQuery, /#inspector, \.editor-grid\.inspector-collapsed #inspector \{[\s\S]*position: fixed; z-index: 40;/, "the sheet paints above sticky preview widget titles");
  assert.match(mobileQuery, /\.sheet-handle \{[^}]*position: sticky[^}]*top: 0/, "the toggle rises as the sheet header");
  assert.match(mobileQuery, /translateY\(calc\(100% - var\(--sheet-peek\)\)\)/, "the closed sheet leaves its handle visible");
  assert.match(mobileQuery, /#inspector\.open[^{]*\{[^}]*translateY\(0\)/, "and slides fully open");
  assert.match(mobileQuery, /height: 44px; min-height: 44px/, "the handle has a full touch target");
  assert.match(mobileQuery, /#inspector[^}]*overflow: hidden; scrollbar-gutter: auto;/, "the sheet itself never paints a scrollbar beside its title");
  assert.match(mobileQuery, /#inspector:not\(\.open\) \{ scrollbar-width: none; \}/, "the minimized sheet has no scrollbar");
  assert.match(mobileQuery, /#inspector:not\(\.open\)::\-webkit-scrollbar \{ display: none; \}/, "WebKit also hides the minimized scrollbar");
  assert.match(mobileQuery, /transform-origin: 50% 50%/, "the chevron rotates without shifting its box");
  assert.match(
    mobileQuery,
    /#center \{[^}]*padding-top: 1\.25rem; padding-bottom: 1\.25rem/,
    "the preview's vertical padding equals its side padding",
  );
  assert.match(
    mobileQuery,
    /#center::after \{[^}]*height: calc\([^}]*44px[^}]*safe-area-inset-bottom/,
    "a separate spacer reserves room for the collapsed handle",
  );
});

test("the mobile Inspector scrollbar starts below its title", () => {
  assert.match(
    mobileQuery,
    /#inspector\.open \.inspector-content \{[^}]*max-height: calc\(55vh - 44px - env[^}]*overflow-y: auto; scrollbar-gutter: stable;/,
    "only the content below the 44px title handle scrolls",
  );
  assert.match(mobileQuery, /\.sheet-handle \{[^}]*width: 100%; margin: 0;/, "no margin separates the scrollbar from the title");
});

test("the mobile Inspector scrollbar hugs the right edge while content stays padded", () => {
  assert.match(
    mobileQuery,
    /#inspector, \.editor-grid\.inspector-collapsed #inspector[\s\S]*padding: 0 0 env\(safe-area-inset-bottom, 0px\)/,
    "the sheet does not inset its scroll container",
  );
  assert.match(
    mobileQuery,
    /#inspector\.open \.inspector-content \{[^}]*overflow-y: auto; scrollbar-gutter: stable;[^}]*padding: 0\.5rem 0\.75rem 0\.75rem;/,
    "padding belongs to the scrolling content, inside the edge-aligned scrollbar",
  );
});

test("the page-tab strip shrinks so editor actions stay reachable", () => {
  const desktop = EDITOR_CSS.slice(0, EDITOR_CSS.indexOf("@media (max-width: 900px)"));
  assert.match(desktop, /#page-tabs \{[^}]*min-width: 0/, "tabs are the shrinkable region");
  assert.match(desktop, /#page-tabs \{[^}]*overflow-x: auto/, "and scroll instead of pushing");
  assert.match(desktop, /\.editor-actions \{[^}]*flex: none/, "actions never shrink");
});

test("desktop side columns animate without forcing motion", () => {
  assert.match(
    EDITOR_CSS,
    /\.editor-grid \{ transition: grid-template-columns 0\.2s ease; \}/,
    "the preview and both side rails resize as one grid animation",
  );
  assert.match(EDITOR_CSS, /transition: margin-left 0\.2s ease/, "page tabs follow the structure rail");
  assert.match(
    EDITOR_CSS,
    /\.outline-content \{[\s\S]*width: calc\(var\(--outline-expanded-w, 230px\) - var\(--outline-chrome, 1px\)\);[\s\S]*transition: transform 0\.2s ease;/,
    "structure content keeps its expanded layout while sliding",
  );
  assert.match(
    EDITOR_CSS,
    /\.inspector-content \{[\s\S]*width: calc\(var\(--inspector-expanded-w, 320px\) - var\(--insp-sb, 1px\)\);[\s\S]*transition: transform 0\.2s ease;/,
    "inspector content keeps its expanded layout while sliding",
  );
  assert.match(
    EDITOR_CSS,
    /\.editor-grid\.outline-collapsed \.outline-content \{[^}]*translateX\(-100%\)/,
    "structure slides outward through its clipped panel",
  );
  assert.match(
    EDITOR_CSS,
    /\.editor-grid\.inspector-collapsed \.inspector-content \{[^}]*translateX\(100%\)/,
    "inspector slides outward through its clipped panel",
  );
  assert.match(
    EDITOR_CSS,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.editor-grid, #page-tabs, \.outline-toggle, \.inspector-toggle,[\s\S]*\.outline-content, \.inspector-content \{ transition: none; \}/,
    "reduced-motion users get an immediate state change",
  );
});

test("collapsed desktop rails are full-height directional controls", () => {
  assert.match(
    EDITOR_CSS,
    /\.editor-grid\.inspector-collapsed \.inspector-toggle,[\s\S]*\.editor-grid\.outline-collapsed \.outline-toggle \{[\s\S]*bottom: 0; height: auto;/,
    "the entire rail is clickable",
  );
  assert.match(
    EDITOR_CSS,
    /\.editor-grid \.rail-icon \{[\s\S]*top: 0;[\s\S]*height: var\(--band-h\);[\s\S]*border-bottom: 1px solid var\(--border\)/,
    "panel identity stays in a ruled header band at the top",
  );
  assert.match(EDITOR_CSS, /\.editor-grid \.rail-arrow \{[\s\S]*top: 50%; left: 50%;[\s\S]*translate\(-50%, -50%\)/, "the arrow alone is centered");
  assert.match(EDITOR_JS, /el\("span", "rail-arrow", "›"\)/, "structure points into the opening panel");
  assert.match(EDITOR_JS, /el\("span", "rail-arrow", "‹"\)/, "inspector points into the opening panel");
});

test("the structure resize gutter disappears with the collapsed panel", () => {
  assert.match(
    EDITOR_CSS,
    /\.editor-grid\.outline-collapsed \.outline-resizer \{ visibility: hidden; cursor: default; \}/,
    "the minimized structure rail has no draggable gutter",
  );
});

test("open Structure compensates its right padding for the scrollbar gutter", () => {
  assert.match(
    EDITOR_CSS,
    /\.outline-content \{[\s\S]*padding: calc\(var\(--band-h\) \+ 0\.55rem\) max\(0px, calc\(0\.75rem - var\(--outline-chrome, 1px\)\)\) 0\.75rem 0\.75rem;/,
    "the visible right inset matches the left inset across scrollbar styles",
  );
});

test("Inspector preserves its right padding inside the scrollbar gutter", () => {
  assert.match(
    EDITOR_CSS,
    /\.inspector-content \{[\s\S]*width: calc\(var\(--inspector-expanded-w, 320px\) - var\(--insp-sb, 1px\)\);[\s\S]*padding: calc\(var\(--band-h\) \+ 0\.55rem\) 0\.75rem 0\.75rem;/,
    "the full-size sliding surface fits inside the panel's usable width",
  );
});

test("the desktop Inspector has a bounded persistent resize grip", () => {
  assert.match(EDITOR_CSS, /grid-template-columns: var\(--outline-w\) 6px minmax\(0, 1fr\) 6px var\(--inspector-w\)/);
  assert.match(EDITOR_CSS, /\.inspector-resizer \{[^}]*cursor: col-resize/);
  assert.match(EDITOR_CSS, /\.editor-grid\.inspector-collapsed \.inspector-resizer \{ visibility: hidden; cursor: default; \}/);
  assert.match(EDITOR_JS, /const INSPECTOR_MIN = 260;[\s\S]*const INSPECTOR_MAX = 520;/);
  assert.match(EDITOR_JS, /startW \+ startX - ev\.clientX/, "dragging the left edge left widens Inspector");
  assert.match(EDITOR_JS, /localStorage\.setItem\("mindash-inspector-w", String\(w\)\)/, "width persists locally");
  assert.match(EDITOR_JS, /bar\.addEventListener\("dblclick"[\s\S]*INSPECTOR_DEFAULT \+ "px"/, "double-click restores the default width");
  assert.match(mobileQuery, /\.editor-grid \.inspector-resizer,[\s\S]*\{ display: none; \}/, "the resize grip is desktop-only");
});

test("resize gutters remain continuous through the panel title border", () => {
  assert.doesNotMatch(EDITOR_CSS, /\.outline-resizer::before/);
  assert.doesNotMatch(EDITOR_CSS, /\.inspector-resizer::before/);
});

test("inspector fields contrast with the inspector surface", () => {
  assert.match(
    EDITOR_CSS,
    /#inspector select, #inspector textarea, #inspector \.str-chip \{ background: var\(--card\); \}/,
    "editor fields use the card surface while the inspector uses the page background",
  );
});

test("preview widget delete controls remain visibly destructive", () => {
  assert.match(
    EDITOR_CSS,
    /#preview section\.widget \.qd \{[\s\S]*background: hsl\(0 70% 52%\); color: #fff;/,
    "delete buttons are red before hover in every theme",
  );
});

test("fit-screen previews show vertically expandable cards", () => {
  assert.match(
    EDITOR_CSS,
    /#preview main\.fit-screen \.row \{[\s\S]*flex: none !important; min-height: 30rem;[\s\S]*grid-template-rows: auto minmax\(0, 1fr\);/,
    "each fit row supplies safe leftover preview height after its editor handle",
  );
  assert.match(
    EDITOR_CSS,
    /#preview main\.fit-screen \.col > section\.widget \{[\s\S]*flex: 0 0 auto; min-height: auto;/,
    "ordinary cards retain their natural height",
  );
  assert.match(
    EDITOR_CSS,
    /#preview main\.fit-screen \.col > section\.widget\.expand \{ flex: 1 0 auto; \}/,
    "marked cards absorb the column's remaining preview height",
  );
});

test("the preview stacks by pane width instead of browser width", () => {
  assert.match(EDITOR_CSS, /#preview \{ container: dashboard-preview \/ inline-size; \}/);
  assert.match(
    EDITOR_CSS,
    /@container dashboard-preview \(max-width: 760px\)[\s\S]*#preview \.row \{ grid-template-columns: 1fr; \}[\s\S]*#preview \.col \{ grid-column: 1 \/ -1; \}/,
    "the dashboard's existing mobile threshold is measured against the preview pane",
  );
  assert.match(
    EDITOR_CSS,
    /@container dashboard-preview \(max-width: 760px\)[\s\S]*#preview \.col-resize \{ display: none; \}/,
    "stacked columns do not expose an inapplicable horizontal resize grip",
  );
});

test("the interval control is a quantity plus a unit on one row", () => {
  assert.match(EDITOR_CSS, /\.interval-row \{[^}]*display: flex/, "qty and unit share a line");
  assert.match(EDITOR_CSS, /\.interval-qty \{[^}]*width: 4\.5rem; flex: 0 0 4\.5rem;/, "the number's flex basis overrides the global full-width input rule");
  assert.match(EDITOR_CSS, /\.interval-unit \{[^}]*flex: 1 1 7rem; min-width: 7rem;/, "the unit label and native arrow remain visible");
});

// The editor must never commit an interval the server will reject:
// parseInterval enforces a 60-second floor on EVERY path (editor, YAML,
// MCP), so the client applies the same rule before writing the draft.
test("the interval control enforces the server's 60s floor and whole numbers", () => {
  assert.match(EDITOR_JS, /UNIT_SECS\[unit\.value\] \|\| 60\) >= 60/, "computed duration must clear 60s");
  assert.match(EDITOR_JS, /Number\.isInteger\(n\)/, "fractions are rejected, never truncated");
  assert.match(EDITOR_JS, /qty\.validity\.valid/, "native input validity is respected");
  assert.match(EDITOR_JS, /qty\.min = unit\.value === "s" \? "60" : "1"/, "the spinner floor tracks the unit");
});

test("typing in inspector fields activates Save before blur", () => {
  assert.match(
    EDITOR_JS,
    /function markPendingFieldInput\(\)[\s\S]*\$\("save-btn"\)\.disabled = false;/,
    "pending text makes Save immediately available",
  );
  assert.match(
    EDITOR_JS,
    /\$\("inspector"\)\.addEventListener\("input",[\s\S]*markPendingFieldInput\(\)/,
    "the behavior is delegated across re-rendered inspector fields",
  );
  assert.match(
    EDITOR_JS,
    /if \(pendingFieldInput && document\.activeElement instanceof HTMLElement\)[\s\S]*document\.activeElement\.blur\(\);[\s\S]*\/settings\/editor\/diff/,
    "Save commits the visible field value before computing its diff",
  );
});

test("the page Inspector exposes collapsed navigation", () => {
  assert.match(EDITOR_JS, /collapseNav\.checked = p\.collapse_navigation === true/);
  assert.match(EDITOR_JS, /document\.createTextNode\(" Collapse navigation"\)/);
});

test("structure stays uncluttered and widget moves remain hierarchical", () => {
  assert.doesNotMatch(EDITOR_JS, /const canMove = \{ up:/, "widgets do not repeat four arrow buttons");
  assert.doesNotMatch(EDITOR_JS, /lbl\] of \[\["↑", -1, "Move row up"/, "rows do not repeat movement arrows");
  assert.match(EDITOR_JS, /const pageSel = el\("select"\)/, "cross-page moves choose their page once");
  assert.match(EDITOR_JS, /const group = el\("optgroup"\)[\s\S]*group\.label = rowLabelOf/, "rows group destination columns");
  assert.match(
    EDITOR_JS,
    /"Column " \+ \(ci \+ 1\) \+ " · " \+ c\.width/,
    "column options use compact labels instead of repeated full paths",
  );
});

test("selecting a Structure column highlights its preview column", () => {
  assert.match(
    EDITOR_JS,
    /selected = \{ kind: "column", pageIdx, rowIdx: ri, colIdx: ci \};[\s\S]*renderAll\(\);[\s\S]*highlightPreview\(\);/,
    "Structure column selection updates both inspector and preview selection",
  );
});

test("Structure widget type aligns under its name, not its icon", () => {
  assert.match(EDITOR_JS, /row\.appendChild\(icon\);[\s\S]*text\.appendChild\(el\("span", "t", widgetTitle\(w\)\)\);[\s\S]*text\.appendChild\(el\("span", "ty", w\.type\)\)/);
  assert.match(EDITOR_CSS, /\.ol-w-icon \{[^}]*flex: none/);
});

test("Structure delete stays on the widget row at narrow widths", () => {
  assert.match(EDITOR_CSS, /\.ol-widget \{ flex-wrap: nowrap; \}/);
  assert.match(EDITOR_CSS, /\.ol-widget > \.ol-del \{[^}]*flex: none;[^}]*white-space: nowrap;/);
  assert.doesNotMatch(EDITOR_CSS, /@container \(max-width: 260px\)[\s\S]*\.ol-widget \{ flex-wrap: wrap/);
});

test("Structure rows, columns, and widgets are draggable", () => {
  assert.match(EDITOR_JS, /rowHead\.draggable = true;[\s\S]*draggedRowIdx = ri;/, "row headers start row drags");
  assert.match(EDITOR_JS, /head\.draggable = true;[\s\S]*draggedColRef = \{ ri, ci \};/, "column headers start column drags");
  assert.match(EDITOR_JS, /row\.draggable = true;[\s\S]*draggedWid = w\.id;/, "widget items start widget drags");
  assert.match(
    EDITOR_JS,
    /positionalDropTarget\([\s\S]*?row,[\s\S]*?moveWidgetRelative\(p\.wid, ri, ci, w\.id, position === "after"\)/,
    "dropping on a widget inserts on the indicated side",
  );
  assert.match(EDITOR_CSS, /\.outline-content \.drop-hover \{ outline: 2px dashed var\(--accent\)/, "drop targets are visible");
});

test("dropping a Structure widget on a column header inserts it first", () => {
  assert.match(
    EDITOR_JS,
    /dropTarget\([\s\S]*?head,[\s\S]*?p\.kind === "widget"[\s\S]*?moveWidgetTo\(p\.wid, ri, ci, col\.widgets\[0\]\?\.id \|\| null\)/,
  );
});

test("Structure dragging previews placement in Structure and Preview before drop", () => {
  assert.match(EDITOR_JS, /function previewRowBefore[\s\S]*#outline \.ol-row[\s\S]*#preview \.row/);
  assert.match(EDITOR_JS, /function previewColumnBefore[\s\S]*#outline \.ol-col[\s\S]*#preview \.row/);
  assert.match(EDITOR_JS, /if \(restorePreview && dragPreviewActive\)[\s\S]*renderOutline\(\);[\s\S]*refreshPreview\(\);/, "cancel restores both panes");
  assert.match(EDITOR_JS, /dragPreviewActive = false;\s*onDrop\(payload\);/, "drop commits without first undoing the visual preview");
});

test("widget drag targets distinguish insertion above and below", () => {
  assert.match(EDITOR_JS, /function positionalDropTarget[\s\S]*e\.clientY < box\.top \+ box\.height \/ 2[\s\S]*drop-before[\s\S]*drop-after/);
  assert.match(EDITOR_JS, /moveWidgetRelative\(p\.wid, ri, ci, w\.id, position === "after"\)/);
  assert.match(EDITOR_CSS, /\.ol-widget\.drop-before::before[\s\S]*#preview section\.widget\.drop-after::after/);
  assert.doesNotMatch(EDITOR_JS, /positionalDropTarget\([\s\S]*?row,[\s\S]*?previewWidgetRelative\(p\.wid, w\.id/, "the cue does not move Structure widgets before drop");
});

test("selected Structure widgets restore all four rounded corners", () => {
  assert.match(EDITOR_CSS, /\.ol-widget\.selected \{ border-radius: 5px; \}/);
  assert.ok(
    EDITOR_CSS.indexOf(".ol-widget.selected { border-radius: 5px; }") >
      EDITOR_CSS.indexOf(".ol-widget + .ol-widget"),
    "the selected radius must follow and override the connected-list corners",
  );
});

// Every re-render rebuilds #page-tabs, destroying whatever the keyboard
// was on. Adding and reordering are the two places that happens while a
// tab has focus - reordering worst of all, since it is a repeated key
// press that would otherwise need re-focusing between every press.
test("the tab strip keeps keyboard focus across its own re-render", () => {
  assert.match(
    EDITOR_JS,
    /draft\.pages\.push\([\s\S]*?changed\(\);[\s\S]*?document\.querySelector\('#page-tabs \[aria-selected="true"\]'\)\?\.focus\(\)/,
    "a new page leaves focus on the tab it created",
  );
  assert.match(
    EDITOR_JS,
    /function movePage[\s\S]*?changed\(\);[\s\S]*?tabs\[draft\.pages\.indexOf\(moved\)\]\?\.focus\(\)/,
    "reordering follows the moving page rather than the position",
  );
});
