import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListSpec, extractList } from "../src/widgets/listmap";
import { parseHelpers } from "../src/widgets/def";

// item_meta carries several facts on one line: an issue list wants the
// project AND the status, not a choice between them.
const spec = (over: Record<string, unknown>) =>
  parseListSpec({ items: ".", item_title: "title", ...over }, "w", parseHelpers)!;

const ISSUES = [
  { title: "Embed the table", project: "FocusRFP", status: "open", due_date: null, url: "https://t.example/p/FOCUS/13" },
  { title: "Line item analysis", project: "FocusRFP", status: "in progress", due_date: "2026-09-01", url: "https://t.example/p/FOCUS/8" },
];

test("item_meta joins several paths, skipping the ones with no value", () => {
  const rows = extractList(ISSUES, spec({ item_meta: "project, status, due_date", item_url: "url" }));
  assert.equal(rows[0]!.meta, "FocusRFP · open");                     // null due_date drops out
  assert.equal(rows[1]!.meta, "FocusRFP · in progress · 2026-09-01"); // all three present
  assert.equal(rows[0]!.url, "https://t.example/p/FOCUS/13");
});

test("a single item_meta path behaves exactly as before", () => {
  const rows = extractList(ISSUES, spec({ item_meta: "status" }));
  assert.equal(rows[0]!.meta, "open");
  assert.equal(rows[1]!.meta, "in progress");
});

test("an item whose meta paths all miss gets no meta line at all", () => {
  const rows = extractList([{ title: "Bare" }], spec({ item_meta: "project, status" }));
  assert.equal(rows[0]!.meta, undefined);
});

test("meta paths are validated and bounded", () => {
  assert.throws(() => spec({ item_meta: "project, sta tus" }), /bad path/);
  assert.throws(() => spec({ item_meta: "a, b, c, d, e" }), /at most 4/);
  assert.throws(() => spec({ item_meta: " , " }), /no paths/);
});
