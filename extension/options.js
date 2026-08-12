"use strict";

function validUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.href;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname.endsWith(".localhost") || u.hostname === "127.0.0.1")) {
      return u.href;
    }
  } catch {
    /* fall through */
  }
  return null;
}

const input = document.getElementById("url");
const msg = document.getElementById("msg");
chrome.storage.sync.get("url", ({ url }) => {
  if (url) input.value = url;
});
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const ok = validUrl(input.value.trim());
  if (!ok) {
    msg.textContent = "Enter an https:// URL (or http://localhost for dev).";
    return;
  }
  chrome.storage.sync.set({ url: ok }, () => {
    msg.textContent = "Saved.";
    setTimeout(() => { msg.textContent = ""; }, 1500);
  });
});
