import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { safeFetchText } from "../safefetch";
import css from "./calendar.css";

export interface CalendarWidget extends WidgetCommon {
  type: "calendar";
  url: string; // .ics feed (webcal:// normalizes to https)
  limit: number; // events shown
  days: number; // lookahead window
  tz?: string; // display timezone for timed events (default UTC)
}

// Upcoming events from an iCalendar feed. Deliberately small parser:
// unfolded VEVENT blocks, DTSTART with date / local / UTC / TZID forms,
// and simple recurrence (DAILY / WEEKLY with INTERVAL, BYDAY, UNTIL /
// COUNT; MONTHLY / YEARLY by start date) with EXDATE removal. Complex
// RRULEs (BYSETPOS, monthly BYDAY, ...) fall back to the base occurrence
// only - full RRULE expansion is out of scope by design.

export interface CalendarData {
  events: { start: number; allDay: boolean; summary: string; location?: string }[];
}

interface Vevent {
  start: number;
  allDay: boolean;
  tzid?: string; // zone the event's wall clock lives in (recurrences track it)
  summary: string;
  location?: string;
  rrule?: Record<string, string>;
  exdates: Set<number>;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Two-pass zoned wall-clock -> epoch (same technique as countdown).
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

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function icsDate(value: string, tzid?: string): { ts: number; allDay: boolean } | null {
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dm) {
    return { ts: Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])), allDay: true };
  }
  const tm = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value);
  if (!tm) return null;
  const wall = Date.UTC(
    Number(tm[1]), Number(tm[2]) - 1, Number(tm[3]),
    Number(tm[4]), Number(tm[5]), Number(tm[6] ?? 0),
  );
  if (tm[7] === "Z" || !tzid) return { ts: wall, allDay: false };
  try {
    let ts = wall - tzOffsetMs(tzid, wall);
    ts = wall - tzOffsetMs(tzid, ts);
    return { ts, allDay: false };
  } catch {
    return { ts: wall, allDay: false }; // unknown TZID: treat as UTC
  }
}

// Unfold RFC 5545 line continuations and strip CRs.
function unfold(ics: string): string[] {
  return ics.replace(/\r/g, "").replace(/\n[ \t]/g, "").split("\n");
}

function parseVevents(ics: string): Vevent[] {
  const events: Vevent[] = [];
  let cur: Partial<Vevent> & { exdates: Set<number> } | null = null;
  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") {
      cur = { exdates: new Set() };
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur && cur.start !== undefined && cur.summary) {
        events.push(cur as Vevent);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [prop = "", ...params] = left.split(";");
    const param = (name: string): string | undefined => {
      const hit = params.find((x) => x.startsWith(name + "="));
      return hit ? hit.slice(name.length + 1) : undefined;
    };
    if (prop === "DTSTART") {
      const tzid = param("TZID");
      const d = icsDate(value, tzid);
      if (d) {
        cur.start = d.ts;
        cur.allDay = d.allDay;
        // keep the zone only when it actually resolved - vendor/Windows
        // TZIDs fall back to UTC, and recurrence expansion must follow
        cur.tzid = d.allDay || !tzid || !validTz(tzid) ? undefined : tzid;
      }
    } else if (prop === "SUMMARY") {
      cur.summary = value.replace(/\\([,;nN])/g, (_, c) => (c === "," || c === ";" ? c : " ")).slice(0, 120);
    } else if (prop === "LOCATION") {
      cur.location = value.replace(/\\([,;nN])/g, (_, c) => (c === "," || c === ";" ? c : " ")).slice(0, 80) || undefined;
    } else if (prop === "RRULE") {
      const rule: Record<string, string> = {};
      for (const part of value.split(";")) {
        const [k, v] = part.split("=");
        if (k && v) rule[k] = v;
      }
      cur.rrule = rule;
    } else if (prop === "EXDATE") {
      for (const v of value.split(",")) {
        const d = icsDate(v.trim(), param("TZID"));
        if (d) cur.exdates.add(d.ts);
      }
    }
  }
  return events;
}

