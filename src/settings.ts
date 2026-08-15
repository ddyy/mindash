import { globalHeader } from "./header";
import { av } from "./assetversion";
import { themeCssVars, imgSrcFor } from "./render";
import { getConfig, isPullWidget, type DashConfig } from "./config";
import { html, SafeHtml } from "./html";
import { relativeTime } from "./widgets/shared";
import { sha256Hex } from "./auth/util";
import type { SessionInfo } from "./auth/session";
import { listCredentials, putCredential, deleteCredential, normalizeOrigin, vaultKeyStatus, CREDENTIAL_TYPES } from "./vault";
import { listConnections, deleteConnection, startConnect } from "./mcpclient";
import {
  logRetentionDays,
  setLogRetentionDays,
  LOG_RETENTION_CHOICES,
  logMaxPerWidget,
  setLogMaxPerWidget,
  LOG_CAP_CHOICES,
  cloudflareAnalytics,
  setCloudflareAnalytics,
} from "./appsettings";

// /settings: the raw-document editor (plan: "the config document IS the
// UI"). Owner session carries full authority. CSRF: session-bound token
// (derived from the server-side session hash) + the same-origin checks the
// router already applies; mutations are POST-only, form-encoded.

export async function csrfToken(session: SessionInfo): Promise<string> {
  return sha256Hex(`csrf:${session.sessionHash}`);
}

// logout: the account action belongs on the settings hub, not on every
// page that borrows this shell (the log is a read-only view).
function page(body: ReturnType<typeof html>, status = 200, cfg?: DashConfig, logout = true): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cfg?.theme.title ?? "mindash"} - access</title>
<link rel="stylesheet" href="${av("/styles.css")}">
<script src="${av("/auth.js")}" defer></script>
${cfg ? html`<style>:root { ${new SafeHtml(themeCssVars(cfg.theme))} }</style>` : null}
</head>
<body>
${globalHeader("settings", { title: cfg?.theme.title, logo: cfg?.theme.logo })}
<main style="display:block;max-width:760px;margin-inline:auto">
${logout ? html`<form method="post" action="/auth/logout" class="logout-top"><button type="submit">log out</button></form>` : null}
${body}
</main>
</body>
</html>`;
  return new Response(doc.value, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${cfg ? imgSrcFor(cfg) : ""}`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

interface GrantRow {
  grant_db_id: string;
  client_name: string | null;
  client_id: string;
  scopes: string;
  created_at: number;
}
interface McpTokenRow {
  token_hash: string;
  label: string | null;
  scopes: string;
  created_at: number;
}

