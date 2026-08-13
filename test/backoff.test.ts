import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelayMs, BACKOFF_CAP_MS } from "../src/refresh";
import init from "../migrations/0001_init.sql";
import backoff from "../migrations/0002_backoff.sql";

const MIN = 60_000;

test("backoff: the first failure waits one interval, then doubles", () => {
  const fifteenMin = 15 * 60;
  assert.equal(backoffDelayMs(fifteenMin, 0), 15 * MIN);
  assert.equal(backoffDelayMs(fifteenMin, 1), 30 * MIN);
  assert.equal(backoffDelayMs(fifteenMin, 2), 60 * MIN);
});

test("backoff: an hour is the ceiling, however long the run of failures", () => {
  assert.equal(backoffDelayMs(15 * 60, 3), BACKOFF_CAP_MS);
  assert.equal(backoffDelayMs(15 * 60, 40), BACKOFF_CAP_MS, "a huge exponent must not overflow past the cap");
  assert.equal(backoffDelayMs(6 * 3600, 0), BACKOFF_CAP_MS, "an interval longer than the cap is capped too");
});

// The floor is the part that actually stops the runaway: a widget with no
// interval of its own would compute a zero-length wait and go straight
// back to retrying on every sweep.
test("backoff: a widget with no interval still waits", () => {
  assert.equal(backoffDelayMs(0, 0), MIN);
  assert.equal(backoffDelayMs(0, 1), 2 * MIN);
  assert.equal(backoffDelayMs(-1, 0), MIN, "a nonsense interval cannot produce a negative wait");
});

// A 2-minute widget should not be punished with a 15-minute wait: the
// first wait is exactly what the widget asked for, whatever that is.
test("backoff: a fast widget retries fast", () => {
  for (const seconds of [120, 300, 900, 1800]) {
    assert.equal(backoffDelayMs(seconds, 0), seconds * 1000, `${seconds}s widget waits its own interval first`);
  }
});

// The gate is the whole point: without it the sweep re-claims a failing
// widget every two minutes regardless of its interval.
test("backoff: the claim gate refuses a widget that is still waiting", async () => {
  // the suite runs from the repo root (test/run.sh cds there)
  const src = (await import("node:fs")).readFileSync("src/refresh.ts", "utf8");
  assert.match(src, /AND \(next_attempt_at IS NULL OR next_attempt_at <= \?4\)/);
  assert.match(src, /RETURNING generation, source_rev, fail_count/);
  // success clears the run; failure extends it
  assert.match(src, /fail_count = 0, next_attempt_at = NULL/);
  assert.match(src, /fail_count = fail_count \+ 1, next_attempt_at = \?6/);
  // "Refresh now" must be able to break a wait, or a backed-off card
  // becomes unreachable for an hour
  assert.match(src, /SET fetched_at = NULL, next_attempt_at = NULL WHERE instance_id = \?1/);
});

test("backoff: the columns it depends on are actually migrated", () => {
  assert.match(backoff, /ALTER TABLE refresh_state ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(backoff, /ALTER TABLE refresh_state ADD COLUMN next_attempt_at INTEGER/);
  // A fresh install builds refresh_state from 0001 and must NOT already
  // carry these, or the ADD COLUMN pre-check would skip and the postcondition
  // would be the only thing standing between us and a broken claim query.
  assert.ok(!/next_attempt_at/.test(init), "0002 owns these columns");
});