// Expand one event's occurrences inside [from, to].
function occurrences(ev: Vevent, from: number, to: number): number[] {
  const out: number[] = [];
  // Zoned events keep their WALL-CLOCK time across DST: naive fixed-ms
  // stepping is corrected so each occurrence has the base's local time.
  const baseOffset = ev.tzid ? tzOffsetMs(ev.tzid, ev.start) : 0;
  const wallCorrect = (ts: number): number => {
    if (!ev.tzid) return ts;
    let t = ts + (baseOffset - tzOffsetMs(ev.tzid, ts));
    t = ts + (baseOffset - tzOffsetMs(ev.tzid, t));
    return t;
  };
  const push = (rawTs: number): void => {
    const ts = wallCorrect(rawTs);
    if (ts >= from && ts <= to && !ev.exdates.has(ts) && !ev.exdates.has(rawTs)) out.push(ts);
  };
  const rule = ev.rrule;
  if (!rule || !rule.FREQ) {
    push(ev.start);
    return out;
  }
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1) || 1);
  const until = rule.UNTIL ? (icsDate(rule.UNTIL)?.ts ?? Infinity) : Infinity;
  let count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const freq = rule.FREQ;
  const base = new Date(ev.start);
  if (freq === "DAILY" || freq === "WEEKLY") {
    const stepDays = freq === "DAILY" ? interval : 7 * interval;
    // WEEKLY BYDAY expands within each week from the start's week
    // BYDAY normalized: unique, and CHRONOLOGICAL from DTSTART's weekday —
    // COUNT must be consumed in occurrence order, not textual order
    // ("BYDAY=FR,MO;COUNT=1" on a Monday start means Monday, not Friday).
    const delta = (dow: number): number => ((dow - base.getUTCDay()) + 7) % 7;
    const bydays =
      freq === "WEEKLY" && rule.BYDAY
        ? [...new Set(rule.BYDAY.split(",").map((d) => WEEKDAYS.indexOf(d)).filter((d) => d >= 0))].sort(
            (a, b) => delta(a) - delta(b),
          )
        : [base.getUTCDay()];
    // Fast-forward to the window for EVERY rule: skipped cycles consume
    // the finite COUNT arithmetically (occurrences-per-cycle = |bydays|),
    // so an old rule with a large COUNT still reaches the visible range.
    const perCycle = freq === "DAILY" ? 1 : bydays.length;
    const skip = Math.max(0, Math.floor((from - ev.start) / (stepDays * DAY_MS)) - 1);
    if (count !== Infinity) {
      count -= skip * perCycle;
      if (count <= 0) return out; // rule exhausted before the window
    }
    for (let week = skip; ; week++) {
      const cycleStart = ev.start + week * stepDays * DAY_MS;
      if (cycleStart > to + 7 * DAY_MS || cycleStart > until || count <= 0) break;
      if (week - skip > 500) break; // safety bound
      for (const dow of bydays) {
        const ts = cycleStart + (freq === "DAILY" ? 0 : delta(dow) * DAY_MS);
        if (ts < ev.start || ts > until) continue;
        if (count-- <= 0) break;
        push(ts);
      }
    }
    return out;
  }
  if (freq === "MONTHLY" || freq === "YEARLY") {
    // Fast-forward in calendar units so multi-year-old ongoing rules
    // reach the window; skipped iterations consume a finite COUNT.
    const fromD = new Date(from);
    const monthsBehind =
      (fromD.getUTCFullYear() - base.getUTCFullYear()) * 12 + (fromD.getUTCMonth() - base.getUTCMonth());
    const unitsBehind = freq === "MONTHLY" ? monthsBehind : Math.floor(monthsBehind / 12);
    const skip = Math.max(0, Math.floor(unitsBehind / interval) - 1);
    if (count !== Infinity) {
      count -= skip;
      if (count <= 0) return out;
    }
    for (let i = skip; i - skip < 60; i++) {
      const d = new Date(ev.start);
      if (freq === "MONTHLY") d.setUTCMonth(d.getUTCMonth() + i * interval);
      else d.setUTCFullYear(d.getUTCFullYear() + i * interval);
      const ts = d.getTime();
      if (ts > to || ts > until || count-- <= 0) break;
      push(ts);
    }
    return out;
  }
  push(ev.start); // unsupported FREQ: base occurrence only
  return out;
}

