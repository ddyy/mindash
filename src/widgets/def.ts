import type { SafeHtml } from "../html";
import { CREDENTIAL_NAME } from "../vault";

// The single-file widget contract. Each widget module in this directory
// exports `def: WidgetDef` - config validation, editor form, source-field
// authority, fetch/render, and (via a sibling .css text module) styles -
// and src/widgets/index.ts derives every registry/map from the manifest.
// Widget files import ONLY from this module and the leaf helpers
// (html/safefetch/vault/markdown/shared/sibling widgets) - never
// from config.ts; config.ts imports from widgets/.

// ---------- shared runtime/raw types ----------

export interface WidgetCommon {
  id: string;
  name: string;
  type: string;
  title: string;
  description?: string; // muted line under the card title
  refreshSeconds: number;
  accent?: string; // hex or HSL triplet; per-card accent override
  // Takes the leftover vertical space in its column. Opt-in: without
  // it a card is its natural height, so one marked card absorbs the
  // slack instead of every card stretching a little.
  expand?: boolean;
  // The document's timezone, carried to every widget so time-bearing ones
  // (clock, countdown, calendar) inherit it instead of each defaulting to
  // UTC. A widget's own zone field still wins.
  timezone?: string;
}

export interface FieldSpec {
  label: string;
  path: string; // dot path into the JSON payload/response, e.g. "data.count"
}

export type RawWidget = Record<string, unknown>;

// Identity already resolved by the document validator (id discipline,
// kebab-case name, title defaulting) before a widget's parse runs.
export interface WidgetCommonInit {
  id: string;
  name: string;
  title: string;
  description?: string;
  timezone?: string; // document default zone (see WidgetCommon.timezone)
}

// ---------- editor form descriptors ----------

export interface FieldDesc {
  key: string;
  label: string;
  kind: "text" | "number" | "url" | "interval" | "anchor" | "select" | "secret" | "connection" | "fieldmap" | "geosearch" | "timezone" | "clocklist" | "json" | "linklist" | "textarea" | "strlist" | "upload" | "color" | "checkbox";
  required?: boolean;
  placeholder?: string;
  options?: string[];
  advanced?: boolean;
  help?: string;
  prefill?: string; // applied on gallery add (unlike placeholder, which is only a hint)
  rows?: number; // textarea height (defaults to 5)
  search?: "coins" | "stocks" | "youtube"; // strlist: attach a remote search picker
}

export interface WidgetFormDesc {
  type: string;
  title: string;
  icon?: string;
  category: "Personal" | "Feeds" | "Monitoring" | "Display" | "Markets";
  description: string;
  requirements?: string;
  fields: FieldDesc[];
}

// Shared leading field prepended to every widget's form by the derivation.
export const COMMON_FIELDS: FieldDesc[] = [
  { key: "title", label: "Title", kind: "text", placeholder: "Card heading (defaults per widget type)" },
  { key: "description", label: "Description", kind: "textarea", rows: 3, placeholder: "Optional line under the title" },
  {
    key: "expand",
    label: "Expand to fill the column",
    kind: "checkbox",
    advanced: true,
    help: "Takes the leftover height in this column. Leave it off and the card keeps its natural size.",
  },
  {
    key: "accent",
    label: "Accent color",
    kind: "color",
    advanced: true,
    help: "Overrides the theme accent for this card only: title, links, spinner. Empty = inherit.",
  },
];

// ---------- parse helpers ----------

const INTERVAL_RE = /^(\d+)([smhd])$/;
const INTERVAL_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseInterval(raw: unknown, where: string): number {
  if (typeof raw !== "string") throw new Error(`${where}: expected an interval string like "15m" (s, m, h, or d)`);
  const m = INTERVAL_RE.exec(raw);
  const unit = m ? INTERVAL_UNIT[m[2] ?? ""] : undefined;
  if (!m || unit === undefined) throw new Error(`${where}: bad interval "${raw}"`);
  const secs = Number(m[1]) * unit;
  if (secs < 60) throw new Error(`${where}: interval below 60s`);
  return secs;
}

export function str(v: unknown, where: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`${where}: expected non-empty string`);
  return v;
}

