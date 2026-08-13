import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { html } from "../html";
import { json, randomToken, sha256Hex } from "../auth/util";
import { csrfToken } from "../settings";
import type { SessionInfo } from "../auth/session";

// OAuth consent (plan: "Consent is a separate boundary from authentication").
// The passkey session never silently becomes a grant: /authorize validates
// the full request, shows verified client identity + exact scopes, and
// requires an affirmative approve action. config:sources additionally
// requires a fresh WebAuthn assertion (step-up) bound to this exact pending
// request. Grant completion rechecks the epoch immediately before
// completeAuthorization and stamps the captured value into the grant props.

const PENDING_TTL_MS = 10 * 60 * 1000;
export const KNOWN_SCOPES: Record<string, string> = {
  "config:layout": "Rearrange widgets, edit titles and theming",
  "config:sources": "Add/remove widgets, change sources, schedules and secret references",
};

interface PendingRow {
  pending_id: string;
  session_hash: string;
  req_json: string;
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  scopes: string;
  epoch: number;
  stepup_challenge: string | null;
  stepup_at: number | null;
  expires_at: number;
}

// extraFormAction: the client's redirect origin - Chrome enforces
// form-action against the redirect that FOLLOWS a form submission, so the
// approve/deny 302 to the client's callback needs its origin allowed here.
function consentShell(body: ReturnType<typeof html>, status = 200, extraFormAction = ""): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mindash - authorize</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header><h1>mindash</h1><span class="updated">authorize access</span></header>
<main style="display:block;max-width:520px">${body}</main>
<script src="/auth.js"></script>
</body>
</html>`;
  return new Response(doc.value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${extraFormAction ? ` ${extraFormAction}` : ""}`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

function errorRedirect(redirectUri: string, state: string, code: string): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", code);
  if (state) u.searchParams.set("state", state);
  return Response.redirect(u.toString(), 302);
}

async function currentEpoch(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT epoch FROM owner_state WHERE id = 1").first<{ epoch: number }>();
  if (!row) throw new Error("owner_state missing");
  return row.epoch;
}

export async function authorizePage(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  let oauthReq;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(req);
  } catch (e) {
    return consentShell(
      html`<section class="widget"><h2>Invalid request</h2>
        <p class="error">${String(e instanceof Error ? e.message : e)}</p></section>`,
      400,
    );
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) {
    return consentShell(
      html`<section class="widget"><h2>Unknown client</h2>
        <p class="error">The requesting client is not registered.</p></section>`,
      400,
    );
  }
  // Unknown scopes are denied outright - never silently narrowed.
  const unknown = oauthReq.scope.filter((s) => !(s in KNOWN_SCOPES));
  if (unknown.length > 0 || oauthReq.scope.length === 0) {
    return errorRedirect(oauthReq.redirectUri, oauthReq.state, "invalid_scope");
  }

  const now = Date.now();
  const pendingId = randomToken(16);
  const clientName = client.clientName ?? client.clientId;
  await env.DB
    .prepare(
      `INSERT INTO oauth_pending
         (pending_id, session_hash, req_json, client_id, client_name, redirect_uri, scopes, epoch, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      pendingId,
      session.sessionHash,
      JSON.stringify(oauthReq),
      oauthReq.clientId,
      clientName,
      oauthReq.redirectUri,
      oauthReq.scope.join(","),
      await currentEpoch(env),
      now,
      now + PENDING_TTL_MS,
    )
    .run();

  const needsStepup = oauthReq.scope.includes("config:sources");
  const csrf = await csrfToken(session);
  const redirectOrigin = new URL(oauthReq.redirectUri).origin;
  return consentShell(
    html`<section class="widget">
    <h2>Authorization request</h2>
    <p><strong>${clientName}</strong> is asking for access to your dashboard.</p>
    <p class="meta">client id: ${oauthReq.clientId}</p>
    ${client.clientUri ? html`<p class="meta">website: ${client.clientUri}</p>` : null}
    <p class="meta">redirects to: ${oauthReq.redirectUri}</p>
    <ul class="feed">
      ${oauthReq.scope.map((s) => html`<li><strong>${s}</strong><span class="meta">${KNOWN_SCOPES[s]}</span></li>`)}
    </ul>
    ${needsStepup
      ? html`<p class="meta">Granting <strong>config:sources</strong> requires confirming with your passkey.</p>`
      : null}
    <form method="post" action="/authorize/approve" id="approve-form" data-stepup="${needsStepup ? "1" : ""}" data-pending="${pendingId}">
      <input type="hidden" name="pending_id" value="${pendingId}">
      <input type="hidden" name="csrf" value="${csrf}">
      <p>
        <button type="submit" id="approve-btn">${needsStepup ? "Approve with passkey" : "Approve"}</button>
      </p>
    </form>
    <form method="post" action="/authorize/deny">
      <input type="hidden" name="pending_id" value="${pendingId}">
      <input type="hidden" name="csrf" value="${csrf}">
      <p><button type="submit">Deny</button></p>
    </form>
    <div id="msg" class="meta"></div>
  </section>`,
    200,
    redirectOrigin,
  );
}

async function loadPending(env: Env, session: SessionInfo, pendingId: string): Promise<PendingRow | null> {
  return env.DB
    .prepare(
      `SELECT * FROM oauth_pending
       WHERE pending_id = ?1 AND session_hash = ?2 AND consumed_at IS NULL AND expires_at > ?3`,
    )
    .bind(pendingId, session.sessionHash, Date.now())
    .first<PendingRow>();
}

export async function authorizeApprove(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return consentShell(html`<section class="widget"><h2>Stale form</h2><p class="error">CSRF mismatch - retry the authorization.</p></section>`, 403);
  }
  const pending = await loadPending(env, session, String(form.get("pending_id") ?? ""));
  if (!pending) {
    return consentShell(html`<section class="widget"><h2>Expired</h2><p class="error">This authorization request expired - start over from the client.</p></section>`, 410);
  }
  const scopes = pending.scopes.split(",");
  if (scopes.includes("config:sources") && !pending.stepup_at) {
    return consentShell(html`<section class="widget"><h2>Step-up required</h2><p class="error">config:sources needs a fresh passkey confirmation.</p></section>`, 403);
  }
  // Recheck the epoch immediately before completion and stamp the captured
  // value - a grant racing recovery is created already-unusable.
  const epochNow = await currentEpoch(env);
  if (epochNow !== pending.epoch) {
    return errorRedirect(pending.redirect_uri, (JSON.parse(pending.req_json) as { state: string }).state, "access_denied");
  }
  const consumed = await env.DB
    .prepare("UPDATE oauth_pending SET consumed_at = ?1 WHERE pending_id = ?2 AND consumed_at IS NULL")
    .bind(Date.now(), pending.pending_id)
    .run();
  if (!consumed.meta.changed_db) {
    return consentShell(html`<section class="widget"><h2>Already handled</h2><p class="error">This request was already completed.</p></section>`, 409);
  }
  const grantDbId = pending.pending_id;
  await env.DB
    .prepare(
      `INSERT INTO oauth_grants (grant_db_id, client_id, client_name, scopes, epoch, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(grantDbId, pending.client_id, pending.client_name, pending.scopes, pending.epoch, Date.now())
    .run();
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: JSON.parse(pending.req_json),
    userId: "owner",
    metadata: { grantDbId },
    scope: scopes,
    props: { lane: "oauth", grantDbId, clientId: pending.client_id, scopes, epoch: pending.epoch },
  });
  return Response.redirect(redirectTo, 302);
}

