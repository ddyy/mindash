import { test } from "node:test";
import assert from "node:assert/strict";
import { loginPage } from "../src/auth/loginpage";

const body = async (res: Response): Promise<string> => await res.text();

test("claim notice: workers.dev hosts are told to attach the domain first", async () => {
  for (const host of ["mindash.someone.workers.dev", "workers.dev"]) {
    const out = await body(loginPage(false, true, host));
    assert.match(out, /class="claim-note"/);
    assert.match(out, /attach it to this\s+Worker and\s+claim there instead/);
    assert.match(out, /one-time token/);
  }
});

test("claim notice: a real domain just states the binding", async () => {
  const out = await body(loginPage(false, true, "dash.example.com"));
  assert.match(out, /binds to <strong>dash\.example\.com<\/strong>/);
  assert.ok(!out.includes("attach it to this"), "no domain advice once they are on one");
  // a host that merely CONTAINS the string is not a workers.dev host
  const lookalike = await body(loginPage(false, true, "workers.dev.example.com"));
  assert.ok(!lookalike.includes("attach it to this"));
});

test("claim notice: only on the first-passkey claim, never on normal sign-in", async () => {
  assert.ok(!(await body(loginPage(false, false, "mindash.someone.workers.dev"))).includes("claim-note"));
  assert.ok(!(await body(loginPage(true, false, "mindash.someone.workers.dev"))).includes("claim-note"));
  // no hostname (nothing truthful to say) omits it too
  assert.ok(!(await body(loginPage(false, true, ""))).includes("claim-note"));
});

test("claim notice: the hostname is escaped, not injected", async () => {
  const out = await body(loginPage(false, true, 'evil.com"><script>alert(1)</script>'));
  assert.ok(!out.includes("<script>alert(1)"));
  assert.match(out, /&lt;script&gt;/);
});
