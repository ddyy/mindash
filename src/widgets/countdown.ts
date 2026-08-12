import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { DISPLAY_SIZES, sizeClass, type DisplaySize } from "./shared";
import css from "./countdown.css";

export interface CountdownWidget extends WidgetCommon {
  type: "countdown";
  target: string; // date string; canonical epoch is parsed server-side
  tz?: string; // IANA zone the target is interpreted in (default UTC)
  format: CountdownFormat; // how much precision to show
  size: DisplaySize;
}

// How far down the units go. "auto" keeps the original behavior: the two
// largest non-zero units, so a distant date reads "141d 11h" and the last
// hour reads "42m". The rest are explicit floors for people who want the
// clock to keep moving.
export const COUNTDOWN_FORMATS = ["auto", "days", "minutes", "seconds"] as const;
export type CountdownFormat = (typeof COUNTDOWN_FORMATS)[number];

// What instant a countdown target names. Bare datetimes are wall-clock in
// the widget's zone (default UTC) - the classic two-pass offset adjustment
// handles DST without a date library. Explicit offsets/Z win over tz.
function tzOffsetMs(tz: string, at: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(at))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const h = p.hour === 24 ? 0 : p.hour;
  return Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, h ?? 0, p.minute ?? 0, p.second ?? 0) - at;
}

export function countdownEpoch(target: string, tz?: string): number {
  const s = target.trim();
  const explicit = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
  const wall = /^\d{4}-\d{2}-\d{2}$/.test(s) || explicit
    ? Date.parse(s)
    : Date.parse(s.replace(" ", "T") + "Z");
  if (Number.isNaN(wall)) return Date.parse(s);
  if (explicit || !tz) return wall;
  let epoch = wall - tzOffsetMs(tz, wall);
  epoch = wall - tzOffsetMs(tz, epoch);
  return epoch;
}

// Kept in lockstep with the same function in clock.client.js - the
// server paints the first frame and the ticker paints every one after.
export function fmtRemaining(ms: number, fmt: CountdownFormat = "auto"): string {
  if (ms <= 0) return "done";
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (fmt === "days") return d > 0 ? `${d}d` : "under a day";
  if (fmt === "minutes") return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  if (fmt === "seconds") {
    return d > 0 ? `${d}d ${h}h ${m}m ${s}s` : h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function renderStatic(w: CountdownWidget): SafeHtml {
  // The server's parse is canonical: the epoch rides along so the client
  // ticker never re-interprets the date string in a different timezone.
  const target = countdownEpoch(w.target, w.tz);
  const past = target <= Date.now();
  const when = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", ...(w.tz ? { timeZone: w.tz } : {}) }).format(target);
  return html`<span class="cd-remaining ${sizeClass(w.size)}" data-target-ms="${target}" data-fmt="${w.format}">${fmtRemaining(target - Date.now(), w.format)}</span>
    <span class="meta">${past ? "reached" : "until"} ${when}${w.tz ? ` (${w.tz})` : ""}</span>`;
}

export const def: WidgetDef<CountdownWidget> = {
  meta: {
    title: "Countdown",
    icon: "⏳",
    category: "Personal",
    description: "Time remaining until a date, down to days, minutes, or seconds.",
  },
  sourceFields: [],
  form: [
    {
      key: "target",
      label: "Target date",
      kind: "text",
      required: true,
      placeholder: "2026-12-31 17:00",
      help: "A date, optionally with a time.",
    },
    {
      key: "tz",
      label: "Timezone",
      kind: "timezone",
      help: "How the target date is interpreted. Defaults to the dashboard timezone.",
    },
    {
      key: "format",
      label: "Show",
      kind: "select",
      options: [...COUNTDOWN_FORMATS],
      help: 'auto = the two largest units ("141d 11h"). seconds ticks every second; the others update twice a minute.',
    },
    { key: "size", label: "Size", kind: "select", options: [...DISPLAY_SIZES], advanced: true },
  ],
  parse(w, where, common, h) {
    const target = h.str(w.target, `${where}.target`);
    // Own zone wins; otherwise the document's, then UTC (countdownEpoch).
    const tz = typeof w.tz === "string" && w.tz.trim() ? w.tz.trim() : common.timezone;
    if (tz !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new Error(`${where}: unknown timezone "${tz}" (use IANA names like America/New_York)`);
      }
    }
    if (Number.isNaN(countdownEpoch(target, tz))) {
      throw new Error(`${where}: target must be a date like "2026-12-31" or "2026-12-31 17:00"`);
    }
    const format = (COUNTDOWN_FORMATS as readonly string[]).includes(String(w.format))
      ? (w.format as CountdownFormat)
      : "auto";
    const size = (DISPLAY_SIZES as readonly string[]).includes(String(w.size))
      ? (w.size as DisplaySize)
      : "default";
    return { ...common, type: "countdown", refreshSeconds: 0, target, tz, format, size };
  },
  renderStatic,
  liveScript: true,
  css,
};
