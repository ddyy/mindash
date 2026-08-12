import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { renderPage } from "./render";
import { sweep } from "./refresh";
import { pushSweep } from "./push/sweep";
import { handlePush } from "./push/ingest";
import { handleAuth } from "./auth/webauthn";
import { getSession, revokeSession, clearSessionCookie, type SessionInfo } from "./auth/session";
import { sameOriginOk, json } from "./auth/util";
import { loginPage } from "./auth/loginpage";
import { AUTH_JS } from "./auth/client";
import { dispatchMcp, resolveStaticToken, type TokenInfo } from "./mcp/server";
import { settingsPage, revokeGrantAction, revokeTokenAction, csrfToken } from "./settings";
import { editorPage } from "./editor/page";
import { EDITOR_JS } from "./editor/client";
import { EDITOR_CSS } from "./editor/styles";
import { editorPreview, editorDiff, editorYaml, editorParse, editorSave, editorRefresh, editorGeocode, editorHistory, editorRestore, editorProbe, editorSample, editorMcpTools, editorCoinSearch, editorSymbolSearch, editorYtSearch, editorUploadAsset } from "./editor/api";
import {
  authorizePage,
  authorizeApprove,
  authorizeDeny,
  stepupOptions,
  stepupVerify,
  KNOWN_SCOPES,
} from "./oauth/consent";
import { CSS } from "./styles";
import CUSTOM_CSS from "../custom.css";
import { CLOCK_JS } from "./clocklive";
import { ensureSchema } from "./bootstrap";
import { UI_JS } from "./uilive";
import { SETUP_JS, setupPage, setupApply } from "./setup";
import { ASSET_VERSION } from "./assetversion";

