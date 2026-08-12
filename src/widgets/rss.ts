import type { WidgetCommon, WidgetDef } from "./def";
import { html, safeUrl, type SafeHtml } from "../html";
import { safeFetchText } from "../safefetch";
import { relativeTime } from "./shared";

export interface RssWidget extends WidgetCommon {
  type: "rss";
  urls: string[]; // one or more feeds, merged by date
  limit: number;
}

export interface RssData {
  items: { title: string; link: string; published?: string; source?: string }[];
}

const MAX_ITEM_SCAN = 50;

// Entity decoding: numeric (&#8217; / &#x2019;) plus the named entities
// that actually show up in feed titles. Decoded text is plain data - the
// render layer escapes it again, so decoding "<" here can never become
// markup. Two passes so double-encoded feeds (&amp;#8217;) come out right.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: "\u00a0", mdash: "-", ndash: "\u2013",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  hellip: "\u2026", middot: "\u00b7", bull: "\u2022", deg: "\u00b0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  euro: "\u20ac", pound: "\u00a3", cent: "\u00a2",
  laquo: "\u00ab", raquo: "\u00bb", times: "\u00d7", sect: "\u00a7",
};
export function decodeEntities(text: string): string {
  const pass = (x: string): string =>
    x.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ent: string) => {
      if (ent.startsWith("#")) {
        const hex = ent[1] === "x" || ent[1] === "X";
        const cp = parseInt(ent.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
      }
      return NAMED_ENTITIES[ent.toLowerCase()] ?? whole;
    });
  return pass(pass(text));
}

// Deliberately small text-level extraction: items become plain strings here
// and are escaped again at render time. No HTML from the feed survives.
function textOf(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return undefined;
  let t = (m[1] ?? "").trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t);
  if (cdata) t = (cdata[1] ?? "").trim();
  return decodeEntities(t.replace(/<[^>]+>/g, "")).trim();
}

function atomLink(block: string): string | undefined {
  const alt = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block);
  if (alt) return alt[1];
  const any = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
  return any?.[1];
}

export function parseFeed(xml: string, limit: number): RssData {
  const items: RssData["items"] = [];
  const re = /<(item|entry)[\s>][\s\S]*?<\/\1>/gi;
  let scanned = 0;
  for (const m of xml.matchAll(re)) {
    if (items.length >= limit || ++scanned > MAX_ITEM_SCAN) break;
    const block = m[0];
    const title = textOf(block, "title");
    if (!title) continue;
    const link = m[1]?.toLowerCase() === "entry" ? atomLink(block) : textOf(block, "link");
    const published =
      textOf(block, "pubDate") ?? textOf(block, "published") ?? textOf(block, "updated");
    items.push({ title, link: link ?? "", published });
  }
  return { items };
}

export async function fetchData(cfg: RssWidget): Promise<RssData> {
  const multi = cfg.urls.length > 1;
  const results = await Promise.allSettled(
    cfg.urls.map(async (u) => {
      const xml = await safeFetchText(u, {
        accept: ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml", "text/html"],
      });
      const host = new URL(u).hostname.replace(/^www\./, "");
      return parseFeed(xml, cfg.limit).items.map((it) => (multi ? { ...it, source: host } : it));
    }),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<RssData["items"]> => r.status === "fulfilled");
  if (ok.length === 0) {
    const first = results[0];
    throw new Error(first && first.status === "rejected" ? String(first.reason?.message ?? first.reason) : "no feeds fetched");
  }
  // merge newest-first; items without parseable dates sink to the end in
  // their original order
  const items = ok
    .flatMap((r) => r.value)
    .map((it, i) => ({ it, i, ts: it.published ? Date.parse(it.published) : NaN }))
    .sort((a, b) => {
      if (Number.isNaN(a.ts) && Number.isNaN(b.ts)) return a.i - b.i;
      if (Number.isNaN(a.ts)) return 1;
      if (Number.isNaN(b.ts)) return -1;
      return b.ts - a.ts;
    })
    .slice(0, cfg.limit)
    .map((x) => x.it);
  return { items };
}

export function render(data: RssData, _cfg: RssWidget): SafeHtml {
  if (data.items.length === 0) return html`<p class="empty">No items.</p>`;
  return html`<ul class="feed">
    ${data.items.map(
      (it) => html`<li>
        <a href="${safeUrl(it.link)}" rel="noreferrer">${it.title}</a>
        ${it.published || it.source
          ? html`<span class="meta">${it.published ? relativeTime(it.published) : ""}${
              it.published && it.source ? " · " : ""
            }${it.source ?? ""}</span>`
          : null}
      </li>`,
    )}
  </ul>`;
}

export const def: WidgetDef<RssWidget, RssData> = {
  meta: {
    title: "RSS / Atom feed",
    icon: "📰",
    defaultTitle: "Feed",
    category: "Feeds",
    description: "Latest items from any RSS or Atom feed.",
  },
  sourceFields: ["url", "urls"],
  form: [
    {
      key: "urls",
      label: "Feed URLs",
      kind: "strlist",
      prefill: "https://www.theverge.com/rss/index.xml",
      placeholder: "https://\u2026",
      help: "Multiple feeds merge into one list, newest first (up to 6).",
    },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, placeholder: "1h", prefill: "1h" },
    { key: "limit", label: "Items to show", kind: "number", advanced: true, placeholder: "8" },
  ],
  parse(w, where, common, h) {
    // accepts urls (list) or the legacy single url
    let raw = w.urls ?? w.url;
    if (typeof raw === "string") raw = raw.split(/\s+/).filter(Boolean);
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${where}: at least one feed URL required`);
    if (raw.length > 6) throw new Error(`${where}: at most 6 feeds`);
    const urls = raw.map((u, i) => {
      const v = h.str(u, `${where}.urls[${i}]`);
      let parsed: URL;
      try {
        parsed = new URL(v);
      } catch {
        throw new Error(`${where}.urls[${i}]: bad url`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`${where}.urls[${i}]: url must be http(s)`);
      }
      return v;
    });
    return {
      ...common,
      refreshSeconds: h.parseInterval(w.refresh_interval, `${where}.refresh_interval`),
      type: "rss",
      urls,
      limit: Math.min(Math.max(1, Math.trunc(h.num(w.limit ?? 8, `${where}.limit`))), 25),
    };
  },
  fetchData,
  render,
};
