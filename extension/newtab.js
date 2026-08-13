// New tab: redirect to the stored dashboard URL; first run shows the
// one-field setup instead.
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

chrome.storage.sync.get("url", ({ url }) => {
  const target = url && validUrl(url);
  if (target) {
    go(target);
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
      // Focus is already in the page here (the user just typed and
      // submitted), so this one is only about staying consistent.
      chrome.storage.sync.set({ url: ok }, () => go(ok));
    });
  });
});
