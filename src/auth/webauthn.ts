import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { json, randomToken, sameOriginOk, sha256Hex } from "./util";
import { createSession, sessionCookie } from "./session";

// Passkey flows. Enrollment is gated by a
// single-use token whose PURPOSE (enroll vs recover) is recorded - never by
// a flag. Recovery is an account-reset ceremony: one conditional D1 batch
// inserts the replacement credential, consumes challenge + token, revokes
// every previous credential and session, and increments the epoch - visible
// together or not at all.

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

interface CredentialRow {
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
}

interface ChallengeRow {
  challenge_id: string;
  purpose: string;
  challenge: string;
  token_hash: string | null;
  epoch: number;
  expires_at: number;
}

async function currentEpoch(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT epoch FROM owner_state WHERE id = 1").first<{ epoch: number }>();
  if (!row) throw new Error("owner_state missing");
  return row.epoch;
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return null;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    return typeof body === "object" && body !== null ? body : null;
  } catch {
    return null;
  }
}

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- session-authorized passkey management (settings) ----------
// Adding a passkey from an authenticated session needs no one-time token:
// the session IS the authorization. Challenges use purpose 'enroll' with a
// NULL token_hash, which the token-based verify path never matches.

export async function passkeyAddOptions(req: Request, env: Env, url: URL, csrfExpected: string, sessionHash: string): Promise<Response> {
  const body = await readJson(req);
  if (String(body?.csrf ?? "") !== csrfExpected) return json(403, { error: "stale session (CSRF) - reload" });
  const epoch = await currentEpoch(env);
  const { results: existing } = await env.DB
    .prepare("SELECT credential_id, transports FROM credentials WHERE revoked_at IS NULL")
    .all<{ credential_id: string; transports: string | null }>();
  const options = await generateRegistrationOptions({
    rpName: "mindash",
    rpID: url.hostname,
    userName: "owner",
    userID: Uint8Array.from(new TextEncoder().encode("mindash-owner")),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    excludeCredentials: existing.map((c) => ({
      id: c.credential_id,
      transports: (c.transports?.split(",") ?? []) as AuthenticatorTransportFuture[],
    })),
  });
  const challengeId = randomToken(16);
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO challenges (challenge_id, purpose, challenge, token_hash, epoch, created_at, expires_at, session_hash)
       VALUES (?1, 'enroll', ?2, NULL, ?3, ?4, ?5, ?6)`,
    )
    .bind(challengeId, options.challenge, epoch, now, now + CHALLENGE_TTL_MS, sessionHash)
    .run();
  return json(200, { challengeId, options });
}

export async function passkeyAddVerify(req: Request, env: Env, url: URL, csrfExpected: string, sessionHash: string): Promise<Response> {
  const body = await readJson(req);
  if (String(body?.csrf ?? "") !== csrfExpected) return json(403, { error: "stale session (CSRF) - reload" });
  const challengeId = typeof body?.challengeId === "string" ? body.challengeId : "";
  const credential = body?.credential as RegistrationResponseJSON | undefined;
  if (!challengeId || !credential) return json(400, { error: "challengeId and credential required" });
  const now = Date.now();
  const ch = await env.DB
    .prepare(
      `SELECT challenge_id, purpose, challenge, token_hash, epoch, expires_at FROM challenges
       WHERE challenge_id = ?1 AND consumed_at IS NULL AND expires_at > ?2
         AND purpose = 'enroll' AND token_hash IS NULL AND session_hash = ?3`,
    )
    .bind(challengeId, now, sessionHash)
    .first<ChallengeRow>();
  if (!ch) return json(401, { error: "unknown or expired challenge" });
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: ch.challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      requireUserVerification: false,
    });
  } catch (e) {
    return json(400, { error: `verification failed: ${String(e)}` });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return json(400, { error: "registration not verified" });
  }
  const info = verification.registrationInfo.credential;
  const LANDED = "EXISTS (SELECT 1 FROM credentials WHERE credential_id = ?2 AND created_at = ?3)";
  const results = await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO credentials (credential_id, public_key, counter, transports, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE (SELECT epoch FROM owner_state WHERE id = 1) = ?6
           AND EXISTS (SELECT 1 FROM challenges
                       WHERE challenge_id = ?7 AND consumed_at IS NULL AND expires_at > ?5
                         AND session_hash = ?8)
           AND EXISTS (SELECT 1 FROM sessions s
                       JOIN credentials sc ON sc.credential_id = s.credential_id
                       WHERE s.session_hash = ?8 AND s.revoked_at IS NULL AND s.expires_at > ?5
                         AND s.epoch = ?6 AND sc.revoked_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM credentials WHERE credential_id = ?1)`,
      )
      .bind(info.id, bytesToB64u(info.publicKey), info.counter, (info.transports ?? []).join(","), now, ch.epoch, challengeId, sessionHash),
    env.DB
      .prepare(`UPDATE challenges SET consumed_at = ?1 WHERE challenge_id = ?4 AND consumed_at IS NULL AND ${LANDED}`)
      .bind(now, info.id, now, challengeId),
  ]);
  if (!results[0]?.meta.changed_db) {
    return json(409, { error: "add-passkey preconditions failed (state changed) - retry" });
  }
  return json(200, { ok: true });
}