export async function settingsPage(
  env: Env,
  session: SessionInfo,
  notice?: { ok?: string; error?: string },
): Promise<Response> {
  // Everything this page needs, in flight together. These reads are
  // independent, and D1 lives in one region: awaited one after another
  // they were ten sequential round trips, which is what put this page at
  // a 376ms median and a 950ms p95 while burning 7ms of CPU.
  const [
    csrf,
    { results: grants },
    { results: tokens },
    { results: creds },
    { results: pushTokens },
    cfg,
    creds2,
    keyStatus,
    connections,
    retention,
    logCap,
    analytics,
  ] = await Promise.all([
    csrfToken(session),
    env.DB
      .prepare(
        `SELECT grant_db_id, client_name, client_id, scopes, created_at FROM oauth_grants
         WHERE revoked_at IS NULL AND epoch = (SELECT epoch FROM owner_state WHERE id = 1)
         ORDER BY created_at DESC`,
      )
      .all<GrantRow>(),
    env.DB
      .prepare(
        `SELECT token_hash, label, scopes, created_at FROM mcp_tokens
         WHERE revoked_at IS NULL AND epoch = (SELECT epoch FROM owner_state WHERE id = 1)
         ORDER BY created_at DESC`,
      )
      .all<McpTokenRow>(),
    env.DB
      .prepare("SELECT credential_id, created_at FROM credentials WHERE revoked_at IS NULL ORDER BY created_at")
      .all<{ credential_id: string; created_at: number }>(),
    env.DB
      .prepare("SELECT token_hash, widget_name, created_at FROM push_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC")
      .all<{ token_hash: string; widget_name: string; created_at: number }>(),
    getConfig(env),
    listCredentials(env),
    vaultKeyStatus(env),
    listConnections(env),
    logRetentionDays(env),
    logMaxPerWidget(env),
    cloudflareAnalytics(env),
  ]);
  const passkeySection = html`<section class="widget access" id="passkeys">
    <h2>Passkeys</h2>
    <ul class="feed">
      ${creds.map(
        (c) => html`<li>
          <strong>\u{1F511} ${c.credential_id.slice(0, 8)}\u2026</strong>
          <span class="meta">enrolled ${new Date(c.created_at).toISOString().slice(0, 10)}${
            c.credential_id === session.credentialId ? " \u00b7 this session" : ""
          }</span>
          ${
            c.credential_id === session.credentialId || creds.length === 1
              ? html`<button class="btn-danger" disabled title="${creds.length === 1 ? "the last passkey cannot be removed" : "backs this session - sign in with another passkey to remove it"}">Remove</button>`
              : html`<form method="post" action="/settings/passkeys/remove">
            <input type="hidden" name="credential_id" value="${c.credential_id}">
            <input type="hidden" name="csrf" value="${csrf}">
            <button type="submit" class="btn-danger">Remove</button>
          </form>`
          }
        </li>`,
      )}
    </ul>
    <p><button id="pk-add" class="btn-accent" data-csrf="${csrf}">+ Add passkey</button></p>
    <p id="pk-msg" class="meta"></p>
  </section>`;
  const accessSection = html`<section class="widget access" id="mcp-access">
    <h2>MCP access</h2>
    <p class="meta">Connected OAuth clients</p>
    ${grants.length === 0 ? html`<p class="empty">none</p>` : null}
    <ul class="feed">
      ${grants.map(
        (g) => html`<li>
          <strong>${g.client_name ?? g.client_id}</strong>
          <span class="meta">${g.scopes} · granted ${new Date(g.created_at).toISOString().slice(0, 10)}</span>
          <form method="post" action="/settings/grants/revoke">
            <input type="hidden" name="grant_db_id" value="${g.grant_db_id}">
            <input type="hidden" name="csrf" value="${csrf}">
            <button type="submit" class="btn-danger">Revoke</button>
          </form>
        </li>`,
      )}
    </ul>
    <p class="meta">Static tokens</p>
    ${tokens.length === 0 ? html`<p class="empty">none</p>` : null}
    <ul class="feed">
      ${tokens.map(
        (t) => html`<li>
          <strong>${t.label ?? "token"}</strong>
          <span class="meta">${t.scopes} · created ${new Date(t.created_at).toISOString().slice(0, 10)}</span>
          <form method="post" action="/settings/tokens/revoke">
            <input type="hidden" name="token_hash" value="${t.token_hash}">
            <input type="hidden" name="csrf" value="${csrf}">
            <button type="submit" class="btn-danger">Revoke</button>
          </form>
        </li>`,
      )}
    </ul>
  </section>`;
  const heartbeatNames = cfg.widgets
    .filter((w) => w.type === "heartbeat" || w.type === "log")
    .map((w) => w.name);
  const pushSection = html`<section class="widget access" id="push-tokens">
    <h2>Push tokens</h2>
    <p class="meta">Bearer tokens your cron jobs POST to <code>/push/&lt;widget&gt;</code>.
    Hashed at rest; each token reports to one push widget (heartbeat or log).</p>
    ${pushTokens.length === 0 ? html`<p class="empty">none</p>` : null}
    <ul class="feed">
      ${pushTokens.map(
        (t) => html`<li>
          <strong>\u{1FAC0} ${t.widget_name}</strong>
          <span class="meta">created ${new Date(t.created_at).toISOString().slice(0, 10)}</span>
          <form method="post" action="/settings/push-tokens/revoke">
            <input type="hidden" name="token_hash" value="${t.token_hash}">
            <input type="hidden" name="csrf" value="${csrf}">
            <button type="submit" class="btn-danger">Revoke</button>
          </form>
        </li>`,
      )}
    </ul>
    ${
      heartbeatNames.length === 0
        ? html`<p class="meta">Add a heartbeat or log widget first - then create its token here.</p>`
        : html`<form method="post" action="/settings/push-tokens/create" class="form-grid">
      <input type="hidden" name="csrf" value="${csrf}">
      <div class="field field-sm">
        <label for="push-widget">Widget</label>
        <select id="push-widget" name="widget_name">${heartbeatNames.map((n) => html`<option value="${n}">${n}</option>`)}</select>
      </div>
      <div class="form-actions"><button type="submit" class="btn-accent">Create token</button></div>
    </form>`
    }
  </section>`;
  const credentialSection = html`<section class="widget access" id="credentials">
    <h2>API credentials</h2>
    <p class="meta">Encrypted in the database; widgets reference them by name. Each credential
    is pinned to its widget types and one destination origin.</p>
    ${keyStatus === "kv"
      ? html`<p class="meta">\u{1F510} The vault key currently lives in KV (the zero-setup default).
        To move it into a write-only Worker secret, run
        <code>scripts/promote-master-key.sh</code> \u2014 it copies the exact existing key, so
        nothing re-encrypts or breaks.</p>`
      : null}
    ${creds2.length === 0 ? html`<p class="empty">none</p>` : null}
    <ul class="feed">
      ${creds2.map(
        (c) => html`<li>
          <strong>\u{1F510} ${c.name}</strong>
          <span class="meta">${c.widgetTypes.join(", ")} → ${c.origin} · added ${new Date(c.createdAt).toISOString().slice(0, 10)}</span>
          <form method="post" action="/settings/credentials/remove">
            <input type="hidden" name="name" value="${c.name}">
            <input type="hidden" name="csrf" value="${csrf}">
            <button type="submit" class="btn-danger">Remove</button>
          </form>
        </li>`,
      )}
    </ul>
    <form method="post" action="/settings/credentials/add" class="form-grid">
      <input type="hidden" name="csrf" value="${csrf}">
      <div class="field">
        <label for="cred-name">Name</label>
        <input id="cred-name" name="name" placeholder="github-token" required pattern="[a-z0-9][a-z0-9-]{0,31}">
      </div>
      <div class="field">
        <label for="cred-value">Secret value</label>
        <input id="cred-value" name="value" type="password" placeholder="stored encrypted, never shown again" required autocomplete="off">
      </div>
      <div class="field">
        <label for="cred-origin">Allowed origin</label>
        <input id="cred-origin" name="origin" type="url" placeholder="https://api.github.com" required>
        <span class="hint">Scheme and host only - any path you paste is dropped, and the
        credential is refused for every other origin.</span>
      </div>
      <div class="field">
        <span class="field-label">Usable by</span>
        <div class="checks">
          ${CREDENTIAL_TYPES.map(
            (t) => html`<label class="check"><input type="checkbox" name="types" value="${t}"> ${t}</label>`,
          )}
        </div>
      </div>
      <div class="form-actions"><button type="submit" class="btn-accent">Save credential</button></div>
    </form>
  </section>`;

  const connectionSection = html`<section class="widget access" id="mcp-connections">
    <h2>MCP connections</h2>
    <p class="meta">OAuth sign-ins to other MCP servers, for MCP widgets that need
    them. Tokens are stored encrypted and refreshed automatically.</p>
    ${connections.length === 0 ? html`<p class="empty">none</p>` : null}
    <ul class="feed">
      ${connections.map(
        (c) => html`<li>
          <strong>\u{1F517} ${c.name}</strong>
          <span class="meta">${c.origin} · connected ${new Date(c.createdAt).toISOString().slice(0, 10)}</span>
          <form method="post" action="/settings/mcp-connections/remove">
            <input type="hidden" name="name" value="${c.name}">
            <input type="hidden" name="csrf" value="${csrf}">
            <button type="submit" class="btn-danger">Disconnect</button>
          </form>
        </li>`,
      )}
    </ul>
    <form method="post" action="/settings/mcp-connections/connect" class="form-grid">
      <input type="hidden" name="csrf" value="${csrf}">
      <div class="field">
        <label for="conn-name">Name</label>
        <input id="conn-name" name="name" placeholder="my-notes" required pattern="[a-z0-9][a-z0-9-]{0,31}">
      </div>
      <div class="field">
        <label for="conn-url">Server URL</label>
        <input id="conn-url" name="server_url" type="url" placeholder="https://mcp.example.com/mcp" required>
        <span class="hint">The full endpoint, path included - on a multi-tenant host
        <code>/a/mcp</code> and <code>/b/mcp</code> are different servers.</span>
      </div>
      <div class="form-actions"><button type="submit" class="btn-accent">Connect</button></div>
    </form>
  </section>`;
  // The URL is filled in by the client from location.origin rather than
  // rendered here: what this Worker sees is not necessarily what the
  // reader typed (custom domain, tunnel, port-forward), and the address
  // they must paste is the one in their own address bar.
  const browserSection = html`<section class="widget access" id="browser-home">
    <h2>Use as your browser home</h2>
    <p class="meta">This dashboard's address:</p>
    <p class="url-row"><code id="instance-url">…</code>
      <button id="copy-url" class="btn-accent" type="button">Copy</button></p>
    <p class="meta">Homepage and startup pages take a URL directly - no extension:</p>
    <ul class="feed">
      <li><strong>Chrome / Edge / Brave</strong>
        <span class="meta">Settings → On startup → <em>Open a specific page</em> → Add a new page.
        For the home button: Settings → Appearance → Show home button.</span></li>
      <li><strong>Firefox</strong>
        <span class="meta">Settings → Home → Homepage and new windows → <em>Custom URLs</em>.</span></li>
      <li><strong>Safari</strong>
        <span class="meta">Settings → General → Homepage.</span></li>
    </ul>
    <p class="meta">The <strong>new tab</strong> page is different: browsers do not let a
    website claim it, so it takes an extension. This project ships one -
    it stores only your dashboard URL and asks for no other permission.</p>
    <ul class="feed">
      <li><strong>Chrome / Edge / Brave</strong>
        <span class="meta">Open <code>chrome://extensions</code>, turn on Developer mode,
        <em>Load unpacked</em>, and pick the <code>extension/</code> folder. If you
        deployed without cloning,
        <a href="https://github.com/ddyy/mindash/releases/latest/download/mindash-extension-1.0.0.zip" rel="noreferrer">download the packaged extension</a>,
        unzip it, and pick the extracted <code>extension</code> folder. The first
        new tab asks for the URL above.</span></li>
      <li><strong>Firefox</strong>
        <span class="meta"><code>about:debugging</code> → This Firefox → Load Temporary Add-on →
        pick <code>manifest.json</code>. Temporary add-ons unload when Firefox restarts, so for
        daily use pick any "custom new tab" add-on and point it at the URL above.</span></li>
    </ul>
    <p class="meta">The search and bookmarks widgets are built for exactly this.</p>
  </section>`;
  return page(
    html`${notice?.ok ? html`<p class="meta">${notice.ok}</p>` : null}
    ${notice?.error ? html`<p class="error">${notice.error}</p>` : null}
    <nav class="settings-nav" aria-label="Settings sections">
      <a href="#passkeys">Passkeys</a>
      <a href="#credentials">API credentials</a>
      <a href="#mcp-connections">MCP connections</a>
      <a href="#push-tokens">Push tokens</a>
      <a href="#mcp-access">MCP access</a>
      <a href="#diagnostics">Diagnostics</a>
      <a href="#analytics">Analytics</a>
      <a href="#browser-home">Browser home</a>
    </nav>
    ${passkeySection}
    ${credentialSection}
    ${connectionSection}
    ${pushSection}
    ${accessSection}
    <section class="widget access" id="diagnostics">
      <h2>Diagnostics</h2>
      <p><a href="/settings/log">Widget activity log →</a></p>
      <p class="meta">Every refresh attempt, heartbeat outcome, and pushed message.</p>
      <form method="post" action="/settings/log/retention" class="form-grid">
        <input type="hidden" name="csrf" value="${csrf}">
        <div class="field field-xs">
          <label for="retention">Keep history for</label>
          <select id="retention" name="days">
            ${LOG_RETENTION_CHOICES.map(
              (d) => html`<option value="${String(d)}"${d === retention ? new SafeHtml(" selected") : null}>${String(d)} ${d === 1 ? "day" : "days"}</option>`,
            )}
          </select>
        </div>
        <div class="field field-xs">
          <label for="logcap">Per widget, keep at most</label>
          <select id="logcap" name="cap">
            ${LOG_CAP_CHOICES.map(
              (n) => html`<option value="${String(n)}"${n === logCap ? new SafeHtml(" selected") : null}>${
                n === 0 ? "no limit" : `${String(n)} entries`
              }</option>`,
            )}
          </select>
        </div>
        <div class="form-actions"><button type="submit" class="btn-accent">Save</button></div>
      </form>
      <p class="meta">Older entries are pruned by the refresh sweep. Longer windows
      mean more rows: a busy dashboard writes thousands a day. The per-widget
      cap bounds that without starving a rarely-refreshed widget - it keeps
      each widget's newest entries inside the window.</p>
    </section>
    <section class="widget access" id="analytics">
      <h2>Analytics</h2>
      <p class="meta">Cloudflare Web Analytics is turned on for your zone in the Cloudflare
      dashboard, not here. When it is on, Cloudflare injects its beacon into this page
      after the Worker has already returned - so this dashboard's strict script policy
      blocks it, the browser logs a console error, and the analytics record nothing.</p>
      <form method="post" action="/settings/analytics" class="form-grid">
        <input type="hidden" name="csrf" value="${csrf}">
        <div class="checks">
          <label><input type="checkbox" name="cloudflare" value="1"${
            analytics ? new SafeHtml(" checked") : null
          }> Let the Cloudflare Web Analytics beacon run</label>
        </div>
        <div class="form-actions"><button type="submit" class="btn-accent">Save</button></div>
      </form>
      <p class="meta">Turning this on permits two Cloudflare hosts to load and report from
      your dashboard pages. Settings, the editor, and the sign-in pages keep the strict
      policy either way - an outside script has no business on a page that handles
      credentials. Leave it off if you are not using Web Analytics: the beacon stays
      blocked, which is the console error, but nothing is collected regardless.</p>
    </section>
    ${browserSection}`,
    200,
    cfg,
  );
}

