import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseAnchor } from "./push/schedule";
import seedText from "../config.yaml";
import {
  num,
  parseFields,
  parseHelpers,
  parseInterval,
  str,
  type FieldSpec,
  type RawWidget,
  type WidgetCommon,
} from "./widgets/def";
import { WIDGETS, WIDGET_DEFAULT_TITLES, WIDGET_SOURCE_FIELDS, WIDGET_EXTRA_SOURCE_FIELDS } from "./widgets";
import type { RssWidget } from "./widgets/rss";
import type { WeatherWidget } from "./widgets/weather";
import type { HackerNewsWidget } from "./widgets/hackernews";
import type { JsonApiWidget } from "./widgets/json-api";
import type { McpWidget } from "./widgets/mcp";
import type { CryptoWidget } from "./widgets/crypto";
import type { StocksWidget } from "./widgets/stocks";
import type { CalendarWidget } from "./widgets/calendar";
import type { ImageWidget } from "./widgets/image";
import type { YoutubeWidget } from "./widgets/youtube";
import type { MonitorWidget } from "./widgets/monitor";
import type { ScrapeWidget } from "./widgets/scrape";
import type { IframeWidget } from "./widgets/iframe";
import type { ClockWidget } from "./widgets/clock";
import type { CountdownWidget } from "./widgets/countdown";
import type { BookmarksWidget } from "./widgets/bookmarks";
import type { SearchWidget } from "./widgets/search";
import type { NoteWidget } from "./widgets/note";

// Runtime config (plan: "Config & MCP"). D1 holds the canonical raw
// document (snake_case, YAML-shaped, widgets stamped with server-owned
// instance ids). This module: validation raw→runtime (dispatching per-type
// parsing to the widget defs in src/widgets/), the semantic diff
// classifier that authorization runs on, scope-filtered redaction, and the
// per-isolate cached loader.

// ---------- runtime types ----------

// Per-widget config interfaces live in their def files; re-exported here so
// consumers keep one import site.
export type { WidgetCommon, FieldSpec, RawWidget } from "./widgets/def";
export type { RssWidget } from "./widgets/rss";
export type { WeatherWidget } from "./widgets/weather";
export type { HackerNewsWidget } from "./widgets/hackernews";
export type { JsonApiWidget } from "./widgets/json-api";
export type { McpWidget } from "./widgets/mcp";
export type { CryptoWidget } from "./widgets/crypto";
export type { StocksWidget } from "./widgets/stocks";
export type { IframeWidget } from "./widgets/iframe";
export type { ClockWidget, ClockEntry } from "./widgets/clock";
export type { CountdownWidget } from "./widgets/countdown";
export type { BookmarksWidget, BookmarkLink } from "./widgets/bookmarks";
export type { SearchWidget } from "./widgets/search";
export type { NoteWidget } from "./widgets/note";
export { countdownEpoch } from "./widgets/countdown";

export interface HeartbeatWidget extends WidgetCommon {
  type: "heartbeat";
  schedule: { intervalMs: number; graceMs: number; anchorMs: number };
  tokenSecret?: string; // legacy PUSH_TOKEN_* env fallback; new tokens live in D1
  history: number;
  fields: FieldSpec[]; // rendered from the latest run's payload
}
// The second hand-rolled push widget: lines POSTed to /push/<name> are
// stored in D1 and rendered newest-first. No schedule - unlike heartbeat
// it carries no expectation, only what arrived.
export interface LogWidget extends WidgetCommon {
  type: "log";
  limit: number; // messages shown
}
export type PullWidgetConfig = RssWidget | WeatherWidget | HackerNewsWidget | JsonApiWidget | McpWidget | CryptoWidget | StocksWidget | CalendarWidget | ImageWidget | YoutubeWidget | MonitorWidget | ScrapeWidget;
export type StaticWidgetConfig = IframeWidget | ClockWidget | CountdownWidget | BookmarksWidget | SearchWidget | NoteWidget;
export type WidgetConfig = PullWidgetConfig | HeartbeatWidget | LogWidget | StaticWidgetConfig;

// A type is pull iff its def fetches; heartbeat (not in the manifest) and
// the static defs (no fetchData) are non-pull.
export function isPullWidget(w: WidgetConfig): w is PullWidgetConfig {
  return WIDGETS[w.type]?.fetchData !== undefined;
}

