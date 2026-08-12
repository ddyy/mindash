// WebAuthn ceremony integration: a deterministic emulated authenticator
// (real P-256 keys, hand-built CBOR attestation and DER-signed assertions)
// drives the ACTUAL HTTP endpoints on a fresh wrangler dev instance:
// first-owner claim, login, challenge replay, wrong origin, wrong RP ID,
// counter regression, post-claim token gating, config:sources step-up,
// and token-based recovery (revoke-all + epoch bump).
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { startWorker } from "./harness.mjs";

const { base: BASE, sql } = await startWorker("mindash-webauthn-");
const RP_ID = "localhost";

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log(`ok: ${label}`);
  else {
    failures++;
    console.log(`FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
};
const sha256 = (b) => createHash("sha256").update(b).digest();
const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---- minimal CBOR encoder (ints, byte/text strings, arrays, maps) ----
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    throw new Error("cbor: too large");
  };
  if (typeof v === "number" && Number.isInteger(v)) {
    return v >= 0 ? head(0, v) : head(1, -v - 1);
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v);
    return Buffer.concat([head(2, b.length), b]);
  }
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) {
    return Buffer.concat([head(5, v.size), ...[...v.entries()].flatMap(([k, val]) => [cbor(k), cbor(val)])]);
  }
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v);
    return Buffer.concat([head(5, keys.length), ...keys.flatMap((k) => [cbor(k), cbor(v[k])])]);
  }
  throw new Error(`cbor: unsupported ${typeof v}`);
}

// ---- the emulated authenticator ----
class Authenticator {
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x, "base64url");
    this.y = Buffer.from(jwk.y, "base64url");
    this.credId = randomBytes(16);
    this.counter = 0;
  }
  register(challenge, { origin = BASE, rpId = RP_ID } = {}) {
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]));
    const authData = Buffer.concat([
      sha256(Buffer.from(rpId, "utf8")),
      Buffer.from([0x45]), // UP | UV | AT
      Buffer.from([0, 0, 0, 0]), // counter
      Buffer.alloc(16), // AAGUID
      Buffer.from([this.credId.length >> 8, this.credId.length & 0xff]),
      this.credId,
      cose,
    ]);
    const attObj = cbor({ fmt: "none", attStmt: {}, authData });
    const cdj = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(cdj), attestationObject: b64u(attObj) },
    };
  }
  assert(challenge, { origin = BASE, rpId = RP_ID, counter } = {}) {
    const useCounter = counter ?? ++this.counter;
    const authData = Buffer.concat([
      sha256(Buffer.from(rpId, "utf8")),
      Buffer.from([0x05]), // UP | UV
      Buffer.from([(useCounter >> 24) & 0xff, (useCounter >> 16) & 0xff, (useCounter >> 8) & 0xff, useCounter & 0xff]),
    ]);
    const cdj = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const signature = createSign("SHA256")
      .update(Buffer.concat([authData, sha256(cdj)]))
      .sign(this.privateKey);
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: "public-key",
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: null },
    };
  }
}

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });

// ---- first-owner claim (tokenless setup window) ----
const owner = new Authenticator();
const regOpts = await (await post("/auth/register/options", {})).json();
ok(!!regOpts.options?.challenge, "fresh instance offers tokenless registration options");
const regRes = await post("/auth/register/verify", {
  challengeId: regOpts.challengeId,
  credential: owner.register(regOpts.options.challenge),
});
ok(regRes.status === 200, "first-owner claim verifies", await regRes.clone().text());

// post-claim: options without a token are refused
const gated = await post("/auth/register/options", {});
ok(gated.status === 400, "second enrollment requires a token after the claim");

// ---- login ceremony ----
async function login(auth, opts = {}) {
  const lo = await (await post("/auth/login/options", {})).json();
  const res = await post("/auth/login/verify", {
    challengeId: lo.challengeId,
    credential: auth.assert(lo.options.challenge, opts),
  });
  return { res, challengeId: lo.challengeId, challenge: lo.options.challenge };
}
const l1 = await login(owner);
const setCookie = l1.res.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0];
ok(l1.res.status === 200 && cookie.startsWith("session="), "login issues a session cookie");
const dash = await fetch(`${BASE}/`, { headers: { cookie }, redirect: "manual" });
ok(dash.status === 200, "session cookie reaches the dashboard");

// ---- challenge replay is refused ----
const replay = await post("/auth/login/verify", {
  challengeId: l1.challengeId,
  credential: owner.assert(l1.challenge),
});
ok(replay.status === 401, "consumed login challenge cannot be replayed", `status ${replay.status}`);

// ---- wrong origin / wrong RP ID are refused ----
{
  const lo = await (await post("/auth/login/options", {})).json();
  const bad = await post("/auth/login/verify", {
    challengeId: lo.challengeId,
    credential: owner.assert(lo.options.challenge, { origin: "https://evil.example" }),
  });
  ok(bad.status >= 400, "assertion from the wrong origin is refused");
}
{
  const lo = await (await post("/auth/login/options", {})).json();
  const bad = await post("/auth/login/verify", {
    challengeId: lo.challengeId,
    credential: owner.assert(lo.options.challenge, { rpId: "evil.example" }),
  });
  ok(bad.status >= 400, "assertion for the wrong RP ID is refused");
}

// ---- counter regression is refused ----
owner.counter = 10;
const l2 = await login(owner); // counter 11
ok(l2.res.status === 200, "login with advanced counter succeeds");
const l3 = await login(owner, { counter: 3 }); // regression
ok(l3.res.status >= 400, "counter regression is refused", `status ${l3.res.status}`);

// ---- config:sources consent requires passkey step-up ----
const reg = await post("/register", {
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none",
  client_name: "stepup-test",
});
const client = await reg.json();
const verifier = b64u(randomBytes(32));
const challenge = b64u(sha256(Buffer.from(verifier)));
const authUrl =
  `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
  `&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}` +
  `&scope=${encodeURIComponent("config:layout config:sources")}&state=st1` +
  `&code_challenge=${challenge}&code_challenge_method=S256`;
const freshCookie = (await login(owner)).res.headers.get("set-cookie").split(";")[0];
const consentHtml = await (await fetch(authUrl, { headers: { cookie: freshCookie } })).text();
const pendingId = /name="pending_id" value="([^"]+)"/.exec(consentHtml)?.[1];
const csrf = /name="csrf" value="([^"]+)"/.exec(consentHtml)?.[1];
const form = (body) =>
  fetch(`${BASE}/authorize/approve`, {
    method: "POST",
    headers: { cookie: freshCookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
const early = await form({ pending_id: pendingId, csrf });
ok(early.status === 403, "sources approval without step-up is refused");
const so = await (await post("/auth/stepup/options", { pending_id: pendingId }, { cookie: freshCookie })).json();
ok(!!so.options?.challenge, "step-up options issued");
const sv = await post(
  "/auth/stepup/verify",
  { pending_id: pendingId, credential: owner.assert(so.options.challenge) },
  { cookie: freshCookie },
);
ok(sv.status === 200, "step-up assertion verifies", await sv.clone().text());
const approved = await form({ pending_id: pendingId, csrf });
const code = /[?&]code=([^&]+)/.exec(approved.headers.get("location") ?? "")?.[1];
ok(!!code, "sources grant approved after step-up");

// ---- recovery: revoke-all + epoch bump ----
const recoverToken = randomBytes(24).toString("hex");
const tokenHash = createHash("sha256").update(recoverToken).digest("hex");
sql(`INSERT INTO auth_tokens (token_hash, purpose, created_at) VALUES ('${tokenHash}','recover',${Date.now()})`);
const newKey = new Authenticator();
const ro = await (await post("/auth/register/options", { token: recoverToken })).json();
ok(!!ro.options?.challenge, "recovery options issued for the token");
const rv = await post("/auth/register/verify", {
  challengeId: ro.challengeId,
  credential: newKey.register(ro.options.challenge),
  token: recoverToken,
});
ok(rv.status === 200, "recovery ceremony completes", await rv.clone().text());
const oldSession = await fetch(`${BASE}/`, { headers: { cookie: freshCookie }, redirect: "manual" });
ok(oldSession.status !== 200, "pre-recovery session is dead (epoch bump)");
const oldLogin = await login(owner);
ok(oldLogin.res.status >= 400, "pre-recovery passkey can no longer log in");
const newLogin = await login(newKey);
ok(newLogin.res.status === 200, "replacement passkey logs in");

console.log(failures === 0 ? "WEBAUTHN integration: all assertions passed" : `WEBAUTHN integration: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
