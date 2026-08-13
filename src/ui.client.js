
"use strict";
(function () {
  var fs = document.querySelector(".fs-btn");
  if (fs) {
    fs.addEventListener("click", function (e) {
      e.preventDefault();
      if (document.fullscreenElement) {
        document.exitFullscreen();
        return;
      }
      document.documentElement.requestFullscreen().catch(function () {
        // fullscreen unavailable: fall back to the header-less kiosk URL
        location.href = fs.getAttribute("href");
      });
    });
  }
  // Both fullscreen flavors hide the chrome: the Fullscreen API (the ⛶
  // button) fires fullscreenchange; browser fullscreen (F11) only flips
  // the display-mode media query.
  var fsQuery = matchMedia("(display-mode: fullscreen)");
  function inFullscreen() {
    return !!document.fullscreenElement || fsQuery.matches;
  }
  function syncKiosk() {
    document.body.classList.toggle("kiosk", inFullscreen());
  }
  document.addEventListener("fullscreenchange", syncKiosk);
  if (fsQuery.addEventListener) fsQuery.addEventListener("change", syncKiosk);
  syncKiosk();

  // Per-page collapsed navigation: reveal as an overlay so the dashboard
  // never reflows. The state is intentionally tab-local and resets on a
  // fresh new tab; Escape and outside clicks close it again.
  var navReveal = document.querySelector(".nav-reveal");
  function setNavOpen(open) {
    if (!navReveal) return;
    document.body.classList.toggle("nav-open", open);
    navReveal.setAttribute("aria-expanded", String(open));
    navReveal.setAttribute("aria-label", open ? "Hide navigation" : "Show navigation");
    navReveal.setAttribute("title", open ? "Hide navigation" : "Show navigation");
  }
  if (navReveal) {
    navReveal.addEventListener("click", function (e) {
      e.stopPropagation();
      setNavOpen(!document.body.classList.contains("nav-open"));
    });
    document.addEventListener("click", function (e) {
      if (!document.body.classList.contains("nav-open")) return;
      if (e.target && e.target.closest && e.target.closest(".dashboard-chrome")) return;
      setNavOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setNavOpen(false);
    });
  }

  function loadInto(url) {
    return fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (htmlText) {
        if (!htmlText) return false;
        var doc = new DOMParser().parseFromString(htmlText, "text/html");
        var next = doc.querySelector("main");
        var cur = document.querySelector("main");
        if (next && cur) cur.replaceWith(next);
        var nextNav = doc.querySelector("nav.pages");
        var curNav = document.querySelector("nav.pages");
        if (nextNav && curNav) curNav.replaceWith(nextNav);
        return true;
      })
      .catch(function () { return false; });
  }
  // Auto-refresh, visibility-aware. An unconditional 5-minute interval
  // kept redrawing hidden tabs - 288 Worker invocations and D1 reads a
  // day per abandoned tab, for a page nobody is looking at, on an app
  // whose whole pitch is "leave me open as your new tab page". The
  // decision itself lives in autorefresh.client.js; this is the wiring.
  var lastAutoRefreshAttempt = Date.now();
  var autoRefreshTimer = null;
  var autoRefreshInFlight = false;

  function clearAutoRefreshTimer() {
    if (autoRefreshTimer !== null) {
      clearTimeout(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  function scheduleAutoRefresh() {
    var d = decideAutoRefresh({
      now: Date.now(),
      lastAttempt: lastAutoRefreshAttempt,
      hidden: document.hidden === true,
      inFlight: autoRefreshInFlight,
    });
    if (d.action === "none") return;
    clearAutoRefreshTimer();
    if (d.action === "cancel") return;
    if (d.action === "run") {
      runAutoRefresh();
      return;
    }
    autoRefreshTimer = setTimeout(runAutoRefresh, d.delay);
  }

  function runAutoRefresh() {
    autoRefreshTimer = null;
    if (document.hidden === true || autoRefreshInFlight) {
      scheduleAutoRefresh();
      return;
    }
    // Stamp the ATTEMPT, before the request rather than after it: a
    // failing endpoint must not leave every later visibility change
    // looking overdue and firing another immediate retry.
    lastAutoRefreshAttempt = Date.now();
    autoRefreshInFlight = true;
    // loadInto resolves false rather than rejecting, so this always runs.
    loadInto(location.href).then(function () {
      autoRefreshInFlight = false;
      scheduleAutoRefresh();
    });
  }

  document.addEventListener("visibilitychange", scheduleAutoRefresh);
  scheduleAutoRefresh();

  // Per-widget force refresh (owner sessions only - the server renders
  // the ↻ button only when authed). Reuses the editor's refresh endpoint,
  // then swaps just this card from a fresh render of the page.
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("button[data-refresh]") : null;
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("spinning");
    fetch("/settings/editor/refresh", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: btn.getAttribute("data-refresh") }),
    })
      .then(function () {
        return fetch(location.href, { credentials: "same-origin" });
      })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (htmlText) {
        if (!htmlText) return;
        var cur = btn.closest("section.widget");
        var id = cur && cur.getAttribute("data-wid");
        if (!id) return;
        var doc = new DOMParser().parseFromString(htmlText, "text/html");
        var next = doc.querySelector('section.widget[data-wid="' + id + '"]');
        if (next) cur.replaceWith(next);
      })
      .catch(function () {})
      .then(function () {
        btn.disabled = false;
        btn.classList.remove("spinning");
      });
  });

  // Tooltips: instant, themed, clip-proof upgrade over native titles for
  // content inside <main> (heartbeat bars, meta timestamps). The title
  // attribute migrates to data-tip on first hover so the native delayed
  // tooltip never doubles up; anonymous pages (no ui.js) keep native
  // titles untouched. One reusable element, text only, never a content
  // surface of its own.
  var tip = document.createElement("div");
  tip.className = "ui-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  document.body.appendChild(tip);
  function showTip(el) {
    var text = el.getAttribute("data-tip") || el.getAttribute("title");
    if (!text) return;
    if (el.hasAttribute("title")) {
      el.setAttribute("data-tip", text);
      el.removeAttribute("title");
    }
    tip.textContent = text;
    tip.hidden = false;
    var r = el.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var x = Math.min(Math.max(6, r.left + r.width / 2 - tw / 2), innerWidth - tw - 6);
    var y = r.top - th - 8;
    if (y < 6) y = r.bottom + 8;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  }
  function tipTargetFrom(node) {
    return node && node.closest ? node.closest("main [title], main [data-tip]") : null;
  }
  document.addEventListener("mouseover", function (e) {
    var el = tipTargetFrom(e.target);
    if (el) showTip(el);
    else if (!tip.hidden) tip.hidden = true;
  });
  document.addEventListener("focusin", function (e) {
    var el = tipTargetFrom(e.target);
    if (el) showTip(el);
  });
  document.addEventListener("focusout", function () { tip.hidden = true; });
  document.addEventListener("scroll", function () { tip.hidden = true; }, true);

  // In fullscreen a real navigation would drop fullscreen - page tab
  // clicks swap content in place instead and keep the URL current.
  document.addEventListener("click", function (e) {
    if (!inFullscreen()) return;
    var a = e.target && e.target.closest ? e.target.closest("nav.pages a") : null;
    if (!a) return;
    e.preventDefault();
    loadInto(a.href).then(function (ok) {
      if (ok) history.pushState(null, "", a.href);
      else location.href = a.href;
    });
  });
})();
