import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal, CREDENTIAL_NAME, normalizeOrigin } from "../src/vault";

// The vault's load-bearing property: the credential's binding (name,
// widget types, origin, header) is AES-GCM associated data, so editing
// any binding column of a stored row makes the ciphertext undecryptable
// instead of redirecting the secret.

const { importKey, aad, b64url, unb64url } = _internal;

async function seal(key: CryptoKey, value: string, binding: Parameters<typeof aad>): Promise<{ ct: Uint8Array; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(...binding) },
    key,
    new TextEncoder().encode(value),
  );
  return { ct: new Uint8Array(ct), iv };
}

async function open(key: CryptoKey, sealed: { ct: Uint8Array; iv: Uint8Array }, binding: Parameters<typeof aad>): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.iv, additionalData: aad(...binding) },
    key,
    sealed.ct,
  );
  return new TextDecoder().decode(plain);
}

test("vault crypto: roundtrip under the same binding", async () => {
  const key = await importKey(crypto.getRandomValues(new Uint8Array(32)));
  const binding: Parameters<typeof aad> = ["gh", "json-api", "https://api.github.com", "authorization"];
  const sealed = await seal(key, "tok_abc123", binding);
  assert.equal(await open(key, sealed, binding), "tok_abc123");
});

test("vault crypto: retargeted origin fails decryption", async () => {
  const key = await importKey(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = await seal(key, "tok_abc123", ["gh", "json-api", "https://api.github.com", "authorization"]);
  await assert.rejects(open(key, sealed, ["gh", "json-api", "https://evil.example", "authorization"]));
  await assert.rejects(open(key, sealed, ["gh", "mcp", "https://api.github.com", "authorization"]));
});

test("vault crypto: b64url roundtrip and key size guard", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  assert.deepEqual(unb64url(b64url(bytes)), bytes);
  await assert.rejects(importKey(new Uint8Array(16)), /32 bytes/);
});

test("credential name pattern", () => {
  assert.ok(CREDENTIAL_NAME.test("github-token"));
  assert.ok(!CREDENTIAL_NAME.test("GitHub"));
  assert.ok(!CREDENTIAL_NAME.test("-bad"));
  assert.ok(!CREDENTIAL_NAME.test("a".repeat(40)));
});

test("normalizeOrigin: keeps scheme+host, drops the rest, https only", () => {
  assert.equal(normalizeOrigin("https://api.github.com"), "https://api.github.com");
  // a pasted full URL narrows to its origin - the UI reports this rather
  // than truncating in silence
  assert.equal(normalizeOrigin("https://api.github.com/repos/cloudflare?x=1#f"), "https://api.github.com");
  assert.equal(normalizeOrigin("  https://api.github.com:8443/x  "), "https://api.github.com:8443");
  assert.equal(normalizeOrigin("http://api.github.com"), null);
  assert.equal(normalizeOrigin("not a url"), null);
});


// The wire-format rule credentialHeader lives by: a crypto-typed send
// uses CoinGecko's bare x-cg-demo-api-key header, everything else the
// Bearer Authorization the vault has always emitted. A regression here
// is silent - CoinGecko ignores an Authorization header and the widget
// just looks keyless (429s) again.
test("credentialHeader: crypto sends the bare CoinGecko header, others Bearer", async () => {
  const { credentialHeader } = await import("../src/vault");
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await importKey(rawKey);
  const mk = b64url(rawKey);
  const mkFp = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", rawKey)));
  const rowFor = async (name: string, types: string, origin: string) => {
    const sealed = await seal(key, "sekrit-123", [name, types, origin, "authorization"]);
    return {
      name, widget_types: types, origin, header: "authorization",
      ciphertext: b64url(sealed.ct), iv: b64url(sealed.iv), created_at: 1,
    };
  };
  const rows: Record<string, unknown> = {
    gecko: await rowFor("gecko", "crypto", "https://api.coingecko.com"),
    plain: await rowFor("plain", "json-api", "https://api.example.com"),
  };
  const env = {
    MASTER_KEY: mk,
    OAUTH_KV: { get: async (k: string) => (k.includes("fingerprint") ? mkFp : null), put: async () => {} },
    DB: { prepare: () => ({ bind: (name: string) => ({ first: async () => rows[name] ?? null }) }) },
  } as never;

  const geckoHeaders = await credentialHeader(env, "gecko", "crypto", "https://api.coingecko.com/api/v3/simple/price");
  assert.deepEqual(geckoHeaders, { "x-cg-demo-api-key": "sekrit-123" });
  const plainHeaders = await credentialHeader(env, "plain", "json-api", "https://api.example.com/v1");
  assert.deepEqual(plainHeaders, { authorization: "Bearer sekrit-123" });
  // the widget-type allowlist still holds: a json-api credential cannot
  // be wielded by a crypto widget
  await assert.rejects(
    () => credentialHeader(env, "plain", "crypto", "https://api.example.com/v1"),
    /not allowed on widget type/,
  );
});

// ---------- eligibility is derived, not declared ----------
//
// The list of types that may hold a credential used to be a literal in
// vault.ts. It was the same information the defs already carried, so it
// could drift - and did: crypto grew a secret field while the list still
// said json-api and mcp. This asserts the two can never disagree again,
// which is the whole point of deriving it.
test("credential eligibility matches exactly the defs that ask for a secret", async () => {
  const { CREDENTIAL_WIDGET_TYPES } = await import("../src/widgets");
  const { WIDGETS } = await import("../src/widgets");

  const asksForSecret = Object.entries(WIDGETS)
    .filter(([, def]) => def.form.some((f) => f.kind === "secret"))
    .map(([type]) => type)
    .sort();

  assert.deepEqual(CREDENTIAL_WIDGET_TYPES, asksForSecret);
  assert.ok(CREDENTIAL_WIDGET_TYPES.length > 0, "a vault nothing can use is a broken vault");
});

test("a type with no secret field cannot hold a credential", async () => {
  const { CREDENTIAL_WIDGET_TYPES } = await import("../src/widgets");
  // A clock has nothing to authenticate and a bookmarks card never
  // fetches; offering them a credential would be offering a footgun.
  for (const t of ["clock", "countdown", "note", "bookmarks", "search"]) {
    assert.equal(CREDENTIAL_WIDGET_TYPES.includes(t), false, `${t} must not be credential-eligible`);
  }
});

// A custom widget is the reason this changed: dropping a file into
// src/widgets/ that asks for a secret must make it eligible, with no
// core file edited. Simulated here by asserting the rule is a pure
// function of the def, not of any list.
test("eligibility follows the def, so a new widget needs no core edit", async () => {
  const { CREDENTIAL_WIDGET_TYPES, WIDGETS } = await import("../src/widgets");
  for (const type of CREDENTIAL_WIDGET_TYPES) {
    assert.ok(
      WIDGETS[type]?.form.some((f) => f.kind === "secret"),
      `${type} is eligible but its def never asks for a secret`,
    );
  }
});
