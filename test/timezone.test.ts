import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDoc } from "../src/config";
import type { ClockWidget } from "../src/widgets/clock";
import type { CountdownWidget } from "../src/widgets/countdown";
import type { CalendarWidget } from "../src/widgets/calendar";

function doc(timezone: string | undefined, widgets: Record<string, unknown>[]) {
  return {
    theme: {},
    ...(timezone ? { timezone } : {}),
    pages: [{ name: "Home", rows: [{ columns: [{ width: "full", widgets }] }] }],
  };
}

const byName = (r: ReturnType<typeof validateDoc>["runtime"], name: string) =>
  r.widgets.find((w) => w.name === name)!;

test("document timezone is validated and echoed back in the raw doc", () => {
  const { doc: raw, runtime } = validateDoc(
    doc("Europe/Berlin", [{ id: "w_1", name: "n", type: "note", text: "hi" }]),
  );
  assert.equal(raw.timezone, "Europe/Berlin");
  assert.equal(runtime.timezone, "Europe/Berlin");
  assert.throws(() => validateDoc(doc("Mars/Olympus", [{ id: "w_1", name: "n", type: "note", text: "hi" }])), /unknown timezone/);
  // absent stays absent - existing documents are untouched
  assert.equal(validateDoc(doc(undefined, [{ id: "w_1", name: "n", type: "note", text: "hi" }])).doc.timezone, undefined);
});

test("time-bearing widgets inherit the document zone; their own field still wins", () => {
  const { runtime } = validateDoc(
    doc("Europe/Berlin", [
      { id: "w_1", name: "cd-inherit", type: "countdown", target: "2027-01-01" },
      { id: "w_2", name: "cd-own", type: "countdown", target: "2027-01-01", tz: "Asia/Tokyo" },
      { id: "w_3", name: "cal-inherit", type: "calendar", url: "https://ex.example/c.ics", refresh_interval: "1h" },
      { id: "w_4", name: "cal-own", type: "calendar", url: "https://ex.example/c.ics", refresh_interval: "1h", tz: "Asia/Tokyo" },
    ]),
  );
  assert.equal((byName(runtime, "cd-inherit") as CountdownWidget).tz, "Europe/Berlin");
  assert.equal((byName(runtime, "cd-own") as CountdownWidget).tz, "Asia/Tokyo");
  assert.equal((byName(runtime, "cal-inherit") as CalendarWidget).tz, "Europe/Berlin");
  assert.equal((byName(runtime, "cal-own") as CalendarWidget).tz, "Asia/Tokyo");
});

test("countdown epoch shifts with the inherited zone (not UTC)", () => {
  const target = "2027-01-01 12:00";
  const utc = validateDoc(doc(undefined, [{ id: "w_1", name: "cd", type: "countdown", target }]));
  const berlin = validateDoc(doc("Europe/Berlin", [{ id: "w_1", name: "cd", type: "countdown", target }]));
  const { countdownEpoch } = require("../src/widgets/countdown") as typeof import("../src/widgets/countdown");
  const utcMs = countdownEpoch(target, (byName(utc.runtime, "cd") as CountdownWidget).tz);
  const berlinMs = countdownEpoch(target, (byName(berlin.runtime, "cd") as CountdownWidget).tz);
  // Berlin is UTC+1 in January: the same wall clock is an hour earlier
  assert.equal(utcMs - berlinMs, 3600_000);
});

test("clock with no list: document zone yields one local clock, else the classic trio", () => {
  const local = validateDoc(doc("Europe/Berlin", [{ id: "w_1", name: "c", type: "clock" }]));
  const clocks = (byName(local.runtime, "c") as ClockWidget).clocks;
  assert.deepEqual(clocks, [{ label: "Berlin", tz: "Europe/Berlin" }]);
  const trio = validateDoc(doc(undefined, [{ id: "w_1", name: "c", type: "clock" }]));
  assert.equal((byName(trio.runtime, "c") as ClockWidget).clocks.length, 3);
  // an explicit list is never overridden
  const explicit = validateDoc(
    doc("Europe/Berlin", [{ id: "w_1", name: "c", type: "clock", clocks: [{ label: "NY", tz: "America/New_York" }] }]),
  );
  assert.deepEqual((byName(explicit.runtime, "c") as ClockWidget).clocks, [{ label: "NY", tz: "America/New_York" }]);
});
