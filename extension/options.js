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

// Same race as the new tab page had: this script is deferred, so the DOM
// is ready before it runs, but the storage read is still asynchronous -
// anything that depends on the stored value has to happen in the callback.
function say(text, isError) {
  msg.textContent = text;
  msg.className = isError ? "err" : "";
  if (!isError && text) setTimeout(() => { msg.textContent = ""; }, 1800);
}

chrome.storage.sync.get("url", ({ url }) => {
  if (url) input.value = url;
});

document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  const ok = validUrl(input.value.trim());
  if (!ok) {
    say("Enter an https:// URL (or http://localhost for dev).", true);
    return;
  }
  // Re-request the origin permission on save: a CHANGED url means a
  // changed origin, and the old grant does not cover it. Denial is fine -
  // new tabs then navigate without the instant-paint snapshot.
  const finish = () =>
    chrome.storage.sync.set({ url: ok }, () => {
      chrome.storage.local.remove("snapshot"); // never paint one origin's page for another
      input.value = ok; // show the normalized form that was actually stored
      say("Saved.");
    });
  if (chrome.permissions?.request) {
    try {
      chrome.permissions.request({ origins: [new URL(ok).origin + "/*"] }, () => {
        void chrome.runtime.lastError;
        finish();
      });
    } catch {
      finish();
    }
  } else {
    finish();
  }
});

// The way back to a clean slate. Without this the only route was removing
// and re-adding the extension: the field is `required`, so an empty save
// is refused rather than treated as "unset".
document.getElementById("clear").addEventListener("click", () => {
  chrome.storage.sync.remove("url", () => {
    chrome.storage.local.remove("snapshot");
    input.value = "";
    say("Cleared - the next new tab will ask for a URL.");
  });
});