export type ColumnWidth = "full" | "1/2" | "1/3" | "2/3" | "1/4" | "3/4" | "1/6" | "5/6";
export const COLUMN_SPANS: Record<ColumnWidth, number> = {
  full: 12, "1/2": 6, "1/3": 4, "2/3": 8, "1/4": 3, "3/4": 9, "1/6": 2, "5/6": 10,
};
export interface ColumnConfig {
  width: ColumnWidth;
  title?: string;
  widgets: WidgetConfig[];
}
export interface RowConfig {
  name?: string; // stable editor label ("Row A"); not rendered on the dashboard
  title?: string;
  height?: ColumnWidth; // fit pages: share of the viewport (same 12-part scale as widths)
  fill: boolean; // scrolling pages: widgets stretch so column bottoms align (default ON; stored only as fill:false)
  columns: ColumnConfig[];
}
export interface PageConfig {
  name: string;
  fit?: boolean; // fill the viewport: rows share the height, columns scroll
  publicView?: boolean; // render without a session (read-only; noindex unless indexable)
  indexable?: boolean; // public pages only: allow search engines
  hidden?: boolean; // omit from the dashboard page menu (still reachable by URL)
  description?: string; // meta description + link-preview text
  theme?: string; // named preset overlaid on the global theme
  rows: RowConfig[];
}
export const THEME_FONTS = ["system", "serif", "mono", "rounded"] as const;
export const THEME_RADII = [0, 4, 10, 16] as const;
export const THEME_FONT_SIZES = [13, 15, 17, 20] as const;
export const THEME_TITLE_SIZES = ["small", "default", "large", "x-large"] as const;
export interface ThemeConfig {
  accent?: string;
  positive?: string;
  negative?: string;
  max_width?: number; // px; dashboard centers when set
  title?: string; // header text (default "mindash")
  font?: (typeof THEME_FONTS)[number];
  font_size?: (typeof THEME_FONT_SIZES)[number]; // px base; scales rem spacing too
  title_size?: (typeof THEME_TITLE_SIZES)[number]; // widget card headings
  background?: string; // HSL triplet overrides (apply to both schemes)
  text?: string;
  muted?: string; // secondary text: timestamps, labels, .meta lines
  card?: string;
  border?: string;
  card_opacity?: number; // 20-100; only meaningful over a background image
  radius?: (typeof THEME_RADII)[number];
  background_image?: string; // /asset/<key> (R2) or https URL
  logo?: string; // /asset/<key> (R2) or https URL
  favicon?: string; // browser-tab icon; /asset/ upload or https URL
}
export interface DashConfig {
  theme: ThemeConfig;
  themes: Record<string, Partial<ThemeConfig>>;
  timezone?: string; // IANA zone inherited by time-bearing widgets
  pages: PageConfig[];
  widgets: WidgetConfig[];
}

// ---------- raw document ----------

export interface RawDoc {
  theme: ThemeConfig;
  themes?: Record<string, Partial<ThemeConfig>>;
  timezone?: string;
  pages: { name: string; fit_screen?: boolean; public?: boolean; indexable?: boolean; description?: string; hidden?: boolean; theme?: string; rows: { name?: string; title?: string; height?: string; fill?: boolean; columns: { width: string; title?: string; widgets: RawWidget[] }[] }[] }[];
}

// Fields that carry source/credential/schedule authority - changing them
// (or creating/removing/type-changing a widget) requires config:sources,
// and layout-scoped reads see them redacted. Derived from the widget defs;
// heartbeat (the hand-rolled push widget) is merged in here.
export const SOURCE_FIELDS: Record<string, string[]> = {
  ...WIDGET_SOURCE_FIELDS,
  heartbeat: ["token_secret", "expect_every", "anchor", "grace"],
  log: [], // ingest-only; creation/removal is already sources-scope
};
const HEARTBEAT_SCHEDULE_FIELDS = ["expect_every", "anchor", "grace"];

// Legacy heartbeat auth: configs may still reference a PUSH_TOKEN_* Worker
// secret as a fallback lane; new tokens are D1 rows created in Settings.
export const PUSH_TOKEN_PATTERN = /^PUSH_TOKEN_[A-Z0-9_]+$/;

// Default display titles when a widget has no explicit title. Derived from
// the widget defs; heartbeat merged in.
export const DEFAULT_TITLES: Record<string, string> = {
  ...WIDGET_DEFAULT_TITLES,
  heartbeat: "Heartbeat",
  log: "Log",
};

// ---------- validation ----------

// Parse one raw widget outside a document (editor probes). Missing
// identity gets placeholder values - probe results are never persisted.
export function parseProbeWidget(raw: RawWidget, timezone?: string): WidgetConfig {
  return parseWidget({ id: "tmp_probe", name: "probe-widget", ...raw }, "probe", timezone);
}

