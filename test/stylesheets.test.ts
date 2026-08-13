import { test } from "node:test";
import assert from "node:assert/strict";
import { CSS } from "../src/styles";
import { EDITOR_CSS } from "../src/editor/styles";

// Both stylesheets are template literals, so ONE stray backtick in a
// comment silently truncates the rest of the file - the page still loads,
// typechecks, and serves 200, it is just unstyled from that point on.
// (That is exactly how this test came to exist.) Each sheet is checked for
// a selector near its end, which no truncation can survive.
const SHEETS: [string, string, string[]][] = [
  ["styles.ts", CSS, ["section.widget", "ul.feed", ".claim-note", ".card-stamp"]],
  ["editor/styles.ts", EDITOR_CSS, [".editor-grid", ".outline-toggle", ".sheet-handle", ".gal-item"]],
];

test("stylesheets: not truncated by a stray backtick", () => {
  for (const [name, sheet, selectors] of SHEETS) {
    assert.ok(sheet.length > 5_000, `${name} is only ${sheet.length} bytes - truncated?`);
    for (const sel of selectors) {
      assert.ok(sheet.includes(sel), `${name} lost "${sel}" - the literal ends early`);
    }
  }
});

test("stylesheets: braces balance, so no rule is left half-written", () => {
  for (const [name, sheet] of SHEETS) {
    const open = (sheet.match(/{/g) ?? []).length;
    const close = (sheet.match(/}/g) ?? []).length;
    assert.equal(open, close, `${name} has ${open} { and ${close} }`);
  }
});

test("dashboard bottom padding matches its side padding", () => {
  assert.match(CSS, /main \{[^}]*padding: 1rem 1\.25rem 1\.25rem;/);
});

test("collapsed dashboard navigation reveals as an overlay without reflow", () => {
  assert.match(CSS, /body\.nav-collapsed \.dashboard-chrome \{[^}]*transform: translateY\(-100%\);[^}]*visibility: hidden;/);
  assert.doesNotMatch(CSS, /body\.nav-collapsed > main \{[^}]*padding-top:/);
  assert.match(CSS, /body\.nav-collapsed \.dashboard-chrome \{[^}]*position: fixed;[^}]*top: 0;/);
  assert.match(CSS, /body\.nav-collapsed\.nav-open \.dashboard-chrome \{[^}]*transform: translateY\(0\);[^}]*visibility: visible;/);
  assert.match(CSS, /\.nav-reveal \{[^}]*position: absolute;[^}]*top: 100%; left: 50%;[^}]*width: 3rem; height: 1\.5rem;/);
  assert.match(CSS, /\.nav-reveal \{[^}]*transform: translateX\(-50%\);/);
  assert.match(CSS, /\.nav-reveal \{[^}]*background: var\(--bg\);[^}]*opacity: 1;/);
  assert.match(CSS, /\.nav-reveal:hover, \.nav-reveal:focus-visible \{[^}]*background: color-mix\(in srgb, var\(--bg\) 92%, var\(--text\) 8%\)/);
  assert.match(CSS, /body\.nav-collapsed\.nav-open \.nav-reveal span \{ transform: rotate\(225deg\); \}/);
  assert.match(CSS, /body\.kiosk \.nav-reveal \{ display: none; \}/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*body\.nav-collapsed \.dashboard-chrome \{ transition: none; \}/);
});