// Everything that is not the token-authenticated /mcp API: dashboard,
// login, settings, push ingest, and the OAuth consent UI. Wrapped by
// workers-oauth-provider as the defaultHandler.
const appHandler = {
  async fetch(req, env, ctx): Promise<Response> {
    await ensureSchema(env);
    const url = new URL(req.url);
    try {
      // Push ingest: bearer-token auth, deliberately outside passkey sessions.
      if (req.method === "POST" && url.pathname.startsWith("/push/")) {
        return await handlePush(req, env, url);
      }

      // OAuth consent + step-up (cookie-authenticated; CSRF-checked inside).
      if (url.pathname === "/authorize" && (req.method === "GET" || req.method === "HEAD")) {
        const session = await getSession(req, env);
        if (!session) {
          const next = encodeURIComponent(url.pathname + url.search);
          return Response.redirect(`${url.origin}/login?next=${next}`, 303);
        }
        return await authorizePage(req, env, session);
      }
      if (req.method === "POST" && ["/authorize/approve", "/authorize/deny"].includes(url.pathname)) {
        const session = await requireSession(req, env, url);
        if (session instanceof Response) return session;
        return url.pathname.endsWith("approve")
          ? await authorizeApprove(req, env, session)
          : await authorizeDeny(req, env, session);
      }
      if (req.method === "POST" && ["/auth/stepup/options", "/auth/stepup/verify"].includes(url.pathname)) {
        const session = await requireSession(req, env, url);
        if (session instanceof Response) return session;
        return url.pathname.endsWith("options")
          ? await stepupOptions(req, env, session, url)
          : await stepupVerify(req, env, session, url);
      }

      if (url.pathname.startsWith("/auth/")) {
        if (url.pathname === "/auth/logout") {
          if (req.method !== "POST") return json(405, { error: "method not allowed" });
          if (!sameOriginOk(req, url)) return json(403, { error: "cross-origin request refused" });
          const session = await getSession(req, env);
          if (session) await revokeSession(env, session.sessionHash);
          if ((req.headers.get("accept") ?? "").includes("text/html")) {
            return new Response(null, {
              status: 303,
              headers: { location: `${url.origin}/login`, "set-cookie": clearSessionCookie() },
            });
          }
          return new Response(JSON.stringify({ ok: true }), {
            headers: { "content-type": "application/json", "set-cookie": clearSessionCookie() },
          });
        }
        return await handleAuth(req, env, url);
      }

      // First-run setup: owner-only, and setupApply additionally refuses to
      // overwrite anything but the placeholder document.
      if (url.pathname === "/setup") {
        const session = await getSession(req, env);
        if (!session) return Response.redirect(`${url.origin}/login?next=/setup`, 303);
        if (req.method === "GET" || req.method === "HEAD") return await setupPage(req, session);
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
        if (!sameOriginOk(req, url)) return json(403, { error: "cross-origin request refused" });
        return await setupApply(req, env, session);
      }

      if (url.pathname.startsWith("/settings")) {
        const session = await getSession(req, env);
        if (!session) return Response.redirect(`${url.origin}/login`, 303);
        if (req.method === "GET" || req.method === "HEAD") {
          if (url.pathname === "/settings") return await settingsPage(env, session);
          if (url.pathname === "/settings/editor") return await editorPage(env, session);
          if (url.pathname === "/settings/log") {
            const { logPage } = await import("./settings");
            return await logPage(env, url);
          }
          return new Response("not found", { status: 404 });
        }
        if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
        if (!sameOriginOk(req, url)) return json(403, { error: "cross-origin request refused" });
        switch (url.pathname) {
          case "/settings/passkeys/add/options": {
            const { passkeyAddOptions } = await import("./auth/webauthn");
            return await passkeyAddOptions(req, env, url, await csrfToken(session), session.sessionHash);
          }
          case "/settings/passkeys/add/verify": {
            const { passkeyAddVerify } = await import("./auth/webauthn");
            return await passkeyAddVerify(req, env, url, await csrfToken(session), session.sessionHash);
          }
          case "/settings/passkeys/remove": {
            const { removePasskeyAction } = await import("./settings");
            return await removePasskeyAction(req, env, session);
          }
          case "/settings/grants/revoke":
            return await revokeGrantAction(req, env, session);
          case "/settings/tokens/revoke":
            return await revokeTokenAction(req, env, session);
          case "/settings/credentials/add": {
            const { addCredentialAction } = await import("./settings");
            return await addCredentialAction(req, env, session);
          }
          case "/settings/credentials/remove": {
            const { removeCredentialAction } = await import("./settings");
            return await removeCredentialAction(req, env, session);
          }
          case "/settings/log/retention": {
            const { setRetentionAction } = await import("./settings");
            return await setRetentionAction(req, env, session, url);
          }
          case "/settings/push-tokens/create": {
            const { createPushTokenAction } = await import("./settings");
            return await createPushTokenAction(req, env, session);
          }
          case "/settings/push-tokens/revoke": {
            const { revokePushTokenAction } = await import("./settings");
            return await revokePushTokenAction(req, env, session);
          }
          case "/settings/mcp-connections/connect": {
            const { connectMcpAction } = await import("./settings");
            return await connectMcpAction(req, env, session, url);
          }
          case "/settings/mcp-connections/remove": {
            const { removeMcpConnectionAction } = await import("./settings");
            return await removeMcpConnectionAction(req, env, session);
          }
          case "/settings/editor/preview":
            return await editorPreview(req, env);
          case "/settings/editor/diff":
            return await editorDiff(req, env);
          case "/settings/editor/yaml":
            return await editorYaml(req, env);
          case "/settings/editor/parse":
            return await editorParse(req, env);
          case "/settings/editor/save":
            return await editorSave(req, env, session, ctx);
          case "/settings/editor/refresh":
            return await editorRefresh(req, env);
          case "/settings/editor/geocode":
            return await editorGeocode(req, env);
          case "/settings/editor/probe":
            return await editorProbe(req, env);
          case "/settings/editor/sample":
            return await editorSample(req, env);
          case "/settings/editor/mcptools":
            return await editorMcpTools(req, env);
          case "/settings/editor/coinsearch":
            return await editorCoinSearch(req, env);
          case "/settings/editor/symbolsearch":
            return await editorSymbolSearch(req, env);
          case "/settings/editor/ytsearch":
            return await editorYtSearch(req, env);
          case "/settings/editor/upload-asset":
            return await editorUploadAsset(req, env, session);
          case "/settings/editor/history":
            return await editorHistory(req, env);
          case "/settings/editor/restore":
            return await editorRestore(req, env, session, ctx);
          default:
            return new Response("not found", { status: 404 });
        }
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("method not allowed", { status: 405 });
      }
      // Version-matched asset requests cache immutably (pages embed
      // ?v=<content hash>, so a deploy busts instantly); bare requests
      // stay no-cache so nothing can pin a stale copy.
      const assetCache =
        url.searchParams.get("v") === ASSET_VERSION
          ? "public, max-age=31536000, immutable"
          : "no-cache";
      if (url.pathname === "/robots.txt") {
        return new Response(
          `User-agent: *\nDisallow: /settings\nDisallow: /auth\nDisallow: /login\nDisallow: /mcp\nDisallow: /push\nDisallow: /oauth\nSitemap: ${url.origin}/sitemap.xml\n`,
          { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } },
        );
      }
      if (url.pathname === "/sitemap.xml") {
        // Only pages search engines are ALLOWED to index appear: public AND
        // indexable (everything else already sends noindex). Instances with
        // no such pages serve a valid empty urlset - a 200 keeps crawlers
        // from re-probing a 404.
        const { getConfig } = await import("./config");
        const { pageSlugs } = await import("./render");
        const cfg = await getConfig(env);
        const slugs = pageSlugs(cfg);
        const locs = cfg.pages
          .map((p, i) => ({ p, i }))
          .filter(({ p }) => p.publicView && p.indexable)
          .map(({ i }) => (i === 0 ? `${url.origin}/` : `${url.origin}/p/${slugs[i]}`));
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
          .map((loc) => `  <url><loc>${loc}</loc></url>`)
          .join("\n")}${locs.length ? "\n" : ""}</urlset>\n`;
        return new Response(xml, {
          headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
        });
      }
      if (url.pathname === "/llms.txt") {
        return new Response(
          [
            "# mindash",
            "",
            "A personal Glance-style dashboard on a Cloudflare Worker. Public pages",
            "are server-rendered HTML at / and /p/<slug>.",
            "",
            "## For agents",
            "This instance runs an MCP server (Streamable HTTP) at /mcp - OAuth 2.1",
            "with dynamic client registration. Tools cover reading and editing the",
            "dashboard's runtime config. Source: https://github.com/ddyy/mindash",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" } },
        );
      }
      if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
        // the 12-track grid mark, accent on transparent
        return new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="3" width="12" height="17" rx="2.5" fill="#3d99f5"/><rect x="17" y="3" width="12" height="8" rx="2.5" fill="#3d99f5" opacity="0.55"/><rect x="17" y="13" width="12" height="7" rx="2.5" fill="#3d99f5" opacity="0.75"/><rect x="3" y="22" width="26" height="7" rx="2.5" fill="#3d99f5" opacity="0.35"/></svg>`,
          { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" } },
        );
      }
      if (url.pathname === "/styles.css" || url.pathname === "/custom.css") {
        return new Response(url.pathname === "/styles.css" ? CSS : CUSTOM_CSS, {
          headers: { "content-type": "text/css; charset=utf-8", "cache-control": assetCache },
        });
      }
      if (
        url.pathname === "/auth.js" || url.pathname === "/editor.js" || url.pathname === "/clock.js" ||
        url.pathname === "/ui.js" || url.pathname === "/setup.js"
      ) {
        const scripts = { "/auth.js": AUTH_JS, "/editor.js": EDITOR_JS, "/clock.js": CLOCK_JS, "/ui.js": UI_JS, "/setup.js": SETUP_JS };
        return new Response(scripts[url.pathname as keyof typeof scripts], {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": assetCache,
          },
        });
      }
      if (url.pathname.startsWith("/asset/")) {
        const key = url.pathname.slice(7);
        if (!/^[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/.test(key)) return new Response("not found", { status: 404 });
        const obj = await env.ASSETS.get(key);
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, {
          headers: {
            "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
            // content-hashed keys never change meaning
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      }
      if (url.pathname === "/editor.css") {
        return new Response(EDITOR_CSS, {
          headers: { "content-type": "text/css; charset=utf-8", "cache-control": assetCache },
        });
      }
      // OAuth-client callback (upstream MCP connections). Session-gated:
      // only the owner's browser completes a flow, and the state row
      // (created from an owner session) must match.
      if (url.pathname === "/oauth/callback") {
        const session = await getSession(req, env);
        if (!session) return Response.redirect(`${url.origin}/login`, 303);
        const { finishConnect } = await import("./mcpclient");
        const { settingsPage } = await import("./settings");
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        const upstreamErr = url.searchParams.get("error");
        if (upstreamErr || !code) {
          return await settingsPage(env, session, { error: `authorization failed: ${upstreamErr ?? "no code returned"}` });
        }
        try {
          const name = await finishConnect(env, state, code, url.origin);
          return await settingsPage(env, session, { ok: `MCP connection "${name}" established` });
        } catch (e) {
          return await settingsPage(env, session, { error: String(e instanceof Error ? e.message : e) });
        }
      }
      if (url.pathname === "/login") {
        {
          const authedNow = (await getSession(req, env)) !== null;
          const { setupMode } = await import("./auth/webauthn");
          // hostname drives the claim notice: a passkey binds to it
          return loginPage(authedNow, !authedNow && (await setupMode(env)), url.hostname);
        }
      }
      if (url.pathname === "/") {
        const authed = (await getSession(req, env)) !== null;
        // The owner arriving on a never-configured instance goes straight
        // to setup; anonymous visitors just see the placeholder card.
        if (authed) {
          const { isPlaceholderDoc } = await import("./setup");
          const { getCurrentConfig } = await import("./config");
          if (isPlaceholderDoc((await getCurrentConfig(env)).doc)) {
            return Response.redirect(`${url.origin}/setup`, 303);
          }
        }
        return await renderPage(env, url, undefined, authed);
      }
      if (url.pathname.startsWith("/p/")) {
        return await renderPage(env, url, decodeURIComponent(url.pathname.slice(3)), (await getSession(req, env)) !== null);
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.log(JSON.stringify({ evt: "request_error", path: url.pathname, error: String(e) }));
      return new Response("internal error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function requireSession(req: Request, env: Env, url: URL): Promise<SessionInfo | Response> {
  if (!sameOriginOk(req, url)) return json(403, { error: "cross-origin request refused" });
  const session = await getSession(req, env);
  if (!session) return json(401, { error: "session required" });
  return session;
}

interface McpProps {
  lane: "oauth" | "static";
  scopes: string[];
  epoch: number;
  grantDbId?: string;
  clientId?: string;
  label?: string;
}

// Token-authenticated /mcp API. The provider has already validated the
// bearer credential (OAuth token, or static token via resolveExternalToken)
// and put the grant props on ctx.props. Commit-time discipline: re-verify
// the owner epoch and grant revocation on EVERY request - recovery or a
// settings revoke kills in-flight authority even while KV cleanup lags.
const apiHandler = {
  async fetch(req, env, ctx): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: McpProps }).props;
    if (!props?.scopes || typeof props.epoch !== "number") {
      return json(401, { error: "invalid token context" });
    }
    const owner = await env.DB
      .prepare("SELECT epoch FROM owner_state WHERE id = 1")
      .first<{ epoch: number }>();
    if (!owner || props.epoch !== owner.epoch) {
      return json(401, { error: "authorization epoch superseded" });
    }
    let label = props.label ?? "mcp";
    if (props.lane === "oauth") {
      const grant = await env.DB
        .prepare(
          "SELECT client_name FROM oauth_grants WHERE grant_db_id = ?1 AND revoked_at IS NULL AND epoch = ?2",
        )
        .bind(props.grantDbId ?? "", props.epoch)
        .first<{ client_name: string | null }>();
      if (!grant) return json(401, { error: "grant revoked" });
      label = grant.client_name ?? props.clientId ?? "oauth-client";
    }
    const token: TokenInfo = { scopes: new Set(props.scopes), epoch: props.epoch, label };
    return dispatchMcp(req, env, token);
  },
} satisfies ExportedHandler<Env>;

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: appHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: Object.keys(KNOWN_SCOPES),
  accessTokenTTL: 3600,
  refreshTokenTTL: 30 * 24 * 3600,
  clientRegistrationTTL: 7 * 24 * 3600, // deliberately short for DCR clients
  // CIMD lane (2026 MCP auth spec), enabled in every deploy: wrangler.jsonc
  // ships the required global_fetch_strictly_public flag. Local dev drops
  // that flag on the command line; CIMD stays on there harmlessly, since it
  // only engages for URL-shaped client ids (DCR clients are unaffected).
  clientIdMetadataDocumentEnabled: true,
  // OAuth 2.1 posture: implicit stays off, PKCE S256 only (both defaults).
  resolveExternalToken: async ({ token, env }) => {
    const info = await resolveStaticToken(token, env);
    if (!info) return null;
    return {
      props: {
        lane: "static",
        scopes: [...info.scopes],
        epoch: info.epoch,
        label: info.label,
      } satisfies McpProps,
    };
  },
  clientRegistrationCallback: ({ clientMetadata }) => {
    // Metadata restriction: redirect URIs must be https or loopback.
    const uris = clientMetadata.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0) return; // provider validates presence
    for (const u of uris) {
      try {
        const parsed = new URL(String(u));
        const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
        if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
          return { description: `redirect_uri must be https or loopback: ${String(u)}` };
        }
      } catch {
        return { description: `invalid redirect_uri: ${String(u)}` };
      }
    }
    return undefined;
  },
});