function parseWidget(w: RawWidget, where: string, timezone?: string): WidgetConfig {
  const id = str(w.id, `${where}.id`);
  const name = str(w.name, `${where}.name`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${where}: name must be kebab-case`);
  let accent: string | undefined;
  if (typeof w.accent === "string" && w.accent.trim()) {
    const a = w.accent.trim();
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(a) && !/^[\d.]+ [\d.]+% [\d.]+%$/.test(a)) {
      throw new Error(`${where}: accent must be a hex color or an HSL triplet`);
    }
    accent = a;
  }
  const common = {
    id,
    name,
    title: typeof w.title === "string" && w.title.trim() ? w.title : (DEFAULT_TITLES[String(w.type)] ?? name),
    ...(typeof w.description === "string" && w.description.trim()
      ? { description: w.description.trim().slice(0, 140) }
      : {}),
    ...(accent ? { accent } : {}),
    ...(timezone ? { timezone } : {}),
  };
  if (w.type === "heartbeat") {
    const tokenSecret =
      w.token_secret === undefined || w.token_secret === "" ? undefined : str(w.token_secret, `${where}.token_secret`);
    if (tokenSecret && !PUSH_TOKEN_PATTERN.test(tokenSecret)) {
      throw new Error(`${where}: token_secret must reference a PUSH_TOKEN_* secret name`);
    }
    return {
      ...common,
      type: "heartbeat",
      refreshSeconds: 0,
      schedule: {
        intervalMs: parseInterval(w.expect_every, `${where}.expect_every`) * 1000,
        graceMs: parseInterval(w.grace, `${where}.grace`) * 1000,
        anchorMs: parseAnchor(typeof w.anchor === "string" ? w.anchor : "00:00"),
      },
      tokenSecret,
      history: Math.min(Math.max(1, Math.trunc(num(w.history ?? 10, `${where}.history`))), 30),
      fields: parseFields(w.fields, where),
    };
  }
  if (w.type === "log") {
    return {
      ...common,
      type: "log",
      refreshSeconds: 0,
      limit: Math.min(Math.max(1, Math.trunc(num(w.limit ?? 8, `${where}.limit`))), 30),
    };
  }
  const def = WIDGETS[String(w.type)];
  if (!def) {
    // Historical error precedence: an unknown type used to fall through to
    // the pull branch, which validated refresh_interval before the type
    // check - keep that exact behavior (and message) for callers that
    // surface these errors.
    parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    throw new Error(`${where}: unknown widget type "${String(w.type)}"`);
  }
  return def.parse(w, where, common, parseHelpers) as WidgetConfig;
}

// Curated built-in presets: selectable by pages as-is, or copied into an
// editable custom preset in the editor. Config presets shadow these on
// name collision. Appearance only - never title/logo/images.
export const BUILTIN_THEMES: Record<string, Partial<ThemeConfig>> = {
  nord: { background: "#2e3440", card: "#3b4252", border: "#4c566a", text: "#eceff4", muted: "#9fb0c9", accent: "#88c0d0", positive: "#a3be8c", negative: "#bf616a", font: "system" },
  "solarized-dark": { background: "#002b36", card: "#073642", border: "#586e75", text: "#93a1a1", muted: "#657b83", accent: "#268bd2", positive: "#859900", negative: "#dc322f", font: "system" },
  gruvbox: { background: "#282828", card: "#3c3836", border: "#504945", text: "#ebdbb2", muted: "#928374", accent: "#83a598", positive: "#b8bb26", negative: "#fb4934", font: "system" },
  catppuccin: { background: "#1e1e2e", card: "#313244", border: "#45475a", text: "#cdd6f4", muted: "#a6adc8", accent: "#89b4fa", positive: "#a6e3a1", negative: "#f38ba8", font: "rounded" },
  paper: { background: "#f6f5f1", card: "#ffffff", border: "#dcd9d0", text: "#24292f", muted: "#6e7781", accent: "#0b6bcb", positive: "#1a7f37", negative: "#cf222e", font: "serif" },
  terminal: { background: "#0c0c0c", card: "#161616", border: "#2e2e2e", text: "#d4d4d4", muted: "#8a8a8a", accent: "#4ec9b0", positive: "#6a9955", negative: "#f44747", font: "mono" },
};

// Parse a theme mapping with every field optional - used for the global
// theme (defaults applied by the caller) and for named presets.
export function parsePartialTheme(raw: unknown, where: string): Partial<ThemeConfig> {
  const themeRaw = (raw ?? {}) as Record<string, unknown>;
  const COLOR_OK = (x: string): boolean =>
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(x) || /^[\d.]+ [\d.]+% [\d.]+%$/.test(x);
  const optHsl = (v: unknown, name: string): string | undefined => {
    if (v === undefined || v === "") return undefined;
    if (typeof v !== "string" || !COLOR_OK(v)) {
      throw new Error(`config: ${where}.${name} must be a hex color like #16181d`);
    }
    return v;
  };
  const out: Partial<ThemeConfig> = {};
  const setIf = <K extends keyof ThemeConfig>(k: K, v: ThemeConfig[K] | undefined): void => {
    if (v !== undefined) out[k] = v;
  };
  setIf("accent", optHsl(themeRaw.accent, "accent"));
  setIf("positive", optHsl(themeRaw.positive, "positive"));
  setIf("negative", optHsl(themeRaw.negative, "negative"));
  setIf("background", optHsl(themeRaw.background, "background"));
  setIf("text", optHsl(themeRaw.text, "text"));
  setIf("muted", optHsl(themeRaw.muted, "muted"));
  setIf("card", optHsl(themeRaw.card, "card"));
  setIf("border", optHsl(themeRaw.border, "border"));
  if (themeRaw.max_width !== undefined && themeRaw.max_width !== "none" && themeRaw.max_width !== "") {
    const mw = Number(themeRaw.max_width);
    if (!Number.isInteger(mw) || mw < 480 || mw > 3840) {
      throw new Error(`config: ${where}.max_width must be an integer 480-3840 (px) or omitted`);
    }
    out.max_width = mw;
  }
  if (typeof themeRaw.title === "string" && themeRaw.title.trim()) {
    out.title = themeRaw.title.trim().slice(0, 40);
  }
  if (themeRaw.font !== undefined && themeRaw.font !== "") {
    if (!THEME_FONTS.includes(themeRaw.font as (typeof THEME_FONTS)[number])) {
      throw new Error(`config: ${where}.font must be one of ${THEME_FONTS.join(", ")}`);
    }
    out.font = themeRaw.font as ThemeConfig["font"];
  }
  if (themeRaw.font_size !== undefined && themeRaw.font_size !== "") {
    const fs = Number(themeRaw.font_size);
    if (!THEME_FONT_SIZES.includes(fs as (typeof THEME_FONT_SIZES)[number])) {
      throw new Error(`config: ${where}.font_size must be one of ${THEME_FONT_SIZES.join(", ")}`);
    }
    out.font_size = fs as ThemeConfig["font_size"];
  }
  if (themeRaw.title_size !== undefined && themeRaw.title_size !== "" && themeRaw.title_size !== "default") {
    if (!THEME_TITLE_SIZES.includes(themeRaw.title_size as (typeof THEME_TITLE_SIZES)[number])) {
      throw new Error(`config: ${where}.title_size must be one of ${THEME_TITLE_SIZES.join(", ")}`);
    }
    out.title_size = themeRaw.title_size as ThemeConfig["title_size"];
  }
  if (themeRaw.card_opacity !== undefined && themeRaw.card_opacity !== "") {
    const o = Number(themeRaw.card_opacity);
    if (!Number.isInteger(o) || o < 20 || o > 100) {
      throw new Error(`config: ${where}.card_opacity must be an integer 20-100`);
    }
    if (o !== 100) out.card_opacity = o;
  }
  if (themeRaw.radius !== undefined && themeRaw.radius !== "") {
    const rv = Number(themeRaw.radius);
    if (!THEME_RADII.includes(rv as (typeof THEME_RADII)[number])) {
      throw new Error(`config: ${where}.radius must be one of ${THEME_RADII.join(", ")}`);
    }
    out.radius = rv as ThemeConfig["radius"];
  }
  const assetRef = (v: unknown, name: string): string | undefined => {
    if (v === undefined || v === "") return undefined;
    if (typeof v !== "string") throw new Error(`config: ${where}.${name} must be a string`);
    const t = v.trim();
    if (t === "") return undefined;
    if (/^\/asset\/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/.test(t)) return t;
    try {
      const u = new URL(t);
      if (u.protocol !== "https:") throw new Error("x");
      // Stored refs are CANONICAL (URL.href: lowercased scheme/host, no
      // stray whitespace) so authorization checks can never be dodged by
      // a non-canonical spelling; CSS/HTML-significant characters are
      // rejected outright.
      if (/["'\\<>\s]/.test(u.href)) throw new Error("x");
      return u.href;
    } catch {
      throw new Error(`config: ${where}.${name} must be an uploaded /asset/ path or an https URL (no quotes/spaces/angle brackets)`);
    }
  };
  setIf("background_image", assetRef(themeRaw.background_image, "background_image"));
  setIf("logo", assetRef(themeRaw.logo, "logo"));
  setIf("favicon", assetRef(themeRaw.favicon, "favicon"));
  return out;
}

// Structural validation of a raw document whose widgets ALL carry ids.
// Returns both the normalized raw doc and the parsed runtime config.
export function validateDoc(raw: unknown): { doc: RawDoc; runtime: DashConfig } {
  if (typeof raw !== "object" || raw === null) throw new Error("config: expected mapping at top level");
  const r = raw as Record<string, unknown>;
  // Document timezone: the default zone for every time-bearing widget.
  // Absent means each widget falls back to its own default (UTC) exactly
  // as before, so existing documents are unaffected.
  let timezone: string | undefined;
  if (r.timezone !== undefined && r.timezone !== "") {
    const tz = str(r.timezone, "config.timezone").trim();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      throw new Error(`config.timezone: unknown timezone "${tz}" (use IANA names like America/New_York)`);
    }
    timezone = tz;
  }
  const themePartial = parsePartialTheme(r.theme, "theme");
  // Named presets: pages overlay one on the global theme.
  const themes: Record<string, Partial<ThemeConfig>> = {};
  if (r.themes !== undefined) {
    if (typeof r.themes !== "object" || r.themes === null || Array.isArray(r.themes)) {
      throw new Error("config: themes must be a mapping of preset name -> theme fields");
    }
    const entries = Object.entries(r.themes as Record<string, unknown>);
    if (entries.length > 10) throw new Error("config: at most 10 theme presets");
    for (const [name, val] of entries) {
      if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(name)) {
        throw new Error(`config: theme preset name "${name.slice(0, 30)}" must be kebab-case`);
      }
      const parsed = parsePartialTheme(val, `themes.${name}`);
      // Presets are appearance-only, matching the editor: image refs make
      // viewers contact external hosts, and activating a preset is a
      // layout-scope act. Reject rather than silently normalize — a save
      // must publish exactly the document it was given, or fail whole.
      if (parsed.background_image !== undefined || parsed.logo !== undefined || parsed.favicon !== undefined) {
        throw new Error(
          `config: themes.${name}: presets are appearance-only — background_image, logo, and favicon belong on the global theme`,
        );
      }
      themes[name] = parsed;
    }
  }
  if (!Array.isArray(r.pages) || r.pages.length === 0) throw new Error("config: pages required");

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const widgets: WidgetConfig[] = [];
  const docPages: RawDoc["pages"] = [];
  const LEGACY_WIDTHS: Record<string, ColumnWidth> = { narrow: "1/4", wide: "3/4" };
  const pages: PageConfig[] = (r.pages as unknown[]).map((p, pi) => {
    const page = p as Record<string, unknown>;
    const pname = str(page.name, `pages[${pi}].name`);
    // Legacy shape (pages → columns) normalizes to a single row.
    const rowsRaw = Array.isArray(page.rows)
      ? (page.rows as unknown[])
      : Array.isArray(page.columns)
        ? [{ columns: page.columns }]
        : null;
    if (!rowsRaw || rowsRaw.length === 0) throw new Error(`pages[${pi}]: rows required`);
    const docRows: RawDoc["pages"][number]["rows"] = [];
    const rows: RowConfig[] = rowsRaw.map((rv, ri) => {
      const row = rv as Record<string, unknown>;
      if (!Array.isArray(row.columns)) throw new Error(`pages[${pi}].rows[${ri}]: columns required`);
      const rowTitle =
        typeof row.title === "string" && row.title.trim() ? row.title.trim().slice(0, 60) : undefined;
      const rowName =
        typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 24) : undefined;
      let rowHeight: ColumnWidth | undefined;
      if (row.height !== undefined && row.height !== "auto") {
        if (typeof row.height !== "string" || !(row.height in COLUMN_SPANS)) {
          throw new Error(
            `pages[${pi}].rows[${ri}]: height must be one of ${Object.keys(COLUMN_SPANS).join(", ")} or omitted`,
          );
        }
        rowHeight = row.height as ColumnWidth;
      }
      const docCols: RawDoc["pages"][number]["rows"][number]["columns"] = [];
      const columns: ColumnConfig[] = (row.columns as unknown[]).map((c, ci) => {
        const col = c as Record<string, unknown>;
        const rawWidth = typeof col.width === "string" ? col.width : "full";
        const width = (LEGACY_WIDTHS[rawWidth] ?? rawWidth) as ColumnWidth;
        const colTitle =
          typeof col.title === "string" && col.title.trim() ? col.title.trim().slice(0, 60) : undefined;
        if (!(width in COLUMN_SPANS)) {
          throw new Error(
            `pages[${pi}].rows[${ri}].columns[${ci}]: width must be one of ${Object.keys(COLUMN_SPANS).join(", ")}`,
          );
        }
        if (!Array.isArray(col.widgets)) throw new Error(`pages[${pi}].rows[${ri}].columns[${ci}]: widgets required`);
        const rawWidgets: RawWidget[] = [];
        const ws = (col.widgets as unknown[]).map((wv, wi) => {
          const where = `pages[${pi}].rows[${ri}].columns[${ci}].widgets[${wi}]`;
          if (typeof wv !== "object" || wv === null) throw new Error(`${where}: expected widget object`);
          const rawW = { ...(wv as RawWidget) };
          const widget = parseWidget(rawW, where, timezone);
          if (seenIds.has(widget.id)) throw new Error(`duplicate widget id "${widget.id}"`);
          if (seenNames.has(widget.name)) throw new Error(`duplicate widget name "${widget.name}"`);
          seenIds.add(widget.id);
          seenNames.add(widget.name);
          widgets.push(widget);
          rawWidgets.push(rawW);
          return widget;
        });
        docCols.push({ width, ...(colTitle ? { title: colTitle } : {}), widgets: rawWidgets });
        return { width, title: colTitle, widgets: ws };
      });
      const rowFill = row.fill !== false;
      docRows.push({ ...(rowName ? { name: rowName } : {}), ...(rowTitle ? { title: rowTitle } : {}), ...(rowHeight ? { height: rowHeight } : {}), ...(rowFill ? {} : { fill: false }), columns: docCols });
      return { name: rowName, title: rowTitle, height: rowHeight, fill: rowFill, columns };
    });
    const fit = page.fit_screen === true;
    const publicView = page.public === true;
    const hidden = page.hidden === true;
    const indexable = publicView && page.indexable === true;
    const description =
      typeof page.description === "string" && page.description.trim()
        ? page.description.trim().slice(0, 160)
        : undefined;
    let pageTheme: string | undefined;
    if (page.theme !== undefined && page.theme !== "") {
      if (typeof page.theme !== "string" || !(page.theme in themes || page.theme in BUILTIN_THEMES)) {
        throw new Error(
          `pages[${pi}]: theme must name a preset (custom: ${Object.keys(themes).join(", ") || "none"}; built-in: ${Object.keys(BUILTIN_THEMES).join(", ")})`,
        );
      }
      pageTheme = page.theme;
    }
    docPages.push({
      name: pname,
      ...(fit ? { fit_screen: true } : {}),
      ...(publicView ? { public: true } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(indexable ? { indexable: true } : {}),
      ...(description ? { description } : {}),
      ...(pageTheme ? { theme: pageTheme } : {}),
      rows: docRows,
    });
    return { name: pname, fit, publicView, indexable, description, hidden, theme: pageTheme, rows };
  });
  // No injected color defaults: absent colors fall through to the
  // scheme-aware CSS fallbacks, which differ between light and dark to
  // keep WCAG contrast. A single baked value can't satisfy both schemes.
  const theme: ThemeConfig = { ...themePartial };
  return {
    doc: {
      theme,
      ...(Object.keys(themes).length ? { themes } : {}),
      ...(timezone ? { timezone } : {}),
      pages: docPages,
    },
    runtime: { theme, themes, timezone, pages, widgets },
  };
}

