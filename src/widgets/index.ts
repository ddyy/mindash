import type { PullWidgetConfig } from "../config";
import type { SafeHtml } from "../html";
import { type RawWidget, COMMON_FIELDS, PAUSE_FIELD, type WidgetDef, type WidgetFormDesc } from "./def";
import { def as rss } from "./rss";
import { def as weather } from "./weather";
import { def as hackernews } from "./hackernews";
import { def as jsonApi } from "./json-api";
import { def as mcp } from "./mcp";
import { def as crypto } from "./crypto";
import { def as stocks } from "./stocks";
import { def as iframe } from "./iframe";
import { def as clock } from "./clock";
import { def as countdown } from "./countdown";
import { def as bookmarks } from "./bookmarks";
import { def as search } from "./search";
import { def as note } from "./note";
import { def as calendar } from "./calendar";
import { def as image } from "./image";
import { def as youtube } from "./youtube";
import { def as monitor } from "./monitor";
import { def as scrape } from "./scrape";

// The widget manifest: every widget type (except the hand-rolled push
// widget, heartbeat) is one self-describing def file in this directory.
// Everything else - validation dispatch, source-field authority, default
// titles, editor forms, per-widget CSS, the pull-refresh module registry -
// is derived from this map.
export const WIDGETS: Record<string, WidgetDef> = {
  rss,
  weather,
  hackernews,
  "json-api": jsonApi,
  mcp,
  crypto,
  stocks,
  iframe,
  clock,
  countdown,
  bookmarks,
  search,
  note,
  calendar,
  image,
  youtube,
  monitor,
  scrape,
};

export interface WidgetModule {
  fetchData(cfg: PullWidgetConfig, env: Env): Promise<unknown>;
  batch?: {
    groupKey(cfg: PullWidgetConfig): string;
    maxBatchSize?: number;
    fetch(configs: readonly PullWidgetConfig[], env: Env): Promise<Map<string, unknown>>;
  };
  render(data: unknown, cfg: PullWidgetConfig): SafeHtml;
}

// Each def is written against its own narrowed config/data types; the
// registry view erases them behind WidgetModule. Config validation
// guarantees cfg matches the def keyed by its type, and data round-trips
// through the def's own fetchData. Push widgets (heartbeat) render from D1
// instead - see src/push/heartbeat.ts.
export function getModule(type: PullWidgetConfig["type"]): WidgetModule {
  return WIDGETS[type] as unknown as WidgetModule;
}

// Fields that carry source/credential authority, per type (config.ts
// merges heartbeat's entry).
export const WIDGET_SOURCE_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(WIDGETS).map(([type, def]) => [type, def.sourceFields]),
);

// Conditionally source-bearing fields (see WidgetDef.extraSourceFields).
export const WIDGET_EXTRA_SOURCE_FIELDS: Record<
  string,
  ((base: RawWidget | undefined, next: RawWidget) => string[]) | undefined
> = Object.fromEntries(Object.entries(WIDGETS).map(([type, def]) => [type, def.extraSourceFields?.bind(def)]));

// Which types may hold a vault credential - DERIVED, not declared. A
// type is eligible exactly when its form asks for a secret, because that
// field IS the declaration: a def that offers no credential picker has
// nothing to bind one to. This used to be a literal list in vault.ts,
// which was the same three names written twice and drifted once already
// (crypto gained a secret field before the list heard about it). It also
// meant a custom widget could not use the vault without editing a core
// file it does not own.
export const CREDENTIAL_WIDGET_TYPES: string[] = Object.entries(WIDGETS)
  .filter(([, def]) => def.form.some((f) => f.kind === "secret"))
  .map(([type]) => type)
  .sort();

// Default display titles when a widget has no explicit title.
export const WIDGET_DEFAULT_TITLES: Record<string, string> = Object.fromEntries(
  Object.entries(WIDGETS).map(([type, def]) => [type, def.meta.defaultTitle ?? def.meta.title]),
);

// The editor gallery's display order (heartbeat's hand-written descriptor
// is spliced in by widgetforms.ts).
const GALLERY_ORDER = [
  "rss",
  "youtube",
  "weather",
  "calendar",
  "hackernews",
  "monitor",
  "json-api",
  "scrape",
  "crypto",
  "stocks",
  "mcp",
  "bookmarks",
  "search",
  "note",
  "clock",
  "countdown",
  "iframe",
];

// Editor form descriptors, derived from the defs: shared title field
// first, then the def's own fields.
export function widgetFormsFromDefs(): WidgetFormDesc[] {
  // Manifest types missing from GALLERY_ORDER still appear (appended at
  // the end) - a forgotten entry must degrade to wrong position, never to
  // an invisible widget.
  const ordered = [...GALLERY_ORDER, ...Object.keys(WIDGETS).filter((t) => !GALLERY_ORDER.includes(t))];
  return ordered.map((type) => {
    const def = WIDGETS[type];
    if (!def) throw new Error(`gallery order names unknown widget type "${type}"`);
    return {
      type,
      title: def.meta.title,
      ...(def.meta.icon !== undefined ? { icon: def.meta.icon } : {}),
      category: def.meta.category,
      description: def.meta.description,
      ...(def.meta.requirements !== undefined ? { requirements: def.meta.requirements } : {}),
      // Pause is offered only where there is a schedule to pause.
      fields: [...COMMON_FIELDS, ...(def.fetchData ? [PAUSE_FIELD] : []), ...def.form],
    };
  });
}

// Per-widget CSS, appended to the global stylesheet by src/styles.ts.
export const WIDGET_CSS: string = Object.values(WIDGETS)
  .map((def) => def.css ?? "")
  .join("");
