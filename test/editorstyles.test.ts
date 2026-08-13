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
    /padding: 0 0\.75rem calc\(0\.75rem \+ env\(safe-area-inset-bottom, 0px\)\)/,
    "the sheet restores safe-area-aware content padding without a top inset",
  );
});

test("the mobile inspector rests as a row rather than hiding entirely", () => {
  assert.match(mobileQuery, /\.sheet-handle \{[^}]*position: sticky[^}]*top: 0/, "the toggle rises as the sheet header");
  assert.match(mobileQuery, /translateY\(calc\(100% - var\(--sheet-peek\)\)\)/, "the closed sheet leaves its header visible");
  assert.match(mobileQuery, /#inspector\.open[^{]*\{[^}]*translateY\(0\)/, "and slides fully open");
  assert.match(mobileQuery, /height: 44px; min-height: 44px/, "the handle has a full touch target");
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
    /\.inspector-content \{[\s\S]*width: var\(--inspector-expanded-w, 320px\);[\s\S]*transition: transform 0\.2s ease;/,
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

test("the interval control is a quantity plus a unit on one row", () => {
  assert.match(EDITOR_CSS, /\.interval-row \{[^}]*display: flex/, "qty and unit share a line");
  assert.match(EDITOR_CSS, /\.interval-qty \{[^}]*width:/, "the number stays narrow");
  assert.match(EDITOR_CSS, /\.interval-unit \{[^}]*flex: 1/, "the unit takes the rest");
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
