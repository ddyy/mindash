// Encrypted credential vault (D1 ciphertext, master key in KV or a Worker
// secret). Replaces code-level SECRET_POLICIES: the binding that used to
// live in source - which widget types may use a credential and the exact
// origin it may be sent to - is set once by the owner when the credential
// is saved, and sealed into the ciphertext as AES-GCM associated data.
// Tampering with the row's binding columns doesn't redirect the secret;
// it makes decryption fail.
//
// Master key resolution, in order:
//   1. env.MASTER_KEY (Worker secret, base64url of 32 bytes) - opt-in
//      hardening; write-only via the Cloudflare API, never readable back.
//   2. OAUTH_KV "vault:master-key" - auto-generated on first credential
//      save, so one-click deploys need no setup step. Lives in KV (not
//      D1) so the ciphertext store and the key never travel together.
// The key is only ever CREATED on the owner-authenticated save path;
// decrypt paths fail closed if no key exists.

const KV_KEY = "vault:master-key";
const KV_FINGERPRINT = "vault:key-fingerprint"; // sha256 of the raw key — NOT secret

export const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Widget types allowed to reference vault credentials at all.
export const CREDENTIAL_TYPES = ["json-api", "mcp", "crypto"] as const;

export interface CredentialMeta {
  name: string;
  widgetTypes: string[];
  origin: string;
  header: "authorization";
  createdAt: number;
}

interface Row {
  name: string;
  widget_types: string;
  origin: string;
  header: string;
  ciphertext: string;
  iv: string;
  created_at: number;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error("master key must be 32 bytes");
  return crypto.subtle.importKey("raw", raw as unknown as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function fingerprintOf(raw: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", raw as unknown as ArrayBuffer);
  return b64url(new Uint8Array(d));
}

// A stored fingerprint turns "wrong MASTER_KEY" into an explicit error
// instead of every ciphertext appearing corrupt.
const KV_VERIFIED = "vault:master-key-verified"; // promotion receipt for --finish
const KV_CHALLENGE = "vault:promotion-challenge"; // per-promotion nonce set by the script
let receiptForChallenge: string | undefined;

async function checkFingerprint(env: Env, raw: Uint8Array, source: string): Promise<void> {
  const expected = await env.OAUTH_KV.get(KV_FINGERPRINT);
  const actual = await fingerprintOf(raw);
  if (expected === null) {
    // Legacy vault (pre-fingerprint): NEVER bless a MASTER_KEY blindly —
    // if a KV key exists, it is the key that sealed existing data, and
    // the candidate must match it.
    if (source === "MASTER_KEY secret") {
      const kvKey = await env.OAUTH_KV.get(KV_KEY);
      if (kvKey !== null && (await fingerprintOf(unb64url(kvKey))) !== actual) {
        throw new Error(
          "vault master key mismatch: MASTER_KEY differs from the KV key that sealed existing data " +
            "(run scripts/promote-master-key.sh to migrate the exact key)",
        );
      }
    }
    await env.OAUTH_KV.put(KV_FINGERPRINT, actual);
    return;
  }
  if (expected !== actual) {
    throw new Error(
      `vault master key mismatch: the ${source} key is not the key that sealed existing data ` +
        `(run scripts/promote-master-key.sh to migrate the KV key into MASTER_KEY safely)`,
    );
  }
  // The deployed Worker proves the secret is active + matching by
  // writing a receipt BOUND TO THIS PROMOTION'S CHALLENGE NONCE — a
  // receipt from an earlier promotion can never authorize --finish for
  // a later (possibly wrong) secret. No challenge = no promotion in
  // progress = nothing to attest.
  if (source === "MASTER_KEY secret") {
    const challenge = await env.OAUTH_KV.get(KV_CHALLENGE);
    if (challenge && receiptForChallenge !== challenge) {
      await env.OAUTH_KV.put(KV_VERIFIED, `${actual}|${challenge}`);
      receiptForChallenge = challenge;
    }
  }
}

async function loadKey(env: Env, createIfMissing: boolean): Promise<CryptoKey> {
  const override = (env as unknown as Record<string, string | undefined>).MASTER_KEY;
  if (override) {
    const raw = unb64url(override);
    if (raw.byteLength !== 32) throw new Error("MASTER_KEY must be base64url of 32 bytes");
    await checkFingerprint(env, raw, "MASTER_KEY secret");
    return importKey(raw);
  }
  const stored = await env.OAUTH_KV.get(KV_KEY);
  if (stored) {
    const raw = unb64url(stored);
    await checkFingerprint(env, raw, "KV-held");
    return importKey(raw);
  }
  if (!createIfMissing) throw new Error("credential vault has no master key yet");
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  await env.OAUTH_KV.put(KV_KEY, b64url(fresh));
  // Read back through KV so concurrent first-saves converge on one key
  // (last write wins; the loser's single credential just needs re-saving).
  const settled = await env.OAUTH_KV.get(KV_KEY);
  const raw = unb64url(settled ?? b64url(fresh));
  await env.OAUTH_KV.put(KV_FINGERPRINT, await fingerprintOf(raw));
  return importKey(raw);
}

// Settings surface: is the vault key still on the KV fallback?
export async function vaultKeyStatus(env: Env): Promise<"secret" | "kv" | "none"> {
  if ((env as unknown as Record<string, string | undefined>).MASTER_KEY) return "secret";
  return (await env.OAUTH_KV.get(KV_KEY)) !== null ? "kv" : "none";
}

// The AEAD binding: every field that decides where a credential may go.
function aad(name: string, widgetTypes: string, origin: string, header: string): Uint8Array {
  return new TextEncoder().encode(`mindash-cred|${name}|${widgetTypes}|${origin}|${header}`);
}

// Generic seal/open under the master key for other secret stores (e.g.
// MCP OAuth token sets). The caller supplies the full AAD binding string.
export async function sealSecret(
  env: Env,
  binding: string,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await loadKey(env, true);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as ArrayBuffer, additionalData: new TextEncoder().encode(binding) as unknown as ArrayBuffer },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: b64url(new Uint8Array(ct)), iv: b64url(iv) };
}

