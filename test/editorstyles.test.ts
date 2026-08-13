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

test("inspector fields contrast with the inspector surface", () => {
  assert.match(
    EDITOR_CSS,
    /#inspector select, #inspector textarea, #inspector \.str-chip \{ background: var\(--card\); \}/,
    "editor fields use the card surface while the inspector uses the page background",
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
