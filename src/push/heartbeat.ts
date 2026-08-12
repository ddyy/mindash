import type { HeartbeatWidget } from "../config";
import { html, type SafeHtml } from "../html";
import { occurrenceAtOrBefore } from "./schedule";
import { relativeTime } from "../widgets/shared";

// Heartbeat rendering: status is computed at render time from the schedule
// and the run history - history rows themselves come only from pings and
// the timeout sweep.

export interface RunRow {
  run_id: string;
  expected_at: number | null;
  started_at: number | null;
  timed_out_at: number | null;
  completed_at: number | null;
  completion_outcome: string | null;
  payload: string | null;
}

type Status = "ok" | "late" | "fail" | "missed" | "running" | "waiting";

const STATUS_LABEL: Record<Status, string> = {
  ok: "OK",
  late: "late",
  fail: "failed",
  missed: "missed",
  running: "running",
  waiting: "waiting for first ping",
};

function runClass(r: RunRow): string {
  if (r.completed_at) return r.completion_outcome === "success" ? "ok" : "fail";
  if (r.timed_out_at) return "timeout";
  return "open";
}

export function computeStatus(w: HeartbeatWidget, runs: RunRow[], now: number): Status {
  const latest = runs[0];
  if (!latest) return "waiting";
  if (!latest.completed_at && latest.started_at && !latest.timed_out_at) return "running";

  const lastExpected = occurrenceAtOrBefore(w.schedule, now);
  const claimed = runs.find((r) => r.expected_at === lastExpected);
  if (claimed?.completed_at) return claimed.completion_outcome === "success" ? "ok" : "fail";
  if (claimed?.timed_out_at && !claimed.completed_at) return "missed";

  // Current occurrence unclaimed: a completion at-or-after the expected time
  // (e.g. a manual/late run) satisfies it until the next occurrence comes due.
  if (now < lastExpected) return latestOutcome(latest);
  if (latest.completed_at && latest.completed_at >= lastExpected) return latestOutcome(latest);
  return now <= lastExpected + w.schedule.graceMs ? "late" : "missed";
}

function latestOutcome(r: RunRow): Status {
  if (r.timed_out_at && !r.completed_at) return "missed";
  if (r.completed_at) return r.completion_outcome === "success" ? "ok" : "fail";
  return "late";
}

function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

// Payload fields: the POST body is data, rendered through the escaping
// template like everything else - payload widgets are pure config.
function payloadFields(w: HeartbeatWidget, latest: RunRow | undefined): SafeHtml | null {
  if (w.fields.length === 0 || !latest?.payload) return null;
  let body: unknown;
  try {
    body = JSON.parse(latest.payload);
  } catch {
    return null;
  }
  return html`<ul class="kv">
    ${w.fields.map((f) => {
      const v = resolvePath(body, f.path);
      return html`<li><span class="k">${f.label}</span><span class="v">${v === undefined ? "-" : typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v)}</span></li>`;
    })}
  </ul>`;
}

export function renderHeartbeat(w: HeartbeatWidget, runs: RunRow[], now: number): SafeHtml {
  const status = computeStatus(w, runs, now);
  const latest = runs[0];
  const lastSeen = latest?.completed_at ?? latest?.started_at ?? latest?.timed_out_at;
  const latestCompleted = runs.find((r) => r.completed_at !== null);
  const duration =
    latestCompleted?.started_at && latestCompleted.completed_at
      ? latestCompleted.completed_at - latestCompleted.started_at
      : null;
  const bars = [...runs].slice(0, w.history).reverse();
  return html`<div class="heartbeat status-${status}">
    <div class="hb-row">
      <span class="dot"></span>
      <span class="hb-status">${STATUS_LABEL[status]}</span>
      ${lastSeen ? html`<span class="meta">last ${relativeTime(lastSeen)}</span>` : null}
      ${duration !== null ? html`<span class="meta">took ${formatDuration(duration)}</span>` : null}
    </div>
    ${payloadFields(w, latestCompleted ?? latest)}
    ${bars.length > 0
      ? html`<div class="hb-bars">
          ${bars.map((r) => {
            const at = r.completed_at ?? r.timed_out_at ?? r.started_at ?? r.expected_at;
            const when = at
              ? new Intl.DateTimeFormat("en-US", {
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                }).format(at)
              : "unknown time";
            const WORDS: Record<string, string> = { ok: "success", fail: "failed", timeout: "timed out", open: "running" };
            return html`<span class="bar ${runClass(r)}" title="${when} \u00b7 ${WORDS[runClass(r)] ?? runClass(r)}"></span>`;
          })}
        </div>`
      : null}
  </div>`;
}
