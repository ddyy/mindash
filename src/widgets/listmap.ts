import type { RawWidget, ParseHelpers } from "./def";
import { html, safeUrl, type SafeHtml } from "../html";

// Dot-path resolution lives HERE (the leaf) rather than json-api so no
// import cycle forms: json-api, mcp, image, and scrape all sit above
// this module.
const MAX_DEPTH = 12;
export function resolvePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  const parts = path.split(".");
  if (parts.length > MAX_DEPTH) return undefined;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

// Declarative list mapping shared by the mcp and json-api widgets: point
// at an array anywhere in the response and bind each item's title / url /
// meta slots with paths relative to the item. Config chooses which
// hand-written renderer runs and what fills its slots - never markup.
//
// Raw config keys:
//   items:      dot-path to the array ("." = the response root)
//   item_title: path within each item (required)
//   item_url:   optional path within each item
//   item_meta:  optional path within each item (muted second line)

export interface ListSpec {
  items: string;
  title: string;
  url?: string;
  meta?: string;
}

export interface ListRow {
  title: string;
  url?: string;
  meta?: string;
}

const PATH_RE = /^[A-Za-z0-9_.-]+$/;

export function parseListSpec(w: RawWidget, where: string, h: ParseHelpers): ListSpec | undefined {
  if (w.items === undefined && w.item_title === undefined) return undefined;
  const items = h.str(w.items, `${where}.items`);
  if (items !== "." && !PATH_RE.test(items)) throw new Error(`${where}.items: bad path`);
  const title = h.str(w.item_title, `${where}.item_title`);
  const rel = (key: string): string | undefined => {
    const v = (w as Record<string, unknown>)[key];
    if (v === undefined || v === "") return undefined;
    const p = h.str(v, `${where}.${key}`);
    if (!PATH_RE.test(p)) throw new Error(`${where}.${key}: bad path`);
    return p;
  };
  if (!PATH_RE.test(title)) throw new Error(`${where}.item_title: bad path`);
  return { items, title, url: rel("item_url"), meta: rel("item_meta") };
}

function display(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v.length > 140 ? `${v.slice(0, 140)}…` : v;
  if (typeof v === "number") return Math.abs(v) >= 10000 ? v.toLocaleString("en-US") : String(v);
  if (typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 140);
}

export function extractList(root: unknown, spec: ListSpec, limit = 12): ListRow[] {
  const arr = spec.items === "." ? root : resolvePath(root, spec.items);
  if (!Array.isArray(arr)) return [];
  const rows: ListRow[] = [];
  for (const item of arr.slice(0, limit)) {
    if (item === null || typeof item !== "object") continue;
    const title = display(resolvePath(item, spec.title));
    if (!title) continue;
    const urlRaw = spec.url ? resolvePath(item, spec.url) : undefined;
    rows.push({
      title,
      url: typeof urlRaw === "string" ? urlRaw : undefined,
      meta: spec.meta ? display(resolvePath(item, spec.meta)) : undefined,
    });
  }
  return rows;
}

export function renderList(rows: ListRow[]): SafeHtml {
  if (rows.length === 0) return html`<p class="empty">No items matched the list mapping.</p>`;
  return html`<ul class="feed">
    ${rows.map(
      (r) => html`<li>
        ${r.url ? html`<a href="${safeUrl(r.url)}" rel="noreferrer">${r.title}</a>` : html`${r.title}`}
        ${r.meta ? html`<span class="meta">${r.meta}</span>` : null}
      </li>`,
    )}
  </ul>`;
}

// Shared form fields (advanced) for widgets that support the mapping.
export const LIST_FIELDS = [
  {
    key: "items",
    label: "List: array path",
    kind: "text" as const,
    advanced: true,
    placeholder: "products",
    help: 'Dot-path to an array in the response ("." = the root). Setting this switches the card to a mapped list.',
  },
  { key: "item_title", label: "List: item title path", kind: "text" as const, advanced: true, placeholder: "name" },
  { key: "item_url", label: "List: item link path", kind: "text" as const, advanced: true, placeholder: "url" },
  { key: "item_meta", label: "List: item meta path", kind: "text" as const, advanced: true, placeholder: "price.amount" },
];
