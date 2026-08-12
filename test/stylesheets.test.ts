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