export function docWidgets(doc: RawDoc): RawWidget[] {
  return doc.pages.flatMap((p) => p.rows.flatMap((r) => r.columns.flatMap((c) => c.widgets)));
}

// ---------- id discipline ----------

export function newInstanceId(): string {
  const buf = crypto.getRandomValues(new Uint8Array(6));
  return `w_${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Instance ids are server-owned: widgets carrying an id must reference one
// issued in the caller's base version; widgets without an id are new and
// get one assigned here. Returns ids of newly created widgets.
export function enforceIdDiscipline(
  candidate: unknown,
  baseIds: Set<string>,
  historicalIds?: Set<string>,
): string[] {
  if (typeof candidate !== "object" || candidate === null) throw new Error("config: expected mapping");
  const pages = (candidate as Record<string, unknown>).pages;
  if (!Array.isArray(pages)) throw new Error("config: pages required");
  const created: string[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const pr = p as Record<string, unknown>;
    const rows = Array.isArray(pr?.rows) ? pr.rows : Array.isArray(pr?.columns) ? [{ columns: pr.columns }] : [];
    const cols = (rows as { columns?: unknown[] }[]).flatMap((row) =>
      Array.isArray(row?.columns) ? row.columns : [],
    );
    for (const c of cols) {
      const ws = (c as Record<string, unknown>)?.widgets;
      if (!Array.isArray(ws)) continue;
      for (const wv of ws) {
        if (typeof wv !== "object" || wv === null) continue;
        const w = wv as RawWidget;
        if (w.id !== undefined) {
          const id = String(w.id);
          if (!baseIds.has(id) && !historicalIds?.has(id)) {
            throw new Error(`unknown widget id "${id}" - ids are server-assigned`);
          }
          if (seen.has(id)) throw new Error(`duplicate widget id "${id}"`);
          seen.add(id);
        } else {
          const id = newInstanceId();
          w.id = id;
          created.push(id);
        }
      }
    }
  }
  return created;
}

// ---------- semantic diff ----------

export interface ConfigDiff {
  createdIds: string[];
  removedIds: string[];
  sourceChangedIds: string[]; // pull widgets whose source fields changed (or type changed)
  scheduleChangedIds: string[]; // heartbeats whose schedule fields changed
  needsSources: string[]; // human-readable reasons requiring config:sources
}

function widgetDisplay(w: RawWidget): string {
  return String(w.title ?? DEFAULT_TITLES[String(w.type)] ?? w.name ?? "widget");
}

export function classifyDiff(base: RawDoc, next: RawDoc): ConfigDiff {
  const baseBy = new Map(docWidgets(base).map((w) => [String(w.id), w]));
  const nextBy = new Map(docWidgets(next).map((w) => [String(w.id), w]));
  const diff: ConfigDiff = {
    createdIds: [],
    removedIds: [],
    sourceChangedIds: [],
    scheduleChangedIds: [],
    needsSources: [],
  };
  for (const [id, w] of nextBy) {
    const b = baseBy.get(id);
    if (!b) {
      diff.createdIds.push(id);
      diff.needsSources.push(`create widget "${widgetDisplay(w)}"`);
      continue;
    }
    if (b.type !== w.type) {
      diff.sourceChangedIds.push(id);
      diff.needsSources.push(`change type of "${widgetDisplay(w)}"`);
      continue;
    }
    const fields = SOURCE_FIELDS[String(w.type)] ?? [];
    const changed = fields.filter((f) => JSON.stringify(b[f]) !== JSON.stringify(w[f]));
    if (changed.length > 0) {
      diff.needsSources.push(`change ${changed.join(",")} on "${widgetDisplay(w)}"`);
      if (w.type === "heartbeat") {
        if (changed.some((f) => HEARTBEAT_SCHEDULE_FIELDS.includes(f))) diff.scheduleChangedIds.push(id);
      } else {
        diff.sourceChangedIds.push(id);
      }
    }
    // Conditionally source-bearing fields (e.g. bookmark links while
    // third-party favicons are enabled) - authorization only, no cache
    // effects.
    const extraFields = WIDGET_EXTRA_SOURCE_FIELDS[String(w.type)]?.(b, w) ?? [];
    const extraChanged = extraFields.filter(
      (f) => !fields.includes(f) && JSON.stringify(b[f]) !== JSON.stringify(w[f]),
    );
    if (extraChanged.length > 0) {
      diff.needsSources.push(`change ${extraChanged.join(",")} on "${widgetDisplay(w)}"`);
    }
    // Pull schedules carry upstream-traffic authority: changing how often
    // a third party is fetched requires config:sources, without treating
    // it as a source change (no cache clear, and it stays readable).
    if (
      WIDGETS[String(w.type)]?.fetchData &&
      JSON.stringify(b.refresh_interval) !== JSON.stringify(w.refresh_interval)
    ) {
      diff.needsSources.push(`change refresh_interval on "${widgetDisplay(w)}"`);
    }
  }
  for (const [id, b] of baseBy) {
    if (!nextBy.has(id)) {
      diff.removedIds.push(id);
      diff.needsSources.push(`remove widget "${widgetDisplay(b)}"`);
    }
  }
  // External image URLs make every viewer's browser call that host on each
  // pageview - changing them is a sources-scope decision. Uploaded /asset/
  // paths are same-origin and stay layout-scope.
  // Externality is decided by URL PARSING, not a string prefix — a
  // non-canonical spelling must never dodge authorization. (Stored refs
  // are canonical via assetRef, so this is belt-and-suspenders for docs
  // that predate canonicalization.)
  const externalOrigin = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t.startsWith("/asset/")) return null;
    try {
      const u = new URL(t);
      return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  for (const key of ["background_image", "logo", "favicon"] as const) {
    const b = base.theme?.[key];
    const n = next.theme?.[key];
    const origin = externalOrigin(n);
    if (origin && n !== b) {
      diff.needsSources.push(`load theme ${key} from ${origin}`);
    }
    for (const [pname, preset] of Object.entries(next.themes ?? {})) {
      const bp = base.themes?.[pname]?.[key];
      const np = preset[key];
      const porigin = externalOrigin(np);
      if (porigin && np !== bp) {
        diff.needsSources.push(`load ${key} from ${porigin} (preset ${pname})`);
      }
    }
  }
  // Exposure is a sources-scope decision: turning a page public lets
  // anyone read what its widgets display. Making it private again is not.
  const basePublic = new Set(base.pages.filter((pg) => pg.public === true).map((pg) => pg.name));
  const baseIndexable = new Set(base.pages.filter((pg) => pg.indexable === true).map((pg) => pg.name));
  for (const pg of next.pages) {
    if (pg.indexable === true && !baseIndexable.has(pg.name)) {
      diff.needsSources.push(`allow search indexing of page "${pg.name}"`);
    }
  }
  for (const pg of next.pages) {
    if (pg.public === true && !basePublic.has(pg.name)) {
      diff.needsSources.push(`make page "${pg.name}" public`);
    }
  }
  return diff;
}

// Scope-filtered read projection: layout-only tokens never see source values.
export function redactDoc(doc: RawDoc): RawDoc {
  const clone = JSON.parse(JSON.stringify(doc)) as RawDoc;
  for (const w of docWidgets(clone)) {
    // static source fields plus conditionally source-bearing ones for this
    // widget's current configuration (e.g. bookmark links while favicons
    // are enabled) — classifyDiff and redaction must agree on the set
    const fields = new Set([
      ...(SOURCE_FIELDS[String(w.type)] ?? []),
      ...(WIDGET_EXTRA_SOURCE_FIELDS[String(w.type)]?.(w, w) ?? []),
    ]);
    for (const f of fields) {
      if (w[f] !== undefined) w[f] = "[redacted]";
    }
  }
  return clone;
}

// Inverse of redactDoc for layout-scoped read-modify-write: "[redacted]"
// sentinels are restored from the base document, matched by immutable
// widget id with an unchanged type. Sentinels anywhere they cannot be
// restored (new widgets, changed types, fields absent in base) are
// rejected — a sentinel must never reach validation or publish.
export function unredactDoc(
  candidate: unknown,
  baseDoc: RawDoc,
): { ok: true; doc: unknown } | { ok: false; error: string } {
  const clone = JSON.parse(JSON.stringify(candidate)) as Record<string, unknown>;
  const baseBy = new Map(docWidgets(baseDoc).map((w) => [String(w.id), w]));
  const pages = Array.isArray(clone.pages) ? clone.pages : [];
  for (const pv of pages) {
    const page = pv as Record<string, unknown>;
    const rows = Array.isArray(page.rows) ? page.rows : [];
    for (const rv of rows) {
      const cols = Array.isArray((rv as Record<string, unknown>).columns)
        ? ((rv as Record<string, unknown>).columns as unknown[])
        : [];
      for (const cv of cols) {
        const ws = Array.isArray((cv as Record<string, unknown>).widgets)
          ? ((cv as Record<string, unknown>).widgets as RawWidget[])
          : [];
        for (const w of ws) {
          for (const [k, v] of Object.entries(w)) {
            if (v !== "[redacted]") continue;
            const b = w.id !== undefined ? baseBy.get(String(w.id)) : undefined;
            const label = String(w.title ?? w.name ?? w.type ?? "widget");
            if (!b) return { ok: false, error: `"${label}": redacted ${k} on a widget not in the base version — supply a real value` };
            if (b.type !== w.type) return { ok: false, error: `"${label}": redacted ${k} with a changed type — supply a real value` };
            if (!(k in b)) return { ok: false, error: `"${label}": redacted ${k} does not exist in the base version` };
            w[k] = JSON.parse(JSON.stringify(b[k]));
          }
        }
      }
    }
  }
  return { ok: true, doc: clone };
}

// ---------- YAML boundaries ----------

export function docToYaml(doc: RawDoc): string {
  return stringifyYaml(doc);
}

export function yamlToRaw(text: string): unknown {
  return parseYaml(text);
}

export function seedRaw(): unknown {
  return parseYaml(seedText);
}

// ---------- loader ----------

interface CurrentConfig {
  version: number;
  doc: RawDoc;
  runtime: DashConfig;
}

let cache: CurrentConfig | undefined;

export async function getCurrentConfig(env: Env): Promise<CurrentConfig> {
  const ptr = await env.DB
    .prepare("SELECT version FROM config_pointer WHERE id = 1")
    .first<{ version: number }>();
  if (!ptr) {
    const { ensureSeed } = await import("./configstore");
    await ensureSeed(env);
    return getCurrentConfig(env);
  }
  if (cache && cache.version === ptr.version) return cache;
  const row = await env.DB
    .prepare("SELECT doc FROM config_versions WHERE version = ?1")
    .bind(ptr.version)
    .first<{ doc: string }>();
  if (!row) throw new Error(`config version ${ptr.version} missing`);
  const { doc, runtime } = validateDoc(JSON.parse(row.doc));
  cache = { version: ptr.version, doc, runtime };
  return cache;
}

export async function getConfig(env: Env): Promise<DashConfig> {
  return (await getCurrentConfig(env)).runtime;
}
