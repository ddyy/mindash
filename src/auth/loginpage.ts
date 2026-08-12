import { html } from "../html";
import { av } from "../assetversion";

// A passkey is bound to the origin that created it (the WebAuthn RP ID),
// so claiming on the deploy-time *.workers.dev URL and attaching a custom
// domain afterwards means enrolling again on the new domain. Say so while
// the choice is still free - and name the token lane, so this reads as a
// "do this in the better order", not a warning about a trap.
function claimNote(hostname: string): ReturnType<typeof html> | null {
  if (!hostname) return null;
  if (/(^|\.)workers\.dev$/i.test(hostname)) {
    return html`<p class="claim-note">Passkeys bind to the domain that creates them, and this is a
      <strong>workers.dev</strong> address. If you want a custom domain, attach it to this Worker and
      claim there instead - a passkey made here will not work on it, and you would enroll again with a
      one-time token.</p>`;
  }
  return html`<p class="claim-note">This passkey binds to <strong>${hostname}</strong> and will not work
    on another domain.</p>`;
}

export function loginPage(authed: boolean, setup = false, hostname = ""): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mindash - sign in</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${av("/styles.css")}">
</head>
<body>
<header><h1><a class="brand" href="/">mindash</a></h1></header>
<main class="center-prompt">
  <section class="widget">
    <h2>${authed ? "Signed in" : setup ? "Welcome to mindash" : "Passkey"}</h2>
    ${
      // Sign-in messages sit directly under the button that produced
      // them and ABOVE the enrollment disclosure, so a failure that opens
      // that disclosure never shoves its own explanation down the page.
      authed
        ? html`<p class="meta">You have an active session.</p>
          <p><a href="/">Open dashboard</a></p>
          <p><button id="logout-btn">Log out</button></p>
          <div id="msg" class="meta"></div>`
        : setup
          ? html`<p class="meta">Fresh instance - no owner yet. Create the first passkey to claim it; every later enrollment needs a one-time token.</p>
          ${claimNote(hostname)}
          <p><button id="register-btn" class="primary">Create the first passkey</button></p>
          <div id="msg" class="meta"></div>`
          : html`<p><button id="login-btn">Sign in with passkey</button></p>
          <div id="msg" class="meta"></div>
          <details id="enroll">
            <summary class="disclosure">Enroll a passkey (needs a one-time token)</summary>
            <p><input id="token" type="password" placeholder="enrollment token" aria-label="Enrollment token" autocomplete="off"></p>
            <p><button id="register-btn">Enroll passkey</button></p>
          </details>`
    }
  </section>
</main>
<script src="${av("/auth.js")}"></script>
</body>
</html>`;
  return new Response(doc.value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
