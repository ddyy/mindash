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

chrome.storage.sync.get("url", ({ url }) => {
  const target = url && validUrl(url);
  if (target) {
    location.replace(target);
    return;
  }
  document.addEventListener("DOMContentLoaded", () => {
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
