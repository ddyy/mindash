// Protocol-level integration test for the primary connector flow, against
// a real wrangler dev (workerd + D1 + KV) instance with isolated state:
//   DCR client -> /authorize (PKCE S256) -> consent approve -> code
//   exchange -> authenticated /mcp -> scope enforcement -> refresh
//   rotation -> grant revocation kills in-flight tokens.
// The test owner is seeded by DIRECT database access (credential + session
// rows) — a mechanism that requires the operator's own wrangler binding
// and does not exist as any production surface. WebAuthn ceremonies are
// covered end-to-end by test/integration/webauthn.mjs (emulated
// authenticator against the real endpoints); this suite exercises
// everything after a session exists.
import { createHash, randomBytes } from "node:crypto";
import { startWorker } from "./harness.mjs";

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log(`ok: ${label}`);
  else {
    failures++;
    console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const { base: BASE, sql } = await startWorker("mindash-auth-");

// ---- seed the test owner: credential + live session ----
const sessionToken = randomBytes(24).toString("hex");
const sessionHash = sha256hex(sessionToken);
const now = Date.now();
sql(
  `INSERT INTO credentials (credential_id, public_key, counter, created_at) VALUES ('test-cred','dGVzdA',0,${now});` +
    `INSERT INTO sessions (session_hash, credential_id, epoch, created_at, expires_at) VALUES ('${sessionHash}','test-cred',1,${now},${now + 3600_000});`,
);
const cookie = `session=${sessionToken}`;
const me = await fetch(`${BASE}/`, { headers: { cookie }, redirect: "manual" });
ok(me.status === 200, "seeded session authenticates the dashboard");

// ---- DCR ----
const reg = await fetch(`${BASE}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "none",
    client_name: "integration-test",
  }),
});
ok(reg.status === 201, "DCR registration");
const client = await reg.json();

// ---- authorize with PKCE ----
const verifier = b64u(randomBytes(32));
const challenge = b64u(createHash("sha256").update(verifier).digest());
const authUrl =
  `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
  `&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}` +
  `&scope=${encodeURIComponent("config:layout")}&state=st123` +
  `&code_challenge=${challenge}&code_challenge_method=S256`;
const consent = await fetch(authUrl, { headers: { cookie } });
const consentHtml = await consent.text();
ok(consent.status === 200 && consentHtml.includes("Authorization request"), "consent page renders for authed owner");
const pendingId = /name="pending_id" value="([^"]+)"/.exec(consentHtml)?.[1];
const csrf = /name="csrf" value="([^"]+)"/.exec(consentHtml)?.[1];
ok(!!pendingId && !!csrf, "consent page carries pending id + csrf");

const approve = await fetch(`${BASE}/authorize/approve`, {
  method: "POST",
  headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ pending_id: pendingId, csrf }),
  redirect: "manual",
});
const loc = approve.headers.get("location") ?? "";
const code = /[?&]code=([^&]+)/.exec(loc)?.[1];
ok(approve.status >= 300 && approve.status < 400 && !!code && loc.includes("state=st123"), "approve redirects with code + state", `status ${approve.status} loc ${loc.slice(0, 80)}`);

