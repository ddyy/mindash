import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLog, LOG_LEVELS, type MessageRow } from "../src/push/log";
import { validateDoc, type LogWidget } from "../src/config";
import { WIDGET_FORMS } from "../src/widgetforms";

const docWith = (w: object) => ({
  pages: [{ name: "Home", rows: [{ columns: [{ width: "full", widgets: [{ id: "w_log", ...w }] }] }] }],
});
const widget = (over: object = {}) => ({ name: "deploy-log", type: "log", title: "Log", ...over });

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  msg_id: "m1", level: "info", text: "hello", created_at: Date.now() - 60_000, ...over,
});

function cfg(over: object = {}): LogWidget {
  return validateDoc(docWith(widget(over))).runtime.widgets[0] as LogWidget;
}

test("log: parses with defaulted limit, clamps, no schedule fields", () => {
  const w = cfg();
  assert.equal(w.type, "log");
  assert.equal(w.limit, 8);
  assert.equal(w.refreshSeconds, 0);
  assert.equal(cfg({ limit: 99 }).limit, 30);
  assert.equal(cfg({ limit: 0 }).limit, 1);
});

test("log: renders lines newest-first with levels; text is escaped", () => {
  const out = renderLog(cfg(), [
    row({ text: "<script>alert(1)</script>", level: "error" }),
    row({ msg_id: "m2", text: "ok done", level: "nonsense" }),
  ]).value;
  assert.ok(out.includes("lvl-error"));
  assert.ok(!out.includes("<script>alert")); // escaped
  assert.ok(out.includes("&lt;script&gt;"));
  assert.ok(out.includes("lvl-info")); // unknown level normalizes
  assert.ok(out.includes("m ago") || out.includes("min"));
});

test("log: empty state shows the push endpoint hint", () => {
  const out = renderLog(cfg(), []).value;
  assert.ok(out.includes("No messages yet"));
  assert.ok(out.includes("/push/deploy-log"));
});

test("log: levels set is the ingest contract", () => {
  assert.deepEqual([...LOG_LEVELS].sort(), ["error", "info", "warn"]);
});

test("log: gallery form registered next to heartbeat with common fields", () => {
  const idx = WIDGET_FORMS.findIndex((f) => f.type === "log");
  const hb = WIDGET_FORMS.findIndex((f) => f.type === "heartbeat");
  assert.ok(idx !== -1);
  assert.equal(idx, hb + 1);
  const keys = WIDGET_FORMS[idx]!.fields.map((f) => f.key);
  assert.ok(keys.includes("title") && keys.includes("description") && keys.includes("limit"));
});