export async function authorizeDeny(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return consentShell(html`<section class="widget"><h2>Stale form</h2><p class="error">CSRF mismatch.</p></section>`, 403);
  }
  const pending = await loadPending(env, session, String(form.get("pending_id") ?? ""));
  if (!pending) {
    return consentShell(html`<section class="widget"><h2>Expired</h2><p class="error">Request already handled or expired.</p></section>`, 410);
  }
  await env.DB
    .prepare("UPDATE oauth_pending SET consumed_at = ?1 WHERE pending_id = ?2 AND consumed_at IS NULL")
    .bind(Date.now(), pending.pending_id)
    .run();
  return errorRedirect(pending.redirect_uri, (JSON.parse(pending.req_json) as { state: string }).state, "access_denied");
}

// Step-up: a fresh WebAuthn assertion bound to this pending request.
export async function stepupOptions(req: Request, env: Env, session: SessionInfo, url: URL): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { pending_id?: string } | null;
  const pending = await loadPending(env, session, String(body?.pending_id ?? ""));
  if (!pending) return json(410, { error: "unknown or expired authorization request" });
  const { results } = await env.DB
    .prepare("SELECT credential_id, transports FROM credentials WHERE revoked_at IS NULL")
    .all<{ credential_id: string; transports: string | null }>();
  const options = await generateAuthenticationOptions({
    rpID: url.hostname,
    userVerification: "preferred",
    allowCredentials: results.map((c) => ({
      id: c.credential_id,
      transports: (c.transports?.split(",") ?? []) as AuthenticatorTransportFuture[],
    })),
  });
  await env.DB
    .prepare("UPDATE oauth_pending SET stepup_challenge = ?1 WHERE pending_id = ?2")
    .bind(options.challenge, pending.pending_id)
    .run();
  return json(200, { options });
}

export async function stepupVerify(req: Request, env: Env, session: SessionInfo, url: URL): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    pending_id?: string;
    credential?: AuthenticationResponseJSON;
  } | null;
  const pending = await loadPending(env, session, String(body?.pending_id ?? ""));
  if (!pending?.stepup_challenge || !body?.credential) return json(400, { error: "no step-up in progress" });
  const cred = await env.DB
    .prepare(
      "SELECT credential_id, public_key, counter, transports FROM credentials WHERE credential_id = ?1 AND revoked_at IS NULL",
    )
    .bind(body.credential.id)
    .first<{ credential_id: string; public_key: string; counter: number; transports: string | null }>();
  if (!cred) return json(401, { error: "unknown credential" });
  const b64 = cred.public_key.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  const publicKey = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) publicKey[i] = bin.charCodeAt(i);
  try {
    const verification = await verifyAuthenticationResponse({
      response: body.credential,
      expectedChallenge: pending.stepup_challenge,
      expectedOrigin: url.origin,
      expectedRPID: url.hostname,
      requireUserVerification: false,
      credential: {
        id: cred.credential_id,
        publicKey,
        counter: cred.counter,
        transports: (cred.transports?.split(",") ?? []) as AuthenticatorTransportFuture[],
      },
    });
    if (!verification.verified) return json(401, { error: "not verified" });
  } catch (e) {
    return json(400, { error: `verification failed: ${String(e)}` });
  }
  await env.DB
    .prepare(
      "UPDATE oauth_pending SET stepup_at = ?1, stepup_challenge = NULL WHERE pending_id = ?2 AND consumed_at IS NULL",
    )
    .bind(Date.now(), pending.pending_id)
    .run();
  return json(200, { ok: true });
}