// Removal: never the last active credential, never the one backing the
// current session (sign in with another passkey first) - and every
// session bound to the removed credential dies with it.
export async function passkeyRemove(env: Env, session: { sessionHash: string; credentialId: string }, credentialId: string): Promise<{ ok?: string; error?: string }> {
  if (!credentialId) return { error: "credential required" };
  if (credentialId === session.credentialId) {
    return { error: "that passkey backs this session - sign in with a different one to remove it" };
  }
  const now = Date.now();
  // Commit-time authorization: the revoke lands only if the authorizing
  // session is itself still live (unrevoked, unexpired, current epoch)
  // and backed by an unrevoked credential - a session revoked mid-request
  // cannot remove passkeys.
  const res = await env.DB
    .prepare(
      `UPDATE credentials SET revoked_at = ?1
       WHERE credential_id = ?2 AND revoked_at IS NULL
         AND (SELECT COUNT(*) FROM credentials WHERE revoked_at IS NULL) > 1
         AND EXISTS (SELECT 1 FROM sessions s
                     JOIN credentials sc ON sc.credential_id = s.credential_id
                     WHERE s.session_hash = ?3 AND s.revoked_at IS NULL AND s.expires_at > ?1
                       AND s.epoch = (SELECT epoch FROM owner_state WHERE id = 1)
                       AND sc.revoked_at IS NULL)`,
    )
    .bind(now, credentialId, session.sessionHash)
    .run();
  if (!res.meta.changed_db) return { error: "cannot remove: unknown passkey or it is the last one" };
  await env.DB
    .prepare("UPDATE sessions SET revoked_at = ?1 WHERE credential_id = ?2 AND revoked_at IS NULL")
    .bind(now, credentialId)
    .run();
  return { ok: "passkey removed" };
}

export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (!sameOriginOk(req, url)) return json(403, { error: "cross-origin request refused" });

  switch (url.pathname) {
    case "/auth/register/options":
      return registerOptions(req, env, url);
    case "/auth/register/verify":
      return registerVerify(req, env, url);
    case "/auth/login/options":
      return loginOptions(env, url);
    case "/auth/login/verify":
      return loginVerify(req, env, url);
    default:
      return json(404, { error: "not found" });
  }
}

// A virgin instance (no credentials, no tokens) allows one tokenless
// first enrollment - the one-click-deploy setup path. The real guard is
// in the verify batch: the credential only lands while the instance
// still has ZERO credentials, so a race collapses to first-wins.
export async function setupMode(env: Env): Promise<boolean> {
  const row = await env.DB
    .prepare(
      `SELECT (SELECT COUNT(*) FROM credentials WHERE revoked_at IS NULL) AS creds,
              (SELECT COUNT(*) FROM auth_tokens WHERE consumed_at IS NULL) AS tokens`,
    )
    .first<{ creds: number; tokens: number }>();
  return !!row && row.creds === 0 && row.tokens === 0;
}

