import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { DISPLAY_SIZES, sizeClass, type DisplaySize } from "./shared";
import css from "./clock.css";

export interface ClockEntry {
  label: string;
  tz: string; // IANA zone name, validated via Intl at parse time
}
export interface ClockWidget extends WidgetCommon {
  type: "clock";
  clocks: ClockEntry[];
  format: ClockFormat; // "auto" follows the viewer's locale
  size: DisplaySize;
}

// "auto" is the honest default: a clock should read the way the person
// looking at it expects, and only they know that. The rest are for
// dashboards that want one house style regardless of who is watching.
export const CLOCK_FORMATS = ["auto", "12h", "24h", "12h + seconds", "24h + seconds"] as const;
export type ClockFormat = (typeof CLOCK_FORMATS)[number];

// Server renders the initial times; /clock.js keeps them current on the
// dashboard (the editor preview shows the static render).
// Intl options for a format; "auto" omits hour12 so the locale decides.
export function clockOptions(fmt: ClockFormat): Intl.DateTimeFormatOptions {
  const seconds = fmt.endsWith("seconds");
  const base: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) };
  if (fmt.startsWith("12h")) return { ...base, hour12: true };
  if (fmt.startsWith("24h")) return { ...base, hour12: false, hourCycle: "h23" };
  return base;
}

export function renderStatic(w: ClockWidget): SafeHtml {
  const now = new Date();
  const opts = clockOptions(w.format);
  // The server paints in en-US; the ticker repaints in the viewer's own
  // locale on first tick, so "auto" really does follow the reader.
  return html`<ul class="kv ${sizeClass(w.size)}">${w.clocks.map((c) => {
      let t = "–";
      try {
        t = new Intl.DateTimeFormat("en-US", { timeZone: c.tz, ...opts }).format(now);
      } catch {
        // validated at parse time; belt-and-suspenders for stored docs
      }
      return html`<li><span class="k">${c.label}</span><span class="v" data-tz="${c.tz}" data-fmt="${w.format}">${t}</span></li>`;
    })}</ul>`;
}

export const def: WidgetDef<ClockWidget> = {
  meta: {
    title: "World clock",
    icon: "🕐",
    category: "Personal",
    description: "Current time in one or more timezones, ticking live.",
  },
  sourceFields: [], // presentation only - no fetch or credential authority
  form: [
    {
      key: "clocks",
      label: "Clocks",
      kind: "clocklist",
      prefill: "New York: America/New_York\nLondon: Europe/London\nTokyo: Asia/Tokyo",
      help: "Up to 8 clocks.",
    },
    {
      key: "format",
      label: "Time format",
      kind: "select",
      options: [...CLOCK_FORMATS],
      help: "auto follows each viewer's locale. Seconds tick every second; the rest update twice a minute.",
    },
    { key: "size", label: "Size", kind: "select", options: [...DISPLAY_SIZES], advanced: true },
  ],
  parse(w, where, common, h) {
    // Editor fieldmap rows arrive as {label, path}; tz-shaped entries (MCP,
    // hand-written YAML) are accepted as-is. With no list, a dashboard that
    // knows its own timezone shows that one clock; otherwise the classic
    // trio (the label falls out of the zone's city segment below).
    const rawClocks =
      Array.isArray(w.clocks) && w.clocks.length > 0
        ? w.clocks
        : common.timezone
          ? [{ tz: common.timezone }]
          : [
              { label: "New York", tz: "America/New_York" },
              { label: "London", tz: "Europe/London" },
              { label: "Tokyo", tz: "Asia/Tokyo" },
            ];
    if (rawClocks.length > 8) throw new Error(`${where}: at most 8 clocks`);
    const clocks: ClockEntry[] = rawClocks.map((c, i) => {
      const o = c as Record<string, unknown>;
      const tz = h.str(o?.tz ?? o?.path, `${where}.clocks[${i}].tz`);
      const label =
        typeof o?.label === "string" && o.label.trim()
          ? o.label.trim()
          : (tz.split("/").pop() ?? tz).replace(/_/g, " "); // city as fallback
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new Error(`${where}.clocks[${i}]: unknown timezone "${tz}" (use IANA names like America/New_York)`);
      }
      return { label, tz };
    });
    const format = (CLOCK_FORMATS as readonly string[]).includes(String(w.format))
      ? (w.format as ClockFormat)
      : "auto";
    const size = (DISPLAY_SIZES as readonly string[]).includes(String(w.size))
      ? (w.size as DisplaySize)
      : "default";
    return { ...common, type: "clock", refreshSeconds: 0, clocks, format, size };
  },
  renderStatic,
  liveScript: true,
  css,
};