export async function fetchData(cfg: CalendarWidget): Promise<CalendarData> {
  const ics = await safeFetchText(cfg.url, { maxBytes: 2_000_000 });
  if (!/BEGIN:VCALENDAR/.test(ics)) throw new Error("not an iCalendar feed");
  const now = Date.now();
  const from = now - DAY_MS; // still show today's earlier all-day events
  const to = now + cfg.days * DAY_MS;
  const events: CalendarData["events"] = [];
  for (const ev of parseVevents(ics)) {
    for (const ts of occurrences(ev, from, to)) {
      events.push({ start: ts, allDay: ev.allDay, summary: ev.summary, location: ev.location });
    }
  }
  events.sort((a, b) => a.start - b.start);
  return { events: events.slice(0, cfg.limit) };
}

function whenLabel(ev: CalendarData["events"][number], tz: string): string {
  const d = new Date(ev.start);
  // all-day dates are date-only (UTC-anchored); timed events display in
  // the widget's configured zone
  const zone = ev.allDay ? "UTC" : tz;
  const dkey = (ts: number): number =>
    Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts));
  const dayDiff = Math.round((dkey(ev.start) - dkey(Date.now())) / DAY_MS);
  const day =
    dayDiff === 0 ? "Today" : dayDiff === 1 ? "Tomorrow" : new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(d);
  if (ev.allDay) return day;
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
  return `${day} ${time}`;
}

export function render(data: CalendarData, cfg: CalendarWidget): SafeHtml {
  if (data.events.length === 0) return html`<p class="empty">No upcoming events.</p>`;
  return html`<ul class="cal">
    ${data.events.map(
      (ev) => html`<li>
        <span class="cal-when">${whenLabel(ev, cfg.tz ?? "UTC")}</span>
        <span class="cal-what">${ev.summary}${ev.location ? html`<span class="meta">${ev.location}</span>` : null}</span>
      </li>`,
    )}
  </ul>`;
}

export const def: WidgetDef<CalendarWidget, CalendarData> = {
  meta: {
    title: "Calendar",
    icon: "📅",
    defaultTitle: "Calendar",
    category: "Personal",
    description: "Upcoming events from any iCal (.ics) feed URL.",
    requirements: "Google/Fastmail/Proton all export a secret .ics address. Simple recurrence only.",
  },
  css,
  sourceFields: ["url"],
  form: [
    {
      key: "url",
      label: "iCal URL",
      kind: "url",
      required: true,
      placeholder: "https://calendar.google.com/calendar/ical/\u2026/basic.ics",
      prefill: "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics",
      help: "webcal:// links work too.",
    },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, placeholder: "30m", prefill: "30m" },
    { key: "tz", label: "Display timezone", kind: "timezone", help: "Timed events show in this zone. Defaults to the dashboard timezone." },
    { key: "limit", label: "Events to show", kind: "number", advanced: true, placeholder: "8" },
    { key: "days", label: "Days ahead", kind: "number", advanced: true, placeholder: "14" },
  ],
  parse(w, where, common, h) {
    let url = h.str(w.url, `${where}.url`);
    if (url.startsWith("webcal://")) url = "https://" + url.slice(9);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${where}: bad url`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`${where}: url must be http(s) or webcal`);
    }
    // Own zone wins; otherwise the document's, then UTC at render.
    let tz: string | undefined = common.timezone;
    if (typeof w.tz === "string" && w.tz.trim()) {
      tz = w.tz.trim();
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new Error(`${where}: unknown timezone "${tz}" (use IANA names like America/New_York)`);
      }
    }
    return {
      ...common,
      refreshSeconds: h.parseInterval(w.refresh_interval, `${where}.refresh_interval`),
      type: "calendar",
      url,
      limit: Math.min(Math.max(1, Math.trunc(h.num(w.limit ?? 8, `${where}.limit`))), 20),
      days: Math.min(Math.max(1, Math.trunc(h.num(w.days ?? 14, `${where}.days`))), 60),
      tz,
    };
  },
  fetchData,
  render,
};
