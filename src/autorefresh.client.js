"use strict";
// The dashboard's soft auto-refresh, as a PURE decision: given the clock,
// the last attempt, and whether the page is hidden or already fetching,
// say what the scheduler should do next. Kept in its own file (and free
// of any DOM reference) so the behaviour can be tested by running this
// code, rather than by grepping the shipped script for keywords.
//
// Served concatenated ahead of ui.client.js, so the wiring below it calls
// decideAutoRefresh directly.
//
// Actions:
//   run    - fetch now
//   wait   - set a timer for `delay` ms
//   cancel - clear any timer and schedule nothing (the tab is hidden)
//   none   - leave things alone (a fetch is in flight; its completion
//            schedules the next attempt)
var AUTO_REFRESH_MS = 300000;

function decideAutoRefresh(s) {
  // A hidden tab costs a Worker invocation and a D1 read to redraw a page
  // nobody can see. Stop entirely; visibilitychange brings it back.
  if (s.hidden) return { action: "cancel" };
  // Never overlap: the in-flight request's completion re-schedules, so a
  // burst of visibility or timer events cannot fan out into requests.
  if (s.inFlight) return { action: "none" };
  var elapsed = s.now - s.lastAttempt;
  // Returning to a tab that has been hidden past the interval refreshes
  // at once - the point of this is fresher data on return, not only
  // fewer requests.
  if (elapsed >= AUTO_REFRESH_MS) return { action: "run" };
  return { action: "wait", delay: AUTO_REFRESH_MS - elapsed };
}
