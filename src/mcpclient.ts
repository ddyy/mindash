import { safeFetchRaw } from "./safefetch";
import { sealSecret, openSecret, CREDENTIAL_NAME } from "./vault";

// OAuth 2.1 CLIENT for upstream MCP servers (the mirror image of the
// OAuth server this Worker already runs for its own /mcp). Lets MCP
// widgets talk to OAuth-only servers, not just bearer/unauthenticated
// ones. The full flow is owner-driven from Settings:
//
//   connect -> RFC 9728 protected-resource discovery -> AS metadata ->
//   dynamic client registration (public client, PKCE S256) -> browser
//   redirect to the AS -> /oauth/callback code exchange -> token set
//   sealed into D1 under the vault master key, bound to the connection
//   name + server origin as AEAD associated data.
//
// Widgets reference a connection by name; the fetch path decrypts,
// refreshes when near expiry (rotating refresh tokens persisted), and
// attaches the Bearer header. All outbound calls ride safeFetchRaw
// (https/public-only, bounded, no redirect following on credentialed
// requests).

const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 120_000;

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // ms epoch; absent = non-expiring
}

interface ConnectionRow {
  name: string;
  server_url: string;
  origin: string;
  token_endpoint: string;
  client_id: string;
  scopes: string | null;
  ciphertext: string;
  iv: string;
  created_at: number;
  token_version: number;
  refresh_lease_until: number | null;
  binding_version: number; // 1 = legacy name|origin AAD; 2 = complete binding
}

// The AEAD binding covers EVERY field that governs credential use: a
// tampered row (retargeted server path, swapped token endpoint or client
// id) fails decryption instead of redirecting tokens.
function binding(name: string, serverUrl: string, tokenEndpoint: string, clientId: string): string {
  return `mindash-conn2|${name}|${serverUrl}|${tokenEndpoint}|${clientId}`;
}

// Pre-upgrade rows were sealed under name|origin only.
function legacyBinding(name: string, origin: string): string {
  return `mindash-conn|${name}|${origin}`;
}

// The canonical MCP resource: full URL minus fragment (which never
// reaches the server). Tokens are bound to THIS, not the origin — on a
// multi-tenant host, /tenant-a/mcp and /tenant-b/mcp are different
// resources and must never share a token.
export function canonicalResource(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("MCP server URL must be https");
  u.hash = "";
  return u.href;
}

