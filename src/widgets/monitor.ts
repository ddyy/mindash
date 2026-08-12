import type { WidgetCommon, WidgetDef } from "./def";
import { html, safeUrl, type SafeHtml } from "../html";
import { safeFetchRaw } from "../safefetch";
import css from "./monitor.css";

export interface MonitorSite {
  title: string;
  url: string;
}
export interface MonitorWidget extends WidgetCommon {
  type: "monitor";
  sites: MonitorSite[];
}

// Uptime checks for a list of sites: HEAD each URL (GET fallback for
// servers that reject HEAD), report status and latency. A site that fails
// is a "down" row - never a failure of the whole widget; all-down is a
// valid, important result.

export interface MonitorData {
  rows: { title: string; url: string; up: boolean; status: number | null; ms: number; err?: string }[];
  // Rolling per-site check history (keyed by url, oldest first) - carried
  // forward through the cached payload so each refresh appends one entry.
  // That gives heartbeat-style bars without a table: history survives
  // exactly as long as the widget does.
  history?: Record<string, { t: number; up: boolean; ms?: number }[]>;
}

const CHECK_TIMEOUT_MS = 8_000;
const HISTORY_KEEP = 30; // entries stored per site
const HISTORY_BARS = 12; // entries rendered

async function check(site: MonitorSite): Promise<MonitorData["rows"][number]> {
  const attempt = async (method: "HEAD" | "GET") => {
    const started = Date.now();
    const res = await safeFetchRaw(site.url, {
      method,
      timeoutMs: CHECK_TIMEOUT_MS,
      maxBytes: 65_536,
      allowTruncate: true,
    });
    return { status: res.status, ms: Date.now() - started };
  };
  try {
    let r = await attempt("HEAD");
    if (r.status === 405 || r.status === 501) r = await attempt("GET");
    return { title: site.title, url: site.url, up: r.status >= 200 && r.status < 300, status: r.status, ms: r.ms };
  } catch (e) {
    const raw = String(e instanceof Error ? e.message : e);
    const err = /abort|timeout|timed out/i.test(raw) ? "timeout" : raw.slice(0, 60);
    return { title: site.title, url: site.url, up: false, status: null, ms: 0, err };
  }
}

async function previousHistory(cfg: MonitorWidget, env: Env | undefined): Promise<NonNullable<MonitorData["history"]>> {
  if (!env?.DB) return {}; // tests and probes run without a database
  try {
    const row = await env.DB
      .prepare("SELECT payload FROM refresh_state WHERE instance_id = ?1")
      .bind(cfg.id)
      .first<{ payload: string | null }>();
    if (!row?.payload) return {};
    const prev = JSON.parse(row.payload) as { data?: MonitorData };
    return prev.data?.history ?? {};
  } catch {
    return {}; // unreadable cache must never fail the check itself
  }
}

export async function fetchData(cfg: MonitorWidget, env?: Env): Promise<MonitorData> {
  const rows = await Promise.all(cfg.sites.map(check));
  const prev = await previousHistory(cfg, env);
  const now = Date.now();
  const history: NonNullable<MonitorData["history"]> = {};
  for (const r of rows) {
    // keyed by url so retitling keeps history; removed sites fall away
    history[r.url] = [...(prev[r.url] ?? []), { t: now, up: r.up, ...(r.up ? { ms: r.ms } : {}) }].slice(-HISTORY_KEEP);
  }
  return { rows, history };
}

const BAR_MAX_PX = 16; // strip height; up bars scale within it by latency
const BAR_MIN_PX = 3; // floor so a fast check still draws a visible bar

// The dot is decorative (aria-hidden): state is also carried by the stat
// text - latency for up rows, the status code or error for down rows. The
// history strip is a small latency GRAPH: green bar height tracks response
// time (normalized to the site's own slowest check in the window, so every
// site uses its full strip); down checks are full-height red. Each bar's
// tooltip carries time + latency/state.
export function render(data: MonitorData, _cfg: MonitorWidget): SafeHtml {
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return html`<ul class="mon">
    ${data.rows.map((r) => {
      const hist = (data.history?.[r.url] ?? []).slice(-HISTORY_BARS);
      const maxMs = Math.max(...hist.filter((h) => h.up && h.ms !== undefined).map((h) => h.ms as number), 1);
      return html`<li>
        <span class="dot ${r.up ? "up" : "down"}" aria-hidden="true"></span>
        <a href="${safeUrl(r.url)}" rel="noreferrer">${r.title}</a>
        ${hist.length > 1
          ? html`<span class="mon-bars" aria-hidden="true">${hist.map((h) => {
              const px = h.up
                ? Math.max(BAR_MIN_PX, Math.round(((h.ms ?? maxMs) / maxMs) * BAR_MAX_PX))
                : BAR_MAX_PX;
              const tip = `${fmt.format(h.t)} · ${h.up ? (h.ms !== undefined ? `${h.ms} ms` : "up") : "down"}`;
              return html`<span class="bar ${h.up ? "ok" : "fail"}" style="height:${px}px" title="${tip}"></span>`;
            })}</span>`
          : null}
        <span class="stat">${r.up ? `${r.ms} ms` : r.status !== null ? `HTTP ${r.status}` : (r.err ?? "down")}</span>
      </li>`;
    })}
  </ul>`;
}

export const def: WidgetDef<MonitorWidget, MonitorData> = {
  meta: {
    title: "Site monitor",
    icon: "📡",
    defaultTitle: "Monitor",
    category: "Monitoring",
    description: "Up/down and latency for your sites - a green dot per healthy URL.",
  },
  css,
  // The URLs are fetch destinations: every edit to the list is a sources
  // decision.
  sourceFields: ["sites"],
  form: [
    {
      key: "sites",
      label: "Sites",
      kind: "linklist",
      prefill: "Demo: https://demo.mindash.dev\nGitHub: https://github.com",
      help: "Up to 12 URLs, checked with HEAD requests. Empty titles use the site's hostname.",
    },
    { key: "refresh_interval", label: "Check every", kind: "interval", required: true, prefill: "5m", placeholder: "5m" },
  ],
  parse(w, where, common, h) {
    const refreshSeconds = h.parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    if (!Array.isArray(w.sites)) throw new Error(`${where}: sites must be a list of {title, url}`);
    if (w.sites.length === 0) throw new Error(`${where}: at least one site required`);
    if (w.sites.length > 12) throw new Error(`${where}: at most 12 sites`);
    const sites: MonitorSite[] = w.sites.map((s, i) => {
      const o = s as Record<string, unknown>;
      const url = h.str(o?.url, `${where}.sites[${i}].url`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`${where}.sites[${i}]: bad url`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`${where}.sites[${i}]: url must be http(s)`);
      }
      const title =
        typeof o?.title === "string" && o.title.trim()
          ? o.title.trim().slice(0, 60)
          : parsed.hostname.replace(/^www\./, "");
      return { title, url };
    });
    return { ...common, type: "monitor", refreshSeconds, sites };
  },
  fetchData,
  render,
};
