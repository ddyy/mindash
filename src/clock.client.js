"use strict";
// Mirror of fmtRemaining in src/widgets/countdown.ts: the server paints
// the first frame, this paints every one after, and they must agree.
function fmtRemaining(ms, fmt) {
  if (ms <= 0) return "done";
  var total = Math.floor(ms / 1000);
  var d = Math.floor(total / 86400);
  var h = Math.floor((total % 86400) / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  if (fmt === "days") return d > 0 ? d + "d" : "under a day";
  if (fmt === "minutes") return d > 0 ? d + "d " + h + "h " + m + "m" : h > 0 ? h + "h " + m + "m" : m + "m";
  if (fmt === "seconds") {
    if (d > 0) return d + "d " + h + "h " + m + "m " + s + "s";
    if (h > 0) return h + "h " + m + "m " + s + "s";
    if (m > 0) return m + "m " + s + "s";
    return s + "s";
  }
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m";
}
// Mirror of clockOptions in src/widgets/clock.ts. Locale is the viewer's
// (undefined), so "auto" reads the way they expect it to.
function clockOptions(fmt, tz) {
  var o = { timeZone: tz, hour: "numeric", minute: "2-digit" };
  if (fmt && fmt.indexOf("seconds") !== -1) o.second = "2-digit";
  if (fmt && fmt.indexOf("12h") === 0) o.hour12 = true;
  if (fmt && fmt.indexOf("24h") === 0) { o.hour12 = false; o.hourCycle = "h23"; }
  return o;
}
function tick() {
  var now = new Date();
  document.querySelectorAll("[data-tz]").forEach(function (node) {
    try {
      node.textContent = new Intl.DateTimeFormat(undefined, clockOptions(node.getAttribute("data-fmt"), node.getAttribute("data-tz"))).format(now);
    } catch (e) { /* unknown zone: keep the server-rendered time */ }
  });
  document.querySelectorAll("[data-target-ms]").forEach(function (node) {
    var t = Number(node.getAttribute("data-target-ms"));
    if (Number.isFinite(t)) node.textContent = fmtRemaining(t - now.getTime(), node.getAttribute("data-fmt"));
  });
}
tick();
// Half-minute is plenty for clocks and minute-resolution countdowns; a
// page showing seconds needs every second, and only pays for it when one
// is actually on the page.
var needsSeconds =
  document.querySelector('[data-target-ms][data-fmt="seconds"]') !== null ||
  document.querySelector('[data-tz][data-fmt$="seconds"]') !== null;
setInterval(tick, needsSeconds ? 1000 : 30000);