async function fetchJson(url: string, init?: { method?: "GET" | "POST"; body?: string; form?: boolean }): Promise<Record<string, unknown> | null> {
  const res = await safeFetchRaw(url, {
    method: init?.method ?? "GET",
    body: init?.body,
    timeoutMs: 10_000,
    headers: {
      accept: "application/json",
      ...(init?.form ? { "content-type": "application/x-www-form-urlencoded" } : init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// RFC 9728 protected-resource discovery + RFC 8414/OIDC AS metadata,
// with the MCP-required WWW-Authenticate challenge path: an initial
// unauthenticated MCP request may carry resource_metadata= and scope=
// in its Bearer challenge, which take precedence over constructed
// well-known candidates. Both metadata documents are identity-checked
// (PRM.resource against the exact MCP resource; AS metadata issuer
// against the issuer it was fetched for), and all endpoints must be
// https.
export interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string;
}

export function parseBearerChallenge(header: string | null): { resourceMetadata?: string; scope?: string } {
  if (!header || !/^bearer\b/i.test(header.trim())) return {};
  const out: { resourceMetadata?: string; scope?: string } = {};
  const rm = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  if (rm?.[1]) out.resourceMetadata = rm[1];
  const sc = /scope\s*=\s*"([^"]+)"/i.exec(header);
  if (sc?.[1]) out.scope = sc[1];
  return out;
}

// RFC 8414 / RFC 9728 identity comparison is EXACT string equality —
// "https://as.example/t" and "https://as.example/t/" may be different
// security principals on the same host.
function sameUrlId(a: string, b: string): boolean {
  return a === b;
}

const httpsUrl = (v: unknown): v is string => typeof v === "string" && v.startsWith("https://");

export async function discover(serverUrl: string): Promise<Discovery> {
  const resource = canonicalResource(serverUrl);
  const u = new URL(resource);

  // 1. Initial unauthenticated MCP request: a conforming protected server
  // 401s with a Bearer challenge naming its resource metadata.
  let challenge: { resourceMetadata?: string; scope?: string } = {};
  try {
    const probe = await safeFetchRaw(resource, {
      method: "POST",
      timeoutMs: 10_000,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mindash", version: "1.0" } },
      }),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    });
    challenge = parseBearerChallenge(probe.headers.get("www-authenticate"));
  } catch {
    // unreachable probe: constructed well-known candidates still apply
  }

  const prmCandidates = [
    ...(challenge.resourceMetadata && httpsUrl(challenge.resourceMetadata) ? [challenge.resourceMetadata] : []),
    `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`,
    `${u.origin}/.well-known/oauth-protected-resource`,
  ];
  let asIssuer: string | undefined;
  let scopes: string | undefined = challenge.scope;
  for (const cand of prmCandidates) {
    const prm = await fetchJson(cand);
    if (!prm) continue;
    // RFC 9728: the metadata's resource MUST identify the resource we
    // asked about — mismatched documents are attacker-controllable noise.
    if (typeof prm.resource !== "string" || !sameUrlId(prm.resource, resource)) continue;
    const servers = prm.authorization_servers;
    if (Array.isArray(servers) && httpsUrl(servers[0])) {
      asIssuer = servers[0];
      if (!scopes && Array.isArray(prm.scopes_supported)) {
        scopes = (prm.scopes_supported as unknown[]).filter((x) => typeof x === "string").join(" ");
      }
      break;
    }
  }
  // Servers that are their own AS often skip PRM; fall back to the origin.
  asIssuer ??= u.origin;

  const a = new URL(asIssuer);
  const path = a.pathname.replace(/\/+$/, "");
  const asCandidates = path
    ? [
        // RFC 8414 path-aware, then OIDC's two path forms, then root forms
        `${a.origin}/.well-known/oauth-authorization-server${path}`,
        `${a.origin}/.well-known/openid-configuration${path}`,
        `${a.origin}${path}/.well-known/openid-configuration`,
        `${a.origin}/.well-known/oauth-authorization-server`,
        `${a.origin}/.well-known/openid-configuration`,
      ]
    : [`${a.origin}/.well-known/oauth-authorization-server`, `${a.origin}/.well-known/openid-configuration`];
  for (const cand of asCandidates) {
    const meta = await fetchJson(cand);
    if (!meta) continue;
    // RFC 8414/OIDC: the metadata's issuer MUST be the issuer we asked
    // about, or the document could belong to (or be planted by) another
    // tenant on the host.
    if (typeof meta.issuer !== "string" || !sameUrlId(meta.issuer, asIssuer)) continue;
    if (!httpsUrl(meta.authorization_endpoint) || !httpsUrl(meta.token_endpoint)) continue;
    const methods = meta.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes("S256")) {
      throw new Error("authorization server does not support PKCE S256");
    }
    const disc: Discovery = {
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
    };
    if (httpsUrl(meta.registration_endpoint)) disc.registrationEndpoint = meta.registration_endpoint;
    if (scopes) disc.scopes = scopes;
    return disc;
  }
  throw new Error("no valid OAuth authorization server metadata found for this MCP server (issuer/resource mismatch or non-https endpoints)");
}

