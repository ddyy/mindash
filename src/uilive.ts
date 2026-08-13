// Signed-in dashboard enhancements — served as /ui.js. Fullscreen
// toggle, soft auto-refresh, tooltips, in-place page switching. Real JS
// files imported as text.
//
// The auto-refresh DECISION is a separate module so it can be executed by
// tests without a DOM; it ships ahead of the wiring that calls it, in one
// script, so no module loading is involved on the page.
import scheduler from "./autorefresh.client.js";
import client from "./ui.client.js";

export const UI_JS: string = `${scheduler}\n${client}`;