// /settings/log: per-attempt widget activity - every pull-widget refresh
// (from refresh_log) merged with heartbeat run outcomes (push_runs),
// newest first. ?fail=1 narrows to failures.
const LOG_PAGE_SIZE = 100;

export async function logPage(env: Env, url: URL): Promise<Response> {
  const failOnly = url.searchParams.get("fail") === "1";
  // One selector, two kinds of value: a widget instance id, or
  // "page:<name>" for every widget on that page. Same param either way,
  // so the cursor and the failures toggle compose with both.
  const rawSelection = url.searchParams.get("widget") ?? "";
  // Keyset cursor: "older" pages ask for entries strictly before the last
  // row shown. Correct while new rows land (page numbers would drift) and
  // it stays one indexed range scan.
  const beforeRaw = Number(url.searchParams.get("before"));
  const before = Number.isSafeInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  const cfg = await getConfig(env);
  const byId = new Map(cfg.widgets.map((w) => [w.id, w]));
  // Which page each widget sits on TODAY - entries logged before a card
  // was moved therefore show its current page, which is what the column
  // header says.
  const pageOf = new Map<string, string>();
  for (const p of cfg.pages) {
    for (const r of p.rows) for (const c of r.columns) for (const w of c.widgets) pageOf.set(w.id, p.name);
  }
  // The selector is a search box backed by a datalist, so what arrives in
  // ?widget= is one of three things: an instance id (every "updated 5m
  // ago" link on a card points at one, and those must keep working), a
  // "page:<name>", or the human label the datalist offered. Anything
  // unrecognised filters to nothing-in-particular rather than to an empty
  // result - a typo should show the whole log, not look like a dead
  // instance.
  const labelOf = (id: string, title: string, type: string) => `${pageOf.get(id) ?? "unplaced"} / ${title} (${type})`;
  // What the DATALIST offers: widget entries lead with a dash so the
  // dropdown reads as a tree under each "All on <page>" row. The page
  // still rides at the end - it is what tells two cards called "Uptime"
  // apart, and it keeps the value unique when titles repeat.
  const optionOf = (id: string, title: string, type: string) => `- ${title} (${type}) · ${pageOf.get(id) ?? "unplaced"}`;
  const canonical = new Map<string, string>();
  // Page rows are just the page name; "all on <page>" stays resolvable
  // for anything that bookmarked the older wording.
  for (const p of cfg.pages) {
    canonical.set(p.name.toLowerCase(), `page:${p.name}`);
    canonical.set(`all on ${p.name.toLowerCase()}`, `page:${p.name}`);
  }
  for (const w of cfg.widgets) {
    // both spellings resolve: the dashed option and the older plain label
    canonical.set(labelOf(w.id, w.title, w.type).toLowerCase(), w.id);
    canonical.set(optionOf(w.id, w.title, w.type).toLowerCase(), w.id);
  }
  const selection =
    byId.has(rawSelection) || rawSelection.startsWith("page:")
      ? rawSelection
      : (canonical.get(rawSelection.trim().toLowerCase()) ?? "");
  const pageName = selection.startsWith("page:") ? selection.slice(5) : "";
  const widgetId = pageName ? "" : selection;
  const pageIds = pageName
    ? cfg.pages
        .filter((p) => p.name === pageName)
        .flatMap((p) => p.rows.flatMap((r) => r.columns.flatMap((c) => c.widgets.map((w) => w.id))))
    : [];

  interface Entry {
    at: number;
    widgetId: string;
    widget: string;
    page: string;
    type: string;
    ok: boolean;
    trigger: string; // cron | manual | push
    durationMs?: number;
    error?: string;
  }
  const entries: Entry[] = [];
  // One extra row per source detects "there is more" after the merge.
  const limit = LOG_PAGE_SIZE + 1;

  // A page selection with no widgets still has to filter to NOTHING
  // rather than falling through to "all" - an emptied page shows an empty
  // log, not the whole instance.
  const idFilter = widgetId ? [widgetId] : pageName ? pageIds : [];
  const idPlaceholders = idFilter.map((_, i) => `?${i + 1}`).join(",");
  const idClause = widgetId
    ? "instance_id = ?1"
    : pageName
      ? idFilter.length > 0
        ? `instance_id IN (${idPlaceholders})`
        : "1 = 0"
      : "";
  const fetchWhere = [
    failOnly ? "ok = 0" : "",
    idClause,
    before ? `at < ?${idFilter.length + 1}` : "",
  ].filter(Boolean);
  const fetchBinds = [...idFilter, ...(before ? [before] : [])];
  const { results: fetches } = await env.DB
    .prepare(
      `SELECT instance_id, at, ok, duration_ms, error, trigger_kind FROM refresh_log
       ${fetchWhere.length ? `WHERE ${fetchWhere.join(" AND ")}` : ""}
       ORDER BY at DESC LIMIT ${limit}`,
    )
    .bind(...fetchBinds)
    .all<{ instance_id: string; at: number; ok: number; duration_ms: number | null; error: string | null; trigger_kind: string }>();
  for (const r of fetches) {
    const w = byId.get(r.instance_id);
    entries.push({
      at: r.at,
      widgetId: r.instance_id,
      widget: w ? w.title : "(removed widget)",
      page: pageOf.get(r.instance_id) ?? "-",
      type: w?.type ?? "?",
      ok: r.ok === 1,
      trigger: r.trigger_kind,
      ...(r.duration_ms !== null ? { durationMs: r.duration_ms } : {}),
      ...(r.error ? { error: r.error } : {}),
    });
  }

  const runWhere = [
    "(completed_at IS NOT NULL OR timed_out_at IS NOT NULL)",
    ...(idClause ? [idClause] : []),
    ...(before ? [`COALESCE(completed_at, timed_out_at) < ?${idFilter.length + 1}`] : []),
  ];
  const { results: runs } = await env.DB
    .prepare(
      `SELECT instance_id, completed_at, timed_out_at, started_at, completion_outcome FROM push_runs
       WHERE ${runWhere.join(" AND ")}
       ORDER BY COALESCE(completed_at, timed_out_at) DESC LIMIT ${limit}`,
    )
    .bind(...fetchBinds)
    .all<{ instance_id: string; completed_at: number | null; timed_out_at: number | null; started_at: number | null; completion_outcome: string | null }>();
  for (const r of runs) {
    const ok = r.completion_outcome === "success" && !r.timed_out_at;
    if (failOnly && ok) continue;
    const w = byId.get(r.instance_id);
    const error = r.timed_out_at
      ? "timed out (missed or overran its window)"
      : r.completion_outcome === "fail"
        ? "job reported failure"
        : undefined;
    entries.push({
      at: r.completed_at ?? r.timed_out_at ?? 0,
      widgetId: r.instance_id,
      widget: w ? w.title : "(removed widget)",
      page: pageOf.get(r.instance_id) ?? "-",
      type: w?.type ?? "heartbeat",
      ok,
      trigger: "push",
      ...(r.completed_at && r.started_at ? { durationMs: r.completed_at - r.started_at } : {}),
      ...(error ? { error } : {}),
    });
  }

  // Pushed log-widget messages are widget updates too, so they share the
  // timeline; only level=error counts as a failure.
  const msgWhere = [
    ...(failOnly ? ["level = 'error'"] : []),
    ...(idClause ? [idClause] : []),
    ...(before ? [`created_at < ?${idFilter.length + 1}`] : []),
  ];
  const { results: messages } = await env.DB
    .prepare(
      `SELECT instance_id, level, text, created_at FROM push_messages
       ${msgWhere.length ? `WHERE ${msgWhere.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT ${limit}`,
    )
    .bind(...fetchBinds)
    .all<{ instance_id: string; level: string; text: string; created_at: number }>();
  for (const r of messages) {
    const w = byId.get(r.instance_id);
    entries.push({
      at: r.created_at,
      widgetId: r.instance_id,
      widget: w ? w.title : "(removed widget)",
      page: pageOf.get(r.instance_id) ?? "-",
      type: w?.type ?? "log",
      ok: r.level !== "error",
      trigger: "push",
      error: r.level === "info" ? r.text : `${r.level}: ${r.text}`,
    });
  }

  entries.sort((a, b) => b.at - a.at);
  const shown = entries.slice(0, LOG_PAGE_SIZE);
  const hasMore = entries.length > LOG_PAGE_SIZE;
  const oldest = shown.length > 0 ? shown[shown.length - 1]!.at : 0;
  const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(5, 19);
  const dur = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
  // Links keep the active filters and only vary the parts they change.
  const href = (over: { fail?: boolean; widget?: string; before?: number }): string => {
    const p = new URLSearchParams();
    const f = over.fail ?? failOnly;
    const wid = over.widget ?? widgetId;
    if (f) p.set("fail", "1");
    if (wid) p.set("widget", wid);
    if (over.before) p.set("before", String(over.before));
    const q = p.toString();
    return q ? `/settings/log?${q}` : "/settings/log";
  };
  const focused = widgetId ? byId.get(widgetId) : undefined;
  // What retention is actually holding right now, so the window can be
  // judged against real volume rather than guessed at. refresh_log is the
  // pruned store; push rows are capped per widget at ingest.
  // Follows the widget filter: numbers sitting above a filtered table
  // must describe that same slice, not the whole store.
  const stats = await env.DB
    .prepare(`SELECT COUNT(*) AS n, MIN(at) AS oldest FROM refresh_log${idClause ? ` WHERE ${idClause}` : ""}`)
    .bind(...idFilter)
    .first<{ n: number; oldest: number | null }>();
  const retentionDays = await logRetentionDays(env);
  const stored = stats?.n ?? 0;
  const spanDays = stats?.oldest ? (Date.now() - stats.oldest) / 86_400_000 : 0;
  // Only widgets that can produce entries - static cards (notes, clocks,
  // bookmarks) never log, so offering them would be a dead choice.
  const loggable = cfg.widgets.filter((w) => isPullWidget(w) || w.type === "heartbeat" || w.type === "log");
  // Titles repeat across pages ("Uptime" on two of them), so the list
  // groups by page: that is the thing that tells two of them apart.
  // Page order, then the order the widgets sit in on the page.
  const loggableIds = new Set(loggable.map((w) => w.id));
  const byPage = cfg.pages.map((p) => ({
    page: p.name,
    widgets: p.rows
      .flatMap((r) => r.columns.flatMap((c) => c.widgets))
      .filter((w) => loggableIds.has(w.id)),
  })).filter((g) => g.widgets.length > 0);

  return page(
    html`<section class="widget access">
      <h2>Widget activity log</h2>
      <form method="get" action="/settings/log" class="log-filter">
        <!-- A search box, not a <select>: an instance with fifty cards
             makes a dropdown a scrolling exercise. datalist gives native
             type-to-filter with no JavaScript, which matters here because
             settings pages ship no script beyond auth.js and the CSP
             forbids an inline one. Options are labelled "<page> / <title>
             (<type>)" so the page - the thing that tells two cards called
             "Uptime" apart - is what you type against. -->
        <input
          name="widget"
          list="log-widget-options"
          class="log-widget-search"
          autocomplete="off"
          placeholder="All widgets - type to search"
          aria-label="Filter by widget"
          value="">
        <datalist id="log-widget-options">
          ${byPage.map(
            (g) => html`<option value="${g.page}"></option>
            ${g.widgets.map((w) => html`<option value="${optionOf(w.id, w.title, w.type)}"></option>`)}`,
          )}
        </datalist>
        <label class="log-failonly"><input type="checkbox" name="fail" value="1"${
          failOnly ? new SafeHtml(" checked") : null
        }> Failures only</label>
        <button type="submit">Filter</button>
      </form>
      <!-- The box always renders EMPTY so picking the next widget never
           means deleting the last label first; the active filter lives
           on this line instead, with the way out beside it. -->
      ${widgetId || pageName
        ? html`<p class="meta log-showing">Showing ${
            pageName
              ? `everything on ${pageName}`
              : focused
                ? labelOf(widgetId, focused.title, focused.type)
                : "(removed widget)"
          } · <a href="${href({ widget: "" })}">all widgets</a></p>`
        : null}
      <p class="meta log-stats">
        ${
          stored === 0
            ? html`no refresh history stored${widgetId ? " for this widget" : pageName ? ` for ${pageName}` : ""} yet`
            : html`${stored.toLocaleString("en-US")} refresh ${stored === 1 ? "entry" : "entries"} stored${
                widgetId ? " for this widget" : pageName ? ` for ${pageName}` : ""
              }, spanning ${spanDays < 1 ? "under a day" : `${spanDays.toFixed(1)} days`}`
        } · kept ${retentionDays} ${retentionDays === 1 ? "day" : "days"}
      </p>

      ${
        shown.length === 0
          ? html`<p class="empty">${before ? "no older entries" : "nothing logged yet - entries appear as the sweep refreshes widgets"}</p>`
          : html`<table class="log-table">
        <thead>
          <tr>
            <th class="log-time">Time (UTC)</th>
            <th class="log-status">Result</th>
            <th class="log-widget">Widget</th>
            <th class="log-page">Page</th>
            <th class="log-trigger">Trigger</th>
            <th class="log-dur">Took</th>
          </tr>
        </thead>
        <tbody>
          ${shown.map(
            (e) => html`<tr class="${e.ok ? "log-ok" : "log-fail"}">
              <td class="log-time">${fmt(e.at)}<span class="log-ago">${relativeTime(e.at)}</span></td>
              <td class="log-status">${e.ok ? "ok" : "FAIL"}</td>
              <td class="log-widget">${
                widgetId ? e.widget : html`<a href="${href({ widget: e.widgetId, before: 0 })}">${e.widget}</a>`
              } <span class="meta">${e.type}</span></td>
              <td class="log-page">${
                e.page === "-" ? html`<span class="meta">-</span>` : html`<a href="${href({ widget: `page:${e.page}`, before: 0 })}">${e.page}</a>`
              }</td>
              <td class="log-trigger">${e.trigger}</td>
              <td class="log-dur">${dur(e.durationMs)}</td>
            </tr>
            <tr class="log-detail-row${e.error ? " has-detail" : ""} ${e.ok ? "log-ok" : "log-fail"}"><td colspan="6">${
              // The message never rides in a column: it is the longest,
              // least predictable field, and a nowrap cell either crushes
              // it or stretches the table. It gets its own nested line
              // under the entry, at every width. Narrow screens ALSO fold
              // trigger and duration here, since those columns are hidden
              // there - hence the two spans rather than one string.
              null
            }<span class="fold-only">${[e.page === "-" ? "" : e.page, e.trigger, dur(e.durationMs)].filter(Boolean).join(" \u00b7 ")}</span>${
              e.error ? html`<span class="detail-msg">${e.error}</span>` : null
            }</td></tr>`,
          )}
        </tbody>
      </table>`
      }
      <p class="log-nav">
        ${before ? html`<a href="${href({ before: 0 })}">← newest</a>` : null}
        ${hasMore && oldest ? html`<a href="${href({ before: oldest })}">older →</a>` : null}
      </p>
    </section>`,
    200,
    cfg,
    false, // read-only view: no logout button here
  );
}

// Vault CRUD. Session + CSRF; values go straight into the vault and are
// never echoed back. Re-saving an existing name rotates its value.
export async function addCredentialAction(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  const name = String(form.get("name") ?? "");
  const rawOrigin = String(form.get("origin") ?? "");
  const err = await putCredential(env, {
    name,
    value: String(form.get("value") ?? ""),
    origin: rawOrigin,
    widgetTypes: form.getAll("types").map(String),
  });
  if (err) return settingsPage(env, session, { error: err });
  // Report the stored origin: pasting a full URL here narrows it, and
  // silently keeping something narrower than the owner typed is how a
  // credential ends up "mysteriously" refused at fetch time.
  const stored = normalizeOrigin(rawOrigin);
  return settingsPage(env, session, { ok: `credential saved, scoped to ${stored ?? rawOrigin}` });
}

export async function removeCredentialAction(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  await deleteCredential(env, String(form.get("name") ?? ""));
  return settingsPage(env, session, { ok: "credential removed" });
}

// Push-token CRUD: the value exists exactly once, in the success notice.
export async function createPushTokenAction(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  const widgetName = String(form.get("widget_name") ?? "");
  const widget = (await getConfig(env)).widgets.find((w) => w.name === widgetName);
  if (!widget || (widget.type !== "heartbeat" && widget.type !== "log")) {
    return settingsPage(env, session, { error: "unknown push widget" });
  }
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await env.DB
    .prepare("INSERT INTO push_tokens (token_hash, widget_name, created_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256Hex(token), widgetName, Date.now())
    .run();
  return settingsPage(env, session, {
    ok: `push token for ${widgetName} (copy it now - it will not be shown again): ${token}`,
  });
}

export async function revokePushTokenAction(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  await env.DB
    .prepare("UPDATE push_tokens SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL")
    .bind(Date.now(), String(form.get("token_hash") ?? ""))
    .run();
  return settingsPage(env, session, { ok: "push token revoked" });
}

// MCP connection flow: discovery + DCR happen here, then a 303 sends the
// owner's browser to the upstream authorization page. The callback route
// (GET /oauth/callback, session-gated) completes the exchange.
export async function connectMcpAction(req: Request, env: Env, session: SessionInfo, url: URL): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  try {
    const authzUrl = await startConnect(
      env,
      String(form.get("name") ?? ""),
      String(form.get("server_url") ?? ""),
      url.origin,
    );
    return Response.redirect(authzUrl, 303);
  } catch (e) {
    return settingsPage(env, session, { error: String(e instanceof Error ? e.message : e) });
  }
}

export async function removeMcpConnectionAction(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  await deleteConnection(env, String(form.get("name") ?? ""));
  return settingsPage(env, session, { ok: "connection removed" });
}

export async function removePasskeyAction(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  const { passkeyRemove } = await import("./auth/webauthn");
  const res = await passkeyRemove(env, session, String(form.get("credential_id") ?? ""));
  return settingsPage(env, session, res);
}

// Grant revocation: the D1 row is the enforcement boundary (checked on
// every /mcp request); cleaning up the provider's KV grant is best-effort.
export async function revokeGrantAction(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  const grantDbId = String(form.get("grant_db_id") ?? "");
  await env.DB
    .prepare("UPDATE oauth_grants SET revoked_at = ?1 WHERE grant_db_id = ?2 AND revoked_at IS NULL")
    .bind(Date.now(), grantDbId)
    .run();
  try {
    const { items } = await env.OAUTH_PROVIDER.listUserGrants("owner");
    for (const g of items) {
      if ((g.metadata as { grantDbId?: string } | undefined)?.grantDbId === grantDbId) {
        await env.OAUTH_PROVIDER.revokeGrant(g.id, "owner");
      }
    }
  } catch (e) {
    console.log(JSON.stringify({ evt: "grant_kv_cleanup_failed", error: String(e) }));
  }
  return settingsPage(env, session, { ok: "grant revoked" });
}

export async function revokeTokenAction(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return settingsPage(env, session, { error: "stale form (CSRF token mismatch)" });
  }
  await env.DB
    .prepare("UPDATE mcp_tokens SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL")
    .bind(Date.now(), String(form.get("token_hash") ?? ""))
    .run();
  return settingsPage(env, session, { ok: "token revoked" });
}

// Same instance-preference rule as retention below: owner-only, never
// exported, never writable over MCP. Deliberately NOT in the config
// document - a config-scoped MCP token must not be able to widen the
// dashboard's script policy.
export async function setAnalyticsAction(req: Request, env: Env, session: SessionInfo, url: URL): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return new Response("stale form (CSRF token mismatch)", { status: 403 });
  }
  // An unchecked box submits nothing, which is how it turns OFF.
  await setCloudflareAnalytics(env, form.get("cloudflare") !== null);
  return Response.redirect(`${url.origin}/settings#analytics`, 303);
}

// Retention is an instance preference, not part of the dashboard
// document: owner-only, never exported or writable over MCP.
export async function setRetentionAction(req: Request, env: Env, session: SessionInfo, url: URL): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return new Response("stale form (CSRF token mismatch)", { status: 403 });
  }
  await setLogRetentionDays(env, Number(form.get("days")));
  await setLogMaxPerWidget(env, Number(form.get("cap")));
  return Response.redirect(`${url.origin}/settings#diagnostics`, 303);
}