async function registerClient(disc: Discovery, redirectUri: string): Promise<string> {
  if (!disc.registrationEndpoint) {
    throw new Error("server does not offer dynamic client registration - it cannot be connected automatically");
  }
  const res = await fetchJson(disc.registrationEndpoint, {
    method: "POST",
    body: JSON.stringify({
      client_name: "mindash",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (typeof res?.client_id !== "string") throw new Error("client registration failed");
  return res.client_id;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Begin a connection: discovery + DCR, persist the pending flow, and hand
// back the authorization URL to redirect the owner's browser to.
export async function startConnect(
  env: Env,
  name: string,
  serverUrl: string,
  instanceOrigin: string,
): Promise<string> {
  if (!CREDENTIAL_NAME.test(name)) throw new Error("connection name must be kebab-case (a-z, 0-9, dashes)");
  serverUrl = canonicalResource(serverUrl);
  const disc = await discover(serverUrl);
  const redirectUri = `${instanceOrigin}/oauth/callback`;
  const clientId = await registerClient(disc, redirectUri);
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const now = Date.now();
  await env.DB
    .prepare("DELETE FROM mcp_oauth_pending WHERE expires_at <= ?1")
    .bind(now)
    .run();
  await env.DB
    .prepare(
      `INSERT INTO mcp_oauth_pending
         (state, name, server_url, token_endpoint, client_id, verifier, scopes, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(state, name, serverUrl, disc.tokenEndpoint, clientId, verifier, disc.scopes ?? null, now, now + PENDING_TTL_MS)
    .run();
  const authz = new URL(disc.authorizationEndpoint);
  authz.searchParams.set("response_type", "code");
  authz.searchParams.set("client_id", clientId);
  authz.searchParams.set("redirect_uri", redirectUri);
  authz.searchParams.set("state", state);
  authz.searchParams.set("code_challenge", challenge);
  authz.searchParams.set("code_challenge_method", "S256");
  authz.searchParams.set("resource", serverUrl); // RFC 8707 audience binding
  if (disc.scopes) authz.searchParams.set("scope", disc.scopes);
  return authz.toString();
}

function toTokenSet(res: Record<string, unknown>): TokenSet {
  if (typeof res.access_token !== "string") throw new Error("token endpoint returned no access token");
  const set: TokenSet = { access_token: res.access_token };
  if (typeof res.refresh_token === "string") set.refresh_token = res.refresh_token;
  if (typeof res.expires_in === "number") set.expires_at = Date.now() + res.expires_in * 1000;
  return set;
}

// /oauth/callback: consume the pending flow, exchange the code, seal the
// token set. Returns the connection name for the redirect notice.
export async function finishConnect(env: Env, state: string, code: string, instanceOrigin: string): Promise<string> {
  const pending = await env.DB
    .prepare("DELETE FROM mcp_oauth_pending WHERE state = ?1 AND expires_at > ?2 RETURNING *")
    .bind(state, Date.now())
    .first<{ name: string; server_url: string; token_endpoint: string; client_id: string; verifier: string; scopes: string | null }>();
  if (!pending) throw new Error("unknown or expired authorization state");
  const res = await fetchJson(pending.token_endpoint, {
    method: "POST",
    form: true,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${instanceOrigin}/oauth/callback`,
      client_id: pending.client_id,
      code_verifier: pending.verifier,
      resource: pending.server_url,
    }).toString(),
  });
  if (!res) throw new Error("code exchange failed");
  const set = toTokenSet(res);
  const origin = new URL(pending.server_url).origin;
  const sealed = await sealSecret(
    env,
    binding(pending.name, pending.server_url, pending.token_endpoint, pending.client_id),
    JSON.stringify(set),
  );
  await env.DB
    .prepare(
      `INSERT INTO mcp_connections (name, server_url, origin, token_endpoint, client_id, scopes, ciphertext, iv, created_at, binding_version)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 2)
       ON CONFLICT (name) DO UPDATE SET server_url = excluded.server_url,
         origin = excluded.origin, token_endpoint = excluded.token_endpoint,
         client_id = excluded.client_id, scopes = excluded.scopes,
         ciphertext = excluded.ciphertext, iv = excluded.iv,
         token_version = mcp_connections.token_version + 1,
         refresh_lease_until = NULL, binding_version = 2`,
    )
    .bind(pending.name, pending.server_url, origin, pending.token_endpoint, pending.client_id, pending.scopes, sealed.ciphertext, sealed.iv, Date.now())
    .run();
  return pending.name;
}

export interface ConnectionMeta {
  name: string;
  serverUrl: string;
  origin: string;
  createdAt: number;
}

export async function listConnections(env: Env): Promise<ConnectionMeta[]> {
  const { results } = await env.DB
    .prepare("SELECT name, server_url, origin, created_at FROM mcp_connections ORDER BY name")
    .all<ConnectionRow>();
  return results.map((r) => ({ name: r.name, serverUrl: r.server_url, origin: r.origin, createdAt: r.created_at }));
}

export async function deleteConnection(env: Env, name: string): Promise<void> {
  await env.DB.prepare("DELETE FROM mcp_connections WHERE name = ?1").bind(name).run();
}

// Fetch-time resolution for MCP widgets: origin-checked, refreshed when
// near expiry (rotated refresh tokens are persisted before use).
const REFRESH_LEASE_MS = 30_000;

async function loadConnection(env: Env, name: string): Promise<ConnectionRow> {
  const row = await env.DB
    .prepare("SELECT * FROM mcp_connections WHERE name = ?1")
    .bind(name)
    .first<ConnectionRow>();
  if (!row) throw new Error(`MCP connection "${name}" not found - connect it in Settings`);
  return row;
}

async function openTokens(env: Env, row: ConnectionRow): Promise<TokenSet> {
  const full = binding(row.name, canonicalResource(row.server_url), row.token_endpoint, row.client_id);
  // The TRUSTED binding_version column decides which AAD applies — a
  // complete-binding failure is an error, never a fallback (inferring
  // "legacy" from failure would let a tampered token_endpoint fall back
  // to the legacy AAD it still satisfies).
  if (row.binding_version >= 2) {
    try {
      return JSON.parse(await openSecret(env, full, row.ciphertext, row.iv)) as TokenSet;
    } catch {
      throw new Error(`connection "${row.name}" failed to decrypt - reconnect it in Settings`);
    }
  }
  let legacy: TokenSet;
  try {
    legacy = JSON.parse(
      await openSecret(env, legacyBinding(row.name, row.origin), row.ciphertext, row.iv),
    ) as TokenSet;
  } catch {
    throw new Error(`connection "${row.name}" failed to decrypt - reconnect it in Settings`);
  }
  // migrate: reseal under the complete binding, atomically advancing the
  // binding version (guarded by token_version so it can't race a refresh)
  const sealed = await sealSecret(env, full, JSON.stringify(legacy));
  await env.DB
    .prepare(
      `UPDATE mcp_connections SET ciphertext = ?1, iv = ?2, binding_version = 2,
         token_version = token_version + 1
       WHERE name = ?3 AND token_version = ?4 AND binding_version = 1`,
    )
    .bind(sealed.ciphertext, sealed.iv, row.name, row.token_version)
    .run();
  return legacy;
}

// Every adopted row re-validates the caller's requested resource — a
// reconnect can point the same NAME at a different resource mid-request.
function assertResource(row: ConnectionRow, requested: string): void {
  if (requested !== canonicalResource(row.server_url)) {
    throw new Error(`connection "${row.name}" is bound to ${row.server_url} and may not be sent to ${requested}`);
  }
}

export async function connectionHeader(env: Env, name: string, url: string): Promise<Record<string, string>> {
  let row = await loadConnection(env, name);
  // EXACT resource binding: the token was obtained for row.server_url
  // (RFC 8707 audience) and goes to that resource only — never merely
  // anything on the same origin.
  let requested: string;
  try {
    requested = canonicalResource(url);
  } catch {
    throw new Error("invalid url for connection check");
  }
  assertResource(row, requested);
  let set = await openTokens(env, row);
  if (set.expires_at && Date.now() > set.expires_at - REFRESH_SKEW_MS) {
    if (!set.refresh_token) throw new Error(`connection "${name}" expired - reconnect it in Settings`);
    // Serialize refreshes: rotating refresh tokens are single-use, so
    // concurrent widgets must not race the exchange. Claim by
    // (token_version, expired lease); losers wait for the winner's set.
    const now = Date.now();
    const claim = await env.DB
      .prepare(
        `UPDATE mcp_connections SET refresh_lease_until = ?1
         WHERE name = ?2 AND token_version = ?3
           AND (refresh_lease_until IS NULL OR refresh_lease_until < ?4)`,
      )
      .bind(now + REFRESH_LEASE_MS, name, row.token_version, now)
      .run();
    if (claim.meta.changed_db) {
      const res = await fetchJson(row.token_endpoint, {
        method: "POST",
        form: true,
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: set.refresh_token,
          client_id: row.client_id,
          resource: row.server_url,
        }).toString(),
      });
      if (!res) {
        await env.DB
          .prepare("UPDATE mcp_connections SET refresh_lease_until = NULL WHERE name = ?1 AND token_version = ?2")
          .bind(name, row.token_version)
          .run();
        throw new Error(`connection "${name}" could not be refreshed - reconnect it in Settings`);
      }
      const fresh = toTokenSet(res);
      fresh.refresh_token ??= set.refresh_token; // servers may not rotate
      const sealed = await sealSecret(
        env,
        binding(row.name, canonicalResource(row.server_url), row.token_endpoint, row.client_id),
        JSON.stringify(fresh),
      );
      // publication is conditional on the version we claimed — a stale
      // exchange can never overwrite a newer token set (e.g. after the
      // owner reconnected mid-refresh). If we lost, adopt the winner's.
      const published = await env.DB
        .prepare(
          `UPDATE mcp_connections SET ciphertext = ?1, iv = ?2,
             token_version = token_version + 1, refresh_lease_until = NULL
           WHERE name = ?3 AND token_version = ?4`,
        )
        .bind(sealed.ciphertext, sealed.iv, row.name, row.token_version)
        .run();
      if (published.meta.changed_db) {
        set = fresh;
      } else {
        const current = await loadConnection(env, name);
        assertResource(current, requested);
        set = await openTokens(env, current);
      }
    } else {
      // another caller holds the refresh; wait for its published set —
      // at least as long as the exchange's own 10s fetch timeout
      let adopted = false;
      for (let i = 0; i < 26; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const again = await loadConnection(env, name);
        if (again.token_version > row.token_version) {
          assertResource(again, requested);
          row = again;
          set = await openTokens(env, again);
          adopted = true;
          break;
        }
      }
      if (!adopted) throw new Error(`connection "${name}" refresh is in progress - try again shortly`);
    }
  }
  return { authorization: `Bearer ${set.access_token}` };
}
