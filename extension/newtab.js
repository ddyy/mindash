// New tab: redirect to the stored dashboard URL; first run shows the
// one-field setup instead. location.replace keeps this page out of tab
// history, and the omnibox keeps focus so typing still searches.
"use strict";

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
    location.replace(target);
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
      chrome.storage.sync.set({ url: ok }, () => location.replace(ok));
    });
  });
});
