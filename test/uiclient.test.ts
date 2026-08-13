import { test } from "node:test";
import assert from "node:assert/strict";
import schedulerSrc from "../src/autorefresh.client.js";
import { UI_JS } from "../src/uilive";

// The scheduler ships as text (it is browser code, not a module the
// Worker imports), so the tests EXECUTE that exact text and exercise the
// real function. Asserting on the source string would pass for a broken
// implementation that merely contained the right words.
const decide = new Function(`${schedulerSrc}; return decideAutoRefresh;`)() as (s: {
  now: number;
  lastAttempt: number;
  hidden: boolean;
  inFlight: boolean;
}) => { action: string; delay?: number };

const FIVE_MIN = 300_000;
const state = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  now: 1_000_000,
  lastAttempt: 1_000_000,
  hidden: false,
  inFlight: false,
  ...over,
});

test("hidden tabs schedule nothing, however overdue they are", () => {
  assert.deepEqual(decide(state({ hidden: true })), { action: "cancel" });
  assert.deepEqual(
    decide(state({ hidden: true, lastAttempt: 1_000_000 - FIVE_MIN * 10 })),
    { action: "cancel" },
    "a tab hidden for an hour still must not fetch",
  );
});

test("a visible tab waits out the remainder of the interval", () => {
  const d = decide(state({ lastAttempt: 1_000_000 - 60_000 }));
  assert.equal(d.action, "wait");
  assert.equal(d.delay, FIVE_MIN - 60_000);
});

test("returning after the full interval refreshes immediately", () => {
  assert.equal(decide(state({ lastAttempt: 1_000_000 - FIVE_MIN })).action, "run");
  assert.equal(decide(state({ lastAttempt: 1_000_000 - FIVE_MIN * 12 })).action, "run");
});

test("an in-flight request absorbs bursts of events instead of fanning out", () => {
  // visibilitychange can fire several times in quick succession; while a
  // fetch is running every one of them must be a no-op, since the
  // completion handler is what schedules the next attempt.
  for (const s of [state({ inFlight: true }), state({ inFlight: true, lastAttempt: 0 })]) {
    assert.deepEqual(decide(s), { action: "none" });
  }
});

test("repeated events before the interval never turn into extra requests", () => {
  const lastAttempt = 1_000_000;
  for (const tick of [0, 1, 50, 1_000, FIVE_MIN - 1]) {
    const d = decide(state({ now: lastAttempt + tick, lastAttempt }));
    assert.equal(d.action, "wait", `t+${tick}ms must not fire a request`);
    assert.equal(d.delay, FIVE_MIN - tick);
  }
});

test("a failed attempt still counts: no immediate-retry loop on visibility flips", () => {
  // The wiring stamps lastAttempt BEFORE fetching, so a request that
  // failed a second ago looks exactly like one that succeeded a second
  // ago - the next attempt is a full interval away either way.
  const justAttempted = decide(state({ now: 1_000_000 + 1_000, lastAttempt: 1_000_000 }));
  assert.equal(justAttempted.action, "wait");
  assert.ok(justAttempted.delay! > 0);
});

test("the shipped script wires the scheduler up and drops the blind interval", () => {
  // One integration check over the served bundle: the behaviour above is
  // worthless if the page never calls it.
  assert.ok(!/setInterval\s*\([^)]*loadInto/.test(UI_JS), "no unconditional interval refresh");
  assert.match(UI_JS, /addEventListener\("visibilitychange", scheduleAutoRefresh\)/);
  assert.match(UI_JS, /function decideAutoRefresh/, "the decision ships with the wiring");
  // the attempt is stamped before the fetch, not in the callback
  assert.match(UI_JS, /lastAutoRefreshAttempt = Date\.now\(\);\s*\n\s*autoRefreshInFlight = true;/);
});
