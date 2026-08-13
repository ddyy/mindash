import { getCurrentConfig, BUILTIN_THEMES } from "../config";
import { av } from "../assetversion";
import { html, SafeHtml } from "../html";
import { themeCssVars } from "../render";
import { globalHeader } from "../header";
import { csrfToken } from "../settings";
import { WIDGET_FORMS } from "../widgetforms";
import { listCredentials } from "../vault";
import { listConnections } from "../mcpclient";
import type { SessionInfo } from "../auth/session";

// The hybrid editor shell (plan: "Settings editor"). This is the one
// heavily-scripted page; initial state is embedded as JSON (CSP-safe), and
// all mutation goes through the editor API → publishConfig.

export async function editorPage(env: Env, session: SessionInfo): Promise<Response> {
  const { version, doc, runtime } = await getCurrentConfig(env);
  // Vault credential names filtered per widget type (the values never
  // leave the vault; the editor only ever sees names).
  const creds = await listCredentials(env);
  const state = {
    version,
    doc,
    csrf: await csrfToken(session),
    forms: WIDGET_FORMS,
    secretOptions: Object.fromEntries(
      WIDGET_FORMS.map((f) => [f.type, creds.filter((c) => c.widgetTypes.includes(f.type)).map((c) => c.name)]),
    ),
    connectionOptions: (await listConnections(env)).map((c) => c.name),
    theme: runtime.theme,
    builtinThemes: BUILTIN_THEMES,
  };
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mindash - editor</title>
<link rel="stylesheet" href="${av("/styles.css")}">
<link rel="stylesheet" href="${av("/editor.css")}">
<style>:root { ${new SafeHtml(themeCssVars(runtime.theme))} }</style>
</head>
<body class="editor-body">
${globalHeader("edit", { title: runtime.theme.title, logo: runtime.theme.logo })}
<div class="editor-top">
  <nav id="page-tabs" aria-label="Pages"></nav>
  <div class="editor-actions">
    <span id="dirty" class="meta" aria-live="polite"></span>
    <button id="undo-btn" title="Undo (Ctrl+Z)" disabled>↶ Undo</button>
    <button id="theme-btn" title="Dashboard appearance (Esc)">Theme</button>
    <button id="history-btn">History</button>
    <button id="yaml-btn" aria-pressed="false">YAML</button>
    <button id="save-btn" class="primary" disabled>✓ Save</button>
  </div>
</div>
<div class="editor-grid">
  <aside id="outline" aria-label="Outline"></aside>
  <section id="center">
    <div id="preview" aria-label="Live preview"></div>
    <div id="yaml-pane" hidden>
      <textarea id="yaml-text" spellcheck="false" aria-label="YAML source"></textarea>
      <p id="yaml-msg" class="meta"></p>
      <p><button id="yaml-apply">Apply YAML to draft</button></p>
    </div>
  </section>
  <aside id="inspector" aria-label="Inspector"></aside>
</div>
<dialog id="save-dialog">
  <h2>Review changes</h2>
  <ul id="save-summary" class="feed"></ul>
  <p id="save-sensitive" class="error" hidden></p>
  <p id="save-cache" class="meta" hidden></p>
  <form method="dialog" class="dialog-actions">
    <button value="cancel">Keep editing</button>
    <button value="confirm" class="primary" id="save-confirm">Publish</button>
  </form>
</dialog>
<dialog id="conflict-dialog">
  <h2>Dashboard changed while you were editing</h2>
  <p class="meta">Review the incoming changes before saving:</p>
  <ul id="conflict-incoming" class="feed"></ul>
  <p class="error">"Apply my changes" publishes YOUR draft over these.</p>
  <form method="dialog" class="dialog-actions">
    <button value="reload">Reload (discard my draft)</button>
    <button value="force" class="primary">Apply my changes to latest</button>
  </form>
</dialog>
<dialog id="history-dialog">
  <h2>Version history</h2>
  <div id="history-list"></div>
  <form method="dialog" class="dialog-actions"><button value="cancel">Close</button></form>
</dialog>
<dialog id="gallery-dialog">
  <h2>Add widget</h2>
  <input id="gallery-search" type="search" placeholder="Search widgets…" aria-label="Search widgets">
  <div id="gallery-list"></div>
  <form method="dialog" class="dialog-actions"><button value="cancel">Close</button></form>
</dialog>
<script type="application/json" id="editor-state">${new SafeHtml(
    JSON.stringify(state).replace(/</g, "\\u003c"),
  )}</script>
<script src="${av("/editor.js")}"></script>
</body>
</html>`;
  return new Response(page.value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // frame-src is open (any http(s) origin) on the EDITOR only: the
      // preview must render draft iframes whose origins aren't in the
      // active config yet. Frames stay sandboxed; the dashboard's CSP
      // still pins frame-src to the published config's origins.
      "content-security-policy":
        `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; frame-src https: http:; img-src 'self' https:`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