export function num(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where}: expected number`);
  return v;
}

// Comma/space separated list, or an array of strings; validated per item.
export function strList(raw: unknown, where: string, pattern: RegExp, max: number): string[] {
  let items: string[];
  if (Array.isArray(raw)) items = raw.map((x) => String(x).trim()).filter(Boolean);
  else if (typeof raw === "string") items = raw.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  else if (raw === undefined) items = [];
  else throw new Error(`${where}: expected a list`);
  if (items.length > max) throw new Error(`${where}: at most ${max} entries`);
  for (const it of items) {
    if (!pattern.test(it)) throw new Error(`${where}: bad entry "${it.slice(0, 20)}"`);
  }
  return items;
}

export function parseFields(raw: unknown, where: string): FieldSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}: fields must be a list of {label, path}`);
  if (raw.length > 12) throw new Error(`${where}: at most 12 fields`);
  return raw.map((f, i) => {
    const o = f as Record<string, unknown>;
    const path = str(o?.path, `${where}.fields[${i}].path`);
    if (!/^[A-Za-z0-9_.-]+$/.test(path)) throw new Error(`${where}.fields[${i}]: bad path`);
    // Label is optional: derive from the last meaningful path segment -
    // numeric indices and generic container names carry no information
    // ("items.0.story_title" -> "Story title"; "result.0.text" -> "Result";
    // a fully generic path gets no label and the value spans the row).
    const GENERIC = new Set(["text", "value", "data", "content", "result", "results", "item", "items", "body"]);
    const meaningful = path
      .split(".")
      .filter((x) => !/^[0-9]+$/.test(x) && !GENERIC.has(x.toLowerCase()));
    const seg = meaningful.pop() ?? "";
    const derived = seg.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
    const label =
      typeof o?.label === "string" && o.label.trim() ? o.label.trim() : derived;
    return { label, path };
  });
}

// Save-time shape check only - existence and the type/origin binding are
// enforced at fetch time by the vault (which holds env and the rows).
function credentialName(v: unknown, where: string): string {
  const s = str(v, where);
  if (!CREDENTIAL_NAME.test(s)) throw new Error(`${where}: credential names are kebab-case (a-z, 0-9, dashes)`);
  return s;
}

export interface ParseHelpers {
  str: typeof str;
  num: typeof num;
  parseInterval: typeof parseInterval;
  parseFields: typeof parseFields;
  strList: typeof strList;
  credentialName: typeof credentialName;
}

export const parseHelpers: ParseHelpers = { str, num, parseInterval, parseFields, strList, credentialName };

// ---------- the widget definition ----------

export interface WidgetDef<C extends WidgetCommon = any, D = unknown> {
  meta: {
    title: string; // gallery title
    icon?: string; // emoji shown in the gallery and structure view
    // Default display title when a widget has no explicit title; falls
    // back to `title` (the gallery label) when omitted.
    defaultTitle?: string;
    category: WidgetFormDesc["category"];
    description: string;
    requirements?: string;
  };
  sourceFields: string[]; // raw-doc field names carrying fetch/credential authority
  // Fields that become source-bearing only in certain configurations
  // (e.g. bookmark links once third-party favicons are enabled). Called
  // with the base and next RAW widgets during diff classification.
  extraSourceFields?(base: RawWidget | undefined, next: RawWidget): string[];
  form: FieldDesc[]; // the fields AFTER the shared title field (derivation prepends COMMON_FIELDS)
  // Validation: returns the full runtime config. `common` carries id/name/
  // title already resolved.
  parse(raw: RawWidget, where: string, common: WidgetCommonInit, h: ParseHelpers): C;
  fetchData?(cfg: C, env: Env): Promise<D>; // present ⇒ pull widget
  render?(data: D, cfg: C): SafeHtml; // pull widgets
  renderStatic?(cfg: C): SafeHtml; // static widgets: card BODY only (shell built centrally)
  css?: string; // imported from the sibling .css file
  liveScript?: boolean; // widget needs /clock.js ticking (clock, countdown)
  // Extra class on the central <section class="widget …"> shell; defaults
  // to the type id. Empty string opts out (iframe renders bare "widget").
  sectionClass?: string;
  cspOrigins?(cfg: C): { frame?: string[]; form?: string[] }; // iframe frame-src, search form-action
}