async function registerOptions(req: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJson(req);
  const token = typeof body?.token === "string" ? body.token : "";
  let tokenHash: string | null = null;
  let purpose = "enroll";
  if (!token) {
    if (!(await setupMode(env))) return json(400, { error: "token required" });
  } else {
    tokenHash = await sha256Hex(token);
    const tokenRow = await env.DB
      .prepare("SELECT purpose FROM auth_tokens WHERE token_hash = ?1 AND consumed_at IS NULL")
      .bind(tokenHash)
      .first<{ purpose: string }>();
    if (!tokenRow) return json(401, { error: "invalid or consumed token" });
    purpose = tokenRow.purpose;
  }
  const tokenRow = { purpose };

  const epoch = await currentEpoch(env);
  const { results: existing } = await env.DB
    .prepare("SELECT credential_id, transports FROM credentials WHERE revoked_at IS NULL")
    .all<{ credential_id: string; transports: string | null }>();

  const options = await generateRegistrationOptions({
    rpName: "mindash",
    rpID: url.hostname,
    userName: "owner",
    userID: Uint8Array.from(new TextEncoder().encode("mindash-owner")),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    // Recovery replaces everything, so re-registering existing hardware is allowed.
    excludeCredentials:
      tokenRow.purpose === "enroll"
        ? existing.map((c) => ({
            id: c.credential_id,
            transports: (c.transports?.split(",") ?? []) as AuthenticatorTransportFuture[],
          }))
        : [],
  });

  const challengeId = randomToken(16);
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO challenges (challenge_id, purpose, challenge, token_hash, epoch, created_at, expires_at, session_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(challengeId, tokenRow.purpose, options.challenge, tokenHash, epoch, now, now + CHALLENGE_TTL_MS, tokenHash === null ? "setup" : null)
    .run();
  return json(200, { challengeId, options });
}

async function registerVerify(req: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJson(req);
  const challengeId = typeof body?.challengeId === "string" ? body.challengeId : "";
  const credential = body?.credential as RegistrationResponseJSON | undefined;
  if (!challengeId || !credential) return json(400, { error: "challengeId and credential required" });

  const now = Date.now();
  const ch = await env.DB
    .prepare(
      `SELECT challenge_id, purpose, challenge, token_hash, epoch, expires_at, session_hash FROM challenges
       WHERE challenge_id = ?1 AND consumed_at IS NULL AND expires_at > ?2
         AND purpose IN ('enroll', 'recover')`,
    )
    .bind(challengeId, now)
    .first<ChallengeRow & { session_hash: string | null }>();
  if (!ch) return json(401, { error: "unknown or expired challenge" });
  const isSetup = ch.token_hash === null && ch.session_hash === "setup";
  if (!ch.token_hash && !isSetup) return json(401, { error: "unknown or expired challenge" });

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: ch.challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      requireUserVerification: false,
    });
  } catch (e) {
    return json(400, { error: `verification failed: ${String(e)}` });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return json(400, { error: "registration not verified" });
  }
  const info = verification.registrationInfo.credential;
  const publicKeyB64u = bytesToB64u(info.publicKey);
  const transports = (info.transports ?? []).join(",");

  // One transactional batch; the credential INSERT carries every
  // precondition, and the follow-up statements are conditioned on the
  // credential having landed - all-or-nothing without explicit rollback.
  // "The replacement credential landed in this batch" - the condition every
  // follow-up statement hangs off. Params: credential id, then `now`.
  const LANDED = "EXISTS (SELECT 1 FROM credentials WHERE credential_id = ?2 AND created_at = ?3)";
  const insertCredential = env.DB
    .prepare(
      isSetup
        ? `INSERT INTO credentials (credential_id, public_key, counter, transports, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5
           WHERE (SELECT epoch FROM owner_state WHERE id = 1) = ?6
             AND ?7 IS NULL
             AND EXISTS (SELECT 1 FROM challenges
                         WHERE challenge_id = ?8 AND consumed_at IS NULL AND expires_at > ?5)
             AND NOT EXISTS (SELECT 1 FROM credentials WHERE revoked_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM credentials WHERE credential_id = ?1)`
        : `INSERT INTO credentials (credential_id, public_key, counter, transports, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5
           WHERE (SELECT epoch FROM owner_state WHERE id = 1) = ?6
             AND EXISTS (SELECT 1 FROM auth_tokens WHERE token_hash = ?7 AND consumed_at IS NULL)
             AND EXISTS (SELECT 1 FROM challenges
                         WHERE challenge_id = ?8 AND consumed_at IS NULL AND expires_at > ?5)
             AND NOT EXISTS (SELECT 1 FROM credentials WHERE credential_id = ?1)`,
    )
    .bind(info.id, publicKeyB64u, info.counter, transports, now, ch.epoch, ch.token_hash, challengeId);
  const consumeToken = env.DB
    .prepare(
      `UPDATE auth_tokens SET consumed_at = ?1
       WHERE token_hash = ?4 AND ?4 IS NOT NULL AND consumed_at IS NULL AND ${LANDED}`,
    )
    .bind(now, info.id, now, ch.token_hash);
  const consumeChallenge = env.DB
    .prepare(
      `UPDATE challenges SET consumed_at = ?1
       WHERE challenge_id = ?4 AND consumed_at IS NULL AND ${LANDED}`,
    )
    .bind(now, info.id, now, challengeId);

  const stmts = [insertCredential, consumeToken, consumeChallenge];
  if (ch.purpose === "recover") {
    // Account reset: revoke every other credential and all sessions, bump
    // the epoch - each conditioned on the replacement credential landing.
    stmts.push(
      env.DB
        .prepare(
          `UPDATE credentials SET revoked_at = ?1
           WHERE credential_id != ?2 AND revoked_at IS NULL AND ${LANDED}`,
        )
        .bind(now, info.id, now),
      env.DB
        .prepare(`UPDATE sessions SET revoked_at = ?1 WHERE revoked_at IS NULL AND ${LANDED}`)
        .bind(now, info.id, now),
      env.DB
        .prepare(`UPDATE owner_state SET epoch = epoch + 1 WHERE id = 1 AND ?1 = ?1 AND ${LANDED}`)
        .bind(now, info.id, now),
    );
  }
  const results = await env.DB.batch(stmts);
  if (!results[0]?.meta.changed_db) {
    return json(409, { error: "registration preconditions failed (token consumed or state changed)" });
  }
  return json(200, { ok: true, recovered: ch.purpose === "recover" });
}

