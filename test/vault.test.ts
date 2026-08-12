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
