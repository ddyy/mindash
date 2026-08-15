// New tab: paint the last-seen dashboard instantly, then navigate to the
// live one; first run shows the one-field setup instead.
"use strict";

// WHO initiates the navigation decides where the cursor ends up. A
// renderer-initiated one (location.replace) moves focus into the page, so
// the address bar loses the caret Chrome gave it when the tab opened and
// you cannot just start typing. Asking the BROWSER to navigate the tab
// leaves that focus alone. Same destination, same lack of a history entry
// - only the initiator differs.
//
// tabs.update on the extension's own tab needs no "tabs" permission; that
// permission only gates reading url/title/favIconUrl off other tabs. The
// fallback covers runtimes without chrome.tabs (Firefox temporary
// add-ons) and the case where this page somehow isn't in a tab.
function go(target) {
  try {
    if (!chrome.tabs?.getCurrent) return void location.replace(target);
    chrome.tabs.getCurrent((tab) => {
      if (chrome.runtime.lastError || !tab) return void location.replace(target);
      chrome.tabs.update(tab.id, { url: target }, () => {
        if (chrome.runtime.lastError) location.replace(target);
      });
    });
  } catch {
    location.replace(target);
  }
}

function validUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.href;
    // http is allowed for localhost-style dev instances only
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1")) {
      return u.href;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// The storage read is an IPC round-trip, so its callback can land either
// side of DOMContentLoaded. Registering a DOMContentLoaded listener from
// inside it is a race that loses whenever the read is slower than parsing
// this (tiny) document - the listener is added after the event, never
// fires, and the first run shows a BLANK new tab with no way to set a URL.
function whenReady(fn) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else fn();
}

// ---- snapshot-first paint ----
//
// An authed dashboard is served no-store (deliberately: a shared machine
// must not be able to pull it out of cache after logout), so every new
// tab used to pay a full network round trip while showing blank. The
// extension keeps its own copy instead: paint the last-seen HTML at 0ms,
// fetch a fresh one, then hand the tab to the live page. Stale-for-a-
// moment is the product's own contract - cards show last-good data by
// design - and chrome.storage.local stays inside this browser profile,
// which is exactly where the authed page itself would have been cached.
//
// The fetch is why the extension asks (once, at setup, optionally) for a
// host permission on the dashboard's own origin: reading a cross-origin
// response with cookies is impossible without it. Denied is fine - the
// tab just navigates like it always did.

const SNAPSHOT_MAX = 300_000; // bytes of HTML worth keeping
const FETCH_BUDGET_MS = 2_500;

function paintSnapshot(html, target) {
  // Sandboxed srcdoc: the stored markup renders as pure visual - no
  // scripts run in it, and it gets an opaque origin. Links still work
  // (top-navigation on a real click), which doubles as the offline path.
  // A <base> makes the page's relative asset URLs resolve to the real
  // instance; stylesheets there are public assets.
  const frame = document.createElement("iframe");
  frame.id = "snap";
  frame.setAttribute("sandbox", "allow-top-navigation-by-user-activation allow-popups");
  frame.srcdoc = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${target}">`);
  whenReady(() => document.body.appendChild(frame));
}

async function captureFresh(target) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_BUDGET_MS);
  try {
    const resp = await fetch(target, { credentials: "include", signal: ctl.signal });
    // Signed out (or the session died): the snapshot would show a page
    // this browser can no longer load - drop it and let the login page
    // through untainted.
    const landed = new URL(resp.url);
    if (resp.status === 401 || landed.pathname === "/login") {
      chrome.storage.local.remove("snapshot");
      return;
    }
    if (!resp.ok) return;
    const html = await resp.text();
    if (html.length > 0 && html.length <= SNAPSHOT_MAX) {
      chrome.storage.local.set({ snapshot: { url: target, html, at: Date.now() } });
    }
  } finally {
    clearTimeout(timer);
  }
}

function openDashboard(target) {
  chrome.storage.local.get("snapshot", ({ snapshot }) => {
    const painted = Boolean(snapshot && snapshot.url === target && typeof snapshot.html === "string");
    if (painted) paintSnapshot(snapshot.html, target);
    captureFresh(target)
      .then(() => go(target))
      .catch(() => {
        // Offline (or no host permission). With a snapshot on screen,
        // staying on it beats swapping in a browser error page - its
        // links still navigate when the network returns. Without one
        // there is nothing to stay for.
        if (!painted) go(target);
      });
  });
}

chrome.storage.sync.get("url", ({ url }) => {
  const target = url && validUrl(url);
  if (target) {
    openDashboard(target);
    return;
  }
  whenReady(() => {
    const setup = document.getElementById("setup");
    setup.hidden = false;
    document.getElementById("f").addEventListener("submit", (e) => {
      e.preventDefault();
      const raw = document.getElementById("url").value.trim();
      const ok = validUrl(raw);
      if (!ok) {
        document.getElementById("err").textContent = "Enter an https:// URL (or http://localhost for dev).";
        return;
      }
      // Ask for the dashboard's own origin while we still have the user
      // gesture the permission prompt requires. Denied just means every
      // new tab navigates without the instant-paint snapshot.
      const grant = chrome.permissions?.request
        ? new Promise((resolve) => {
            try {
              chrome.permissions.request({ origins: [new URL(ok).origin + "/*"] }, (granted) => {
                void chrome.runtime.lastError; // consumed; denial is fine
                resolve(Boolean(granted));
              });
            } catch {
              resolve(false);
            }
          })
        : Promise.resolve(false);
      // Focus is already in the page here (the user just typed and
      // submitted), so this one is only about staying consistent.
      grant.then(() => chrome.storage.sync.set({ url: ok }, () => go(ok)));
    });
  });
});