async function loginOptions(env: Env, url: URL): Promise<Response> {
  const epoch = await currentEpoch(env);
  const { results } = await env.DB
    .prepare("SELECT credential_id, transports FROM credentials WHERE revoked_at IS NULL")
    .all<{ credential_id: string; transports: string | null }>();
  if (results.length === 0) return json(409, { error: "no credentials enrolled" });

  const options = await generateAuthenticationOptions({
    rpID: url.hostname,
    userVerification: "preferred",
    allowCredentials: results.map((c) => ({
      id: c.credential_id,
      transports: (c.transports?.split(",") ?? []) as AuthenticatorTransportFuture[],
    })),
  });

  const challengeId = randomToken(16);
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO challenges (challenge_id, purpose, challenge, epoch, created_at, expires_at)
       VALUES (?1, 'login', ?2, ?3, ?4, ?5)`,
    )
    .bind(challengeId, options.challenge, epoch, now, now + CHALLENGE_TTL_MS)
    .run();
  return json(200, { challengeId, options });
}

async function loginVerify(req: Request, env: Env, url: URL): Promise<Response> {
  const body = await readJson(req);
  const challengeId = typeof body?.challengeId === "string" ? body.challengeId : "";
  const credential = body?.credential as AuthenticationResponseJSON | undefined;
  if (!challengeId || !credential) return json(400, { error: "challengeId and credential required" });

  const now = Date.now();
  const ch = await env.DB
    .prepare(
      `SELECT challenge_id, purpose, challenge, token_hash, epoch, expires_at FROM challenges
       WHERE challenge_id = ?1 AND consumed_at IS NULL AND expires_at > ?2 AND purpose = 'login'`,
    )
    .bind(challengeId, now)
    .first<ChallengeRow>();
  if (!ch) return json(401, { error: "unknown or expired challenge" });

  const cred = await env.DB
    .prepare(
      `SELECT credential_id, public_key, counter, transports FROM credentials
       WHERE credential_id = ?1 AND revoked_at IS NULL`,
    )
    .bind(credential.id)
    .first<CredentialRow>();
  if (!cred) return json(401, { error: "unknown credential" });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: ch.challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      requireUserVerification: false,
      credential: {
        id: cred.credential_id,
        publicKey: b64uToBytes(cred.public_key),
        counter: cred.counter,
        transports: (cred.transports?.split(",") ?? []) as AuthenticatorTransportFuture[],
      },
    });
  } catch (e) {
    return json(400, { error: `verification failed: ${String(e)}` });
  }
  if (!verification.verified) return json(401, { error: "not verified" });

  const consumed = await env.DB
    .prepare("UPDATE challenges SET consumed_at = ?1 WHERE challenge_id = ?2 AND consumed_at IS NULL")
    .bind(now, challengeId)
    .run();
  if (!consumed.meta.changed_db) return json(409, { error: "challenge already used" });

  const cookieVal = await createSession(env, cred.credential_id, ch.epoch, challengeId);
  if (!cookieVal) return json(409, { error: "session preconditions failed" });

  await env.DB
    .prepare("UPDATE credentials SET counter = ?1 WHERE credential_id = ?2 AND revoked_at IS NULL")
    .bind(verification.authenticationInfo.newCounter, cred.credential_id)
    .run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": sessionCookie(cookieVal) },
  });
}