// ---- code exchange (PKCE) ----
const tok = await fetch(`${BASE}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: decodeURIComponent(code),
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    client_id: client.client_id,
    code_verifier: verifier,
  }),
});
const tokens = await tok.json();
ok(tok.status === 200 && !!tokens.access_token && !!tokens.refresh_token, "PKCE code exchange issues tokens");
console.log("  token shape:", JSON.stringify({ ...tokens, access_token: String(tokens.access_token).slice(0, 12) + "...", refresh_token: String(tokens.refresh_token ?? "").slice(0, 12) + "..." }));

// ---- authenticated MCP + scope enforcement ----
const mcp = (token, method, params) =>
  fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
const listRes = await mcp(tokens.access_token, "tools/call", { name: "list_config", arguments: {} });
const listBody = await listRes.text();
ok(listRes.status === 200 && listBody.includes("redacted"), "layout token reads config (redacted)", listBody.slice(0, 120));

const addRes = await mcp(tokens.access_token, "tools/call", {
  name: "add_widget",
  arguments: { base_version: 1, page: "Home", column: 0, widget: { type: "hackernews", refresh_interval: "15m" } },
});
const addBody = await addRes.text();
ok(addBody.includes("config:sources"), "layout token cannot create widgets (scope enforced)", addBody.slice(0, 160));

// unauthenticated /mcp rejected
const anon = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
ok(anon.status === 401, "unauthenticated /mcp rejected");

// ---- refresh rotation ----
const ref = await fetch(`${BASE}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }),
});
const refreshed = await ref.json();
ok(ref.status === 200 && !!refreshed.access_token, "refresh token issues a new access token", `status ${ref.status} body ${JSON.stringify(refreshed).slice(0, 160)}`);
const fresh = await mcp(refreshed.access_token, "tools/call", { name: "list_config", arguments: {} });
ok(fresh.status === 200, "refreshed access token works on /mcp");

// wrong-verifier exchange must fail — against a SEPARATE client, so the
// main client's grant (tested below) is never superseded. (A repeat
// authorization for the SAME client supersedes its prior grant; a
// re-authorizing connector always uses the fresh pair.)
{
  const reg2 = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
      client_name: "verifier-test",
    }),
  });
  const client2 = await reg2.json();
  const authUrl2 = authUrl.replace(encodeURIComponent(client.client_id), encodeURIComponent(client2.client_id));
  const c2 = await fetch(authUrl2, { headers: { cookie } });
  const h2 = await c2.text();
  const p2 = /name="pending_id" value="([^"]+)"/.exec(h2)?.[1];
  const cs2 = /name="csrf" value="([^"]+)"/.exec(h2)?.[1];
  const a2 = await fetch(`${BASE}/authorize/approve`, {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ pending_id: p2, csrf: cs2 }),
    redirect: "manual",
  });
  const code2 = /[?&]code=([^&]+)/.exec(a2.headers.get("location") ?? "")?.[1];
  const bad = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: decodeURIComponent(code2 ?? ""),
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      client_id: client2.client_id,
      code_verifier: b64u(randomBytes(32)),
    }),
  });
  ok(bad.status >= 400, "wrong PKCE verifier is rejected");
}

// ---- revocation kills in-flight authority (commit-time grant check) ----
// the token must demonstrably work immediately before revocation, and
// revocation goes through the REAL settings action (CSRF + grant id)
const pre = await mcp(refreshed.access_token, "tools/call", { name: "list_config", arguments: {} });
ok(pre.status === 200, "token works immediately before revocation");
const settingsHtml = await (await fetch(`${BASE}/settings`, { headers: { cookie } })).text();
// two grants exist by now (main client + the wrong-verifier client) —
// revoke specifically the MAIN client's grant, matched by client name
const grantId = /<strong>integration-test<\/strong>[\s\S]*?name="grant_db_id" value="([^"]+)"/.exec(settingsHtml)?.[1];
const settingsCsrf = /name="csrf" value="([^"]+)"/.exec(settingsHtml)?.[1];
ok(!!grantId && !!settingsCsrf, "settings page lists the grant with a revoke form");
const revokeRes = await fetch(`${BASE}/settings/grants/revoke`, {
  method: "POST",
  headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_db_id: grantId, csrf: settingsCsrf }),
  redirect: "manual",
});
ok(revokeRes.status < 400, "settings revoke action accepted", `status ${revokeRes.status}`);
const revoked = await mcp(refreshed.access_token, "tools/call", { name: "list_config", arguments: {} });
ok(revoked.status === 401 || revoked.status === 403, "revoked grant rejects a still-valid token", `status ${revoked.status}`);

console.log(failures === 0 ? "AUTH integration: all assertions passed" : `AUTH integration: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
