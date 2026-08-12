
"use strict";
function b2a(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function a2b(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
function msg(text, isError) {
  const el = document.getElementById("msg");
  el.textContent = text;
  el.className = isError ? "error" : "meta";
}

// Sign-in failures used to surface as one raw string, and the two that
// matter read as nonsense: the browser reports a wrong-DOMAIN passkey
// exactly as it reports a cancelled prompt (NotAllowedError covers
// cancel, timeout, and no-matching-credential alike), and the server's
// "unknown credential" says nothing about what to do. Map both to the
// next action. Recovery is deliberately not self-service - a locked-out
// owner needs a terminal - so the copy names the command rather than
// implying a button exists.
const ENROLL_STEPS =
  'Mint a one-time token from a terminal - ./scripts/seed-token.sh enroll --remote - then use "Enroll a passkey" below.';

function loginFailure(e) {
  const raw = String((e && e.message) || e);
  // Not an accusation: the reader may simply have pressed Escape.
  if (e && e.name === "NotAllowedError") {
    return {
      text:
        "No passkey was used. If you cancelled or the prompt timed out, try again. " +
        "If this dashboard recently moved to a new domain, your old passkey is bound to the old " +
        "domain and cannot sign you in here.",
      steps: ENROLL_STEPS,
      raw,
    };
  }
  if (/unknown credential/i.test(raw)) {
    return {
      text:
        "That passkey is not enrolled on this dashboard - it belongs to another instance, was " +
        "removed in Settings, or was invalidated by an account recovery.",
      steps: ENROLL_STEPS,
      raw,
    };
  }
  if (/no credentials enrolled/i.test(raw)) {
    return {
      text: "This dashboard has no passkeys left, so there is nothing to sign in with.",
      steps: "Recover it from a terminal: ./scripts/seed-token.sh recover --remote",
      raw,
    };
  }
  return { text: raw };
}

// Guidance first, raw error kept underneath so a real bug is still
// diagnosable instead of hidden behind friendly copy.
function showLoginFailure(e) {
  const f = loginFailure(e);
  const el = document.getElementById("msg");
  el.textContent = "";
  el.className = "";
  const line = document.createElement("p");
  line.className = "error";
  line.textContent = f.text;
  el.appendChild(line);
  if (f.steps) {
    const steps = document.createElement("p");
    steps.className = "meta";
    steps.textContent = f.steps;
    el.appendChild(steps);
    const enroll = document.getElementById("enroll");
    if (enroll) enroll.open = true; // put the way out in front of them
  }
  if (f.raw && f.raw !== f.text) {
    const raw = document.createElement("p");
    raw.className = "meta msg-raw";
    raw.textContent = f.raw;
    el.appendChild(raw);
  }
}

async function login() {
  msg("requesting challenge…");
  const { challengeId, options } = await post("/auth/login/options", {});
  const publicKey = {
    challenge: a2b(options.challenge),
    rpId: options.rpId,
    timeout: options.timeout,
    userVerification: options.userVerification,
    allowCredentials: (options.allowCredentials || []).map((c) => ({
      type: "public-key", id: a2b(c.id), transports: c.transports,
    })),
  };
  msg("touch your passkey…");
  const cred = await navigator.credentials.get({ publicKey });
  const payload = {
    id: cred.id,
    rawId: b2a(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b2a(cred.response.clientDataJSON),
      authenticatorData: b2a(cred.response.authenticatorData),
      signature: b2a(cred.response.signature),
      userHandle: cred.response.userHandle ? b2a(cred.response.userHandle) : null,
    },
  };
  await post("/auth/login/verify", { challengeId, credential: payload });
  msg("logged in - redirecting…");
  const next = new URLSearchParams(location.search).get("next");
  location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

async function stepupThenSubmit(form) {
  const pendingId = form.dataset.pending;
  msg("requesting step-up challenge…");
  const { options } = await post("/auth/stepup/options", { pending_id: pendingId });
  const publicKey = {
    challenge: a2b(options.challenge),
    rpId: options.rpId,
    timeout: options.timeout,
    userVerification: options.userVerification,
    allowCredentials: (options.allowCredentials || []).map((c) => ({
      type: "public-key", id: a2b(c.id), transports: c.transports,
    })),
  };
  msg("confirm with your passkey…");
  const cred = await navigator.credentials.get({ publicKey });
  const payload = {
    id: cred.id,
    rawId: b2a(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b2a(cred.response.clientDataJSON),
      authenticatorData: b2a(cred.response.authenticatorData),
      signature: b2a(cred.response.signature),
      userHandle: cred.response.userHandle ? b2a(cred.response.userHandle) : null,
    },
  };
  await post("/auth/stepup/verify", { pending_id: pendingId, credential: payload });
  msg("approved - completing…");
  HTMLFormElement.prototype.submit.call(form);
}

async function register() {
  const tokenEl = document.getElementById("token");
  const token = tokenEl ? tokenEl.value.trim() : "";
  if (tokenEl && !token) { msg("enrollment token required", true); return; }
  msg("requesting challenge…");
  const { challengeId, options } = await post("/auth/register/options", { token });
  const publicKey = {
    challenge: a2b(options.challenge),
    rp: options.rp,
    user: {
      id: a2b(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName || options.user.name,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    attestation: options.attestation,
    authenticatorSelection: options.authenticatorSelection,
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({
      type: "public-key", id: a2b(c.id), transports: c.transports,
    })),
  };
  msg("touch your passkey…");
  const cred = await navigator.credentials.create({ publicKey });
  const payload = {
    id: cred.id,
    rawId: b2a(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b2a(cred.response.clientDataJSON),
      attestationObject: b2a(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
  };
  const out = await post("/auth/register/verify", { challengeId, credential: payload });
  msg(out.recovered ? "account recovered - log in with the new passkey" : "passkey enrolled - you can log in");
  // First-passkey claim: the setup-mode page has no sign-in button, and
  // the instance is no longer in setup mode now, so reload to reveal it.
  if (!document.getElementById("login-btn")) setTimeout(function () { location.reload(); }, 800);
}

async function logout() {
  await post("/auth/logout", {});
  msg("logged out");
  location.reload();
}

async function addPasskey() {
  const btn = document.getElementById("pk-add");
  const out = document.getElementById("pk-msg");
  const say = (t, err) => { out.textContent = t; out.className = err ? "error" : "meta"; };
  const csrf = btn.dataset.csrf;
  say("requesting challenge…");
  const { challengeId, options } = await post("/settings/passkeys/add/options", { csrf });
  const publicKey = {
    challenge: a2b(options.challenge),
    rp: options.rp,
    user: {
      id: a2b(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName || options.user.name,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    attestation: options.attestation,
    authenticatorSelection: options.authenticatorSelection,
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({
      type: "public-key", id: a2b(c.id), transports: c.transports,
    })),
  };
  say("touch your passkey…");
  const cred = await navigator.credentials.create({ publicKey });
  const payload = {
    id: cred.id,
    rawId: b2a(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: b2a(cred.response.clientDataJSON),
      attestationObject: b2a(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
  };
  await post("/settings/passkeys/add/verify", { csrf, challengeId, credential: payload });
  say("passkey added - reloading…");
  location.reload();
}
// Settings → Use as your browser home. The address to paste is the one in
// THIS browser's bar - a custom domain, tunnel, or forwarded port is not
// what the Worker sees - so the client fills it rather than the server.
const instanceUrl = document.getElementById("instance-url");
if (instanceUrl) {
  instanceUrl.textContent = location.origin;
  const copyBtn = document.getElementById("copy-url");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const done = (t) => {
        copyBtn.textContent = t;
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      };
      try {
        await navigator.clipboard.writeText(location.origin);
        done("Copied");
      } catch {
        // no clipboard permission (or an insecure context): select it so
        // the reader can copy by hand instead of getting nothing
        const range = document.createRange();
        range.selectNodeContents(instanceUrl);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        done("Select + copy");
      }
    });
  }
}

const pkAddBtn = document.getElementById("pk-add");
if (pkAddBtn) {
  pkAddBtn.addEventListener("click", () =>
    addPasskey().catch((e) => {
      const out = document.getElementById("pk-msg");
      out.textContent = String(e.message || e);
      out.className = "error";
    }),
  );
}

document.getElementById("login-btn")?.addEventListener("click", () => login().catch(showLoginFailure));
document.getElementById("register-btn")?.addEventListener("click", () => register().catch((e) => msg(String(e.message || e), true)));
document.getElementById("logout-btn")?.addEventListener("click", () => logout().catch((e) => msg(String(e.message || e), true)));
const approveForm = document.getElementById("approve-form");
if (approveForm && approveForm.dataset.stepup === "1") {
  approveForm.addEventListener("submit", (e) => {
    e.preventDefault();
    stepupThenSubmit(approveForm).catch((err) => msg(String(err.message || err), true));
  });
}

// /settings/log: every filter control submits on change - the widget
// picker and the failures-only checkbox alike. Binding the select alone
// left the checkbox dead, since the Filter button is hidden below. The
// button stays in the markup so the form still works without JS.
const logFilter = document.querySelector("form.log-filter");
if (logFilter) {
  const go = logFilter.querySelector("button[type=submit]");
  if (go) go.hidden = true;
  logFilter.querySelectorAll("select, input[type=checkbox]").forEach((ctl) => {
    ctl.addEventListener("change", () => logFilter.submit());
  });
}
