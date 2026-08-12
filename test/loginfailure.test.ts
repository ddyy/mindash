import { test } from "node:test";
import assert from "node:assert/strict";
import authClient from "../src/auth/auth.client.js";

interface Failure {
  text: string;
  steps?: string;
  raw?: string;
}

// The shipped client is a classic script, not a module. Its load-time
// wiring only looks elements up, so a stub document is enough to evaluate
// the real source and pull the mapper out - this tests what ships, not a
// copy of it.
function loginFailure(e: unknown): Failure {
  const doc = { getElementById: () => null, querySelector: () => null };
  const load = new Function("document", `${authClient}\nreturn loginFailure;`) as (
    d: unknown,
  ) => (e: unknown) => Failure;
  return load(doc)(e);
}

const notAllowed = () => Object.assign(new Error("The operation either timed out or was not allowed."), {
  name: "NotAllowedError",
});

test("login failure: a wrong-domain passkey reads as a domain move, not an accusation", () => {
  const f = loginFailure(notAllowed());
  assert.match(f.text, /moved to a new domain/);
  assert.match(f.text, /cancelled or the prompt timed out/); // cancel is the innocent case
  assert.match(f.steps!, /seed-token\.sh enroll/);
});

test("login failure: a passkey unknown to this instance names why and how to recover", () => {
  const f = loginFailure(new Error("unknown credential"));
  assert.match(f.text, /not enrolled on this dashboard/);
  assert.match(f.text, /another instance|removed in Settings|account recovery/);
  assert.match(f.steps!, /seed-token\.sh enroll/);
});

test("login failure: an instance with no passkeys points at the recovery ceremony", () => {
  const f = loginFailure(new Error("no credentials enrolled"));
  assert.match(f.text, /no passkeys left/);
  assert.match(f.steps!, /seed-token\.sh recover/);
});

test("login failure: unrecognized errors pass through unchanged", () => {
  const f = loginFailure(new Error("HTTP 503"));
  assert.equal(f.text, "HTTP 503");
  assert.equal(f.steps, undefined);
});

test("login failure: the raw error is preserved for debugging", () => {
  const raw = "The operation either timed out or was not allowed.";
  assert.equal(loginFailure(notAllowed()).raw, raw);
  assert.equal(loginFailure(new Error("unknown credential")).raw, "unknown credential");
});
