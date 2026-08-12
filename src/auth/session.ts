import { randomToken, sha256Hex } from "./util";

export const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;

export interface SessionInfo {
  sessionHash: string;
  credentialId: string;
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// Valid only if unrevoked, unexpired, AND stamped with the current epoch -
// recovery's epoch bump instantly invalidates every older session.
export async function getSession(req: Request, env: Env): Promise<SessionInfo | null> {
  const raw = cookieValue(req, SESSION_COOKIE);
  if (!raw) return null;
  const sessionHash = await sha256Hex(raw);
  const now = Date.now();
  const row = await env.DB
    .prepare(
      `SELECT s.session_hash, s.credential_id FROM sessions s
       WHERE s.session_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2
         AND s.epoch = (SELECT epoch FROM owner_state WHERE id = 1)
         AND EXISTS (SELECT 1 FROM credentials c
                     WHERE c.credential_id = s.credential_id AND c.revoked_at IS NULL)`,
    )
    .bind(sessionHash, now)
    .first<{ session_hash: string; credential_id: string }>();
  if (!row) return null;
  return { sessionHash: row.session_hash, credentialId: row.credential_id };
}

// Session creation re-verifies epoch + credential activity + challenge
// consumption inside the committing statement (a paused login must not mint
// a session after recovery commits). Returns the cookie value, or null if
// any precondition failed.
export async function createSession(
  env: Env,
  credentialId: string,
  capturedEpoch: number,
  challengeId: string,
): Promise<string | null> {
  const value = randomToken(32);
  const sessionHash = await sha256Hex(value);
  const now = Date.now();
  const res = await env.DB
    .prepare(
      `INSERT INTO sessions (session_hash, credential_id, epoch, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT epoch FROM owner_state WHERE id = 1) = ?3
         AND EXISTS (SELECT 1 FROM credentials
                     WHERE credential_id = ?2 AND revoked_at IS NULL)
         AND EXISTS (SELECT 1 FROM challenges
                     WHERE challenge_id = ?6 AND consumed_at IS NOT NULL)`,
    )
    .bind(sessionHash, credentialId, capturedEpoch, now, now + SESSION_TTL_MS, challengeId)
    .run();
  return res.meta.changed_db ? value : null;
}

export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000,
  )}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function revokeSession(env: Env, sessionHash: string): Promise<void> {
  await env.DB
    .prepare("UPDATE sessions SET revoked_at = ?1 WHERE session_hash = ?2 AND revoked_at IS NULL")
    .bind(Date.now(), sessionHash)
    .run();
}