// DCR abuse controls (plan): edge-style rate limit + an active-client
// quota counted over UNEXPIRED admission slots (clientRegistrationTTL),
// both strongly consistent in D1 and failing CLOSED. Reservation is a
// conditional INSERT; a failed registration releases its slot, and
// expired clients free capacity automatically — the quota can never
// wedge permanently. Limits are env-overridable for integration tests.
const DCR_WINDOW_MS = 60_000;
const DCR_SLOT_TTL_MS = 7 * 24 * 3600 * 1000; // matches clientRegistrationTTL

function dcrLimits(env: Env): { maxActive: number; maxPerWindow: number } {
  const e = env as unknown as Record<string, string | undefined>;
  return {
    maxActive: Number(e.DCR_MAX_ACTIVE ?? 20) || 20,
    maxPerWindow: Number(e.DCR_MAX_PER_WINDOW ?? 10) || 10,
  };
}

async function dcrGuard(env: Env): Promise<{ blocked: Response } | { slotId: string }> {
  const now = Date.now();
  const { maxActive, maxPerWindow } = dcrLimits(env);
  const blocked = new Response(
    JSON.stringify({ error: "invalid_client_metadata", error_description: "registration temporarily closed" }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } },
  );
  const windowOk = await env.DB
    .prepare(
      `UPDATE dcr_admissions SET
         window_count = CASE WHEN window_start < ?1 THEN 1 ELSE window_count + 1 END,
         window_start = CASE WHEN window_start < ?1 THEN ?2 ELSE window_start END
       WHERE id = 1 AND (window_start < ?1 OR window_count < ?3)`,
    )
    .bind(now - DCR_WINDOW_MS, now, maxPerWindow)
    .run();
  if (!windowOk.meta.changed_db) return { blocked };
  const slotId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare("DELETE FROM dcr_slots WHERE expires_at <= ?1").bind(now),
    env.DB
      .prepare(
        `INSERT INTO dcr_slots (slot_id, created_at, expires_at)
         SELECT ?1, ?2, ?3
         WHERE (SELECT COUNT(*) FROM dcr_slots WHERE expires_at > ?2) < ?4`,
      )
      .bind(slotId, now, now + DCR_SLOT_TTL_MS, maxActive),
  ]);
  if (!results[1]?.meta.changed_db) return { blocked };
  return { slotId };
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    // Schema bootstrap runs before ANY routing: /register (and other
    // provider-owned routes) never reach appHandler, so a fresh one-click
    // deploy whose first stateful request is DCR must not race the
    // tables into existence. Idempotent and per-isolate cached.
    await ensureSchema(env);
    if (req.method === "POST" && url.pathname === "/register") {
      const admission = await dcrGuard(env);
      if ("blocked" in admission) return admission.blocked;
      // Release is SYNCHRONOUS on every unsuccessful outcome (including a
      // thrown provider error) — an async release could let the next
      // registration see a phantom occupied slot, and a throw would have
      // pinned the slot for the full TTL. Only a confirmed 201 keeps it.
      let registered = false;
      try {
        const resp = await provider.fetch(req, env, ctx);
        registered = resp.status === 201;
        return resp;
      } finally {
        if (!registered) {
          await env.DB.prepare("DELETE FROM dcr_slots WHERE slot_id = ?1").bind(admission.slotId).run();
        }
      }
    }
    return provider.fetch(req, env, ctx);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    await ensureSchema(env);
    ctx.waitUntil(sweep(env));
    ctx.waitUntil(pushSweep(env));
    ctx.waitUntil(
      provider
        .purgeExpiredData(env)
        .then(() => undefined)
        .catch((e: unknown) =>
          console.log(JSON.stringify({ evt: "oauth_purge_error", error: String(e) })),
        ),
    );
  },
} satisfies ExportedHandler<Env>;