export async function openSecret(env: Env, binding: string, ciphertext: string, iv: string): Promise<string> {
  const key = await loadKey(env, false);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unb64url(iv) as unknown as ArrayBuffer,
      additionalData: new TextEncoder().encode(binding) as unknown as ArrayBuffer,
    },
    key,
    unb64url(ciphertext) as unknown as ArrayBuffer,
  );
  return new TextDecoder().decode(plain);
}

// A credential is pinned to an ORIGIN, so anything past the host is
// dropped. Exported so the UI can show what it actually stored rather
// than truncating the owner's input in silence.
export function normalizeOrigin(raw: string): string | null {
  let origin: string;
  try {
    origin = new URL(raw.trim()).origin;
  } catch {
    return null;
  }
  return origin.startsWith("https://") ? origin : null;
}

export interface PutCredentialInput {
  name: string;
  value: string;
  origin: string; // exact https origin the credential may be sent to
  widgetTypes: string[];
}

export async function putCredential(env: Env, input: PutCredentialInput): Promise<string | null> {
  const name = input.name.trim();
  if (!CREDENTIAL_NAME.test(name)) return "name must be kebab-case (a-z, 0-9, dashes, max 32)";
  const value = input.value;
  if (!value || value.length > 4096) return "value is required (max 4096 chars)";
  const origin = normalizeOrigin(input.origin);
  if (!origin) return "origin must be a valid https URL";
  const types = input.widgetTypes.filter((t) => (CREDENTIAL_TYPES as readonly string[]).includes(t));
  if (types.length === 0) return "select at least one widget type";
  const typesCsv = types.join(",");
  const key = await loadKey(env, true);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as ArrayBuffer, additionalData: aad(name, typesCsv, origin, "authorization") as unknown as ArrayBuffer },
    key,
    new TextEncoder().encode(value),
  );
  await env.DB
    .prepare(
      `INSERT INTO api_credentials (name, widget_types, origin, header, ciphertext, iv, created_at)
       VALUES (?1, ?2, ?3, 'authorization', ?4, ?5, ?6)
       ON CONFLICT (name) DO UPDATE SET widget_types = excluded.widget_types,
         origin = excluded.origin, ciphertext = excluded.ciphertext,
         iv = excluded.iv`,
    )
    .bind(name, typesCsv, origin, b64url(new Uint8Array(ct)), b64url(iv), Date.now())
    .run();
  return null;
}

export async function deleteCredential(env: Env, name: string): Promise<void> {
  await env.DB.prepare("DELETE FROM api_credentials WHERE name = ?1").bind(name).run();
}

export async function listCredentials(env: Env): Promise<CredentialMeta[]> {
  const { results } = await env.DB
    .prepare("SELECT name, widget_types, origin, header, created_at FROM api_credentials ORDER BY name")
    .all<Omit<Row, "ciphertext" | "iv">>();
  return results.map((r) => ({
    name: r.name,
    widgetTypes: r.widget_types.split(","),
    origin: r.origin,
    header: "authorization",
    createdAt: r.created_at,
  }));
}

// Fetch-time resolution: the enforcement point. Explicit type/origin
// checks give readable errors; the AEAD binding backstops them against
// any tampering the checks didn't cover.
export async function credentialHeader(
  env: Env,
  name: string,
  widgetType: string,
  url: string,
): Promise<Record<string, string>> {
  const row = await env.DB
    .prepare("SELECT * FROM api_credentials WHERE name = ?1")
    .bind(name)
    .first<Row>();
  if (!row) throw new Error(`credential "${name}" not found - add it in Settings`);
  if (!row.widget_types.split(",").includes(widgetType)) {
    throw new Error(`credential "${name}" is not allowed on widget type "${widgetType}"`);
  }
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error("invalid url for credential check");
  }
  if (origin !== row.origin) {
    throw new Error(`credential "${name}" may not be sent to ${origin}`);
  }
  const key = await loadKey(env, false);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64url(row.iv) as unknown as ArrayBuffer,
        additionalData: aad(row.name, row.widget_types, row.origin, row.header) as unknown as ArrayBuffer,
      },
      key,
      unb64url(row.ciphertext) as unknown as ArrayBuffer,
    );
  } catch {
    throw new Error(`credential "${name}" failed to decrypt (binding or key mismatch) - re-save it in Settings`);
  }
  const secret = new TextDecoder().decode(plain);
  // The wire header is a function of the WIDGET TYPE, not of the stored
  // row: the row's header column is AAD material (it keeps old rows
  // decrypting), while the send format follows the API being called.
  // CoinGecko demo keys travel as a bare x-cg-demo-api-key header - a
  // Bearer Authorization is silently ignored there, which reads as
  // "keyless" and keeps the shared-egress-IP 429s coming.
  if (widgetType === "crypto") return { "x-cg-demo-api-key": secret };
  return { [row.header]: `Bearer ${secret}` };
}

// Pure crypto core exported for tests.
export const _internal = { importKey, aad, b64url, unb64url };
