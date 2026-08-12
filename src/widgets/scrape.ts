import puppeteer from "@cloudflare/puppeteer";
import type { WidgetCommon, WidgetDef } from "./def";
import type { SafeHtml } from "../html";
import { renderList, type ListRow } from "./listmap";

// Browser-scrape widget: Cloudflare Browser Rendering loads the page in
// headless Chromium and CSS selectors map elements to the same list rows
// the rest of the app renders. Exists for sites that block plain Worker
// fetches (reddit 403s datacenter IPs; a full browser passes) or that
// only materialize content via JS. Config-only - a new site is a new
// selector, never new code.
//
// Budget note: renders cost browser-minutes (the free tier is ~10/day),
// so the form nudges toward slow refreshes and the sweep's D1 cache does
// the rest - a page view never launches a browser.

export interface ScrapeWidget extends WidgetCommon {
  type: "scrape";
  url: string;
  itemSelector: string;
  linkSelector?: string;
  metaSelector?: string;
}

export interface ScrapeData {
  rows: ListRow[];
}

export const SCRAPE_LIMIT = 12;
const GOTO_TIMEOUT_MS = 20_000;
const SELECTOR_WAIT_MS = 5_000;

// Headless Chromium announces "HeadlessChrome" in its default UA, and
// sites serve degraded or blocked pages on it (reddit does). Present the
// same ordinary-browser UA safefetch uses.
const PAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Raw element captures from the page context; normalization happens
// worker-side where it's testable.
export interface RawItem {
  text?: unknown;
  href?: unknown;
  meta?: unknown;
}

export function normalizeRows(items: RawItem[], baseUrl: string): ListRow[] {
  const rows: ListRow[] = [];
  for (const it of items) {
    const title = typeof it.text === "string" ? it.text.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    if (!title) continue;
    let url: string | undefined;
    if (typeof it.href === "string" && it.href.trim()) {
      try {
        const abs = new URL(it.href, baseUrl);
        if (abs.protocol === "https:" || abs.protocol === "http:") url = abs.toString();
      } catch {
        // unresolvable href: keep the row, drop the link
      }
    }
    const meta = typeof it.meta === "string" ? it.meta.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    rows.push({ title, ...(url ? { url } : {}), ...(meta ? { meta } : {}) });
    if (rows.length >= SCRAPE_LIMIT) break;
  }
  return rows;
}

export async function fetchData(cfg: ScrapeWidget, env: Env): Promise<ScrapeData> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(PAGE_UA);
    // Tall viewport: feed UIs that virtualize to the window (new reddit)
    // only materialize enough items to fill it - puppeteer's 800x600
    // default yields 3 rows where a tall window yields a full page.
    await page.setViewport({ width: 1280, height: 2400 });
    // Wait for network idle, not domcontentloaded: streaming UIs (new
    // reddit) SSR a few items and hydrate the rest off further requests -
    // reading at domcontentloaded returns a 3-item list no matter how
    // long the DOM is then watched (measured). A page that never goes
    // idle times out; read whatever rendered instead of failing.
    try {
      await page.goto(cfg.url, { waitUntil: "networkidle0", timeout: GOTO_TIMEOUT_MS });
    } catch (e) {
      if (!/timeout/i.test(String(e))) throw e;
    }
    // Late hydrators get a bounded extra beat to reach a full page of
    // matches. String form: the worker's TS has no DOM lib; the expression
    // runs in the page, with the selector's quotes JSON-escaped.
    await page
      .waitForFunction(
        `document.querySelectorAll(${JSON.stringify(cfg.itemSelector)}).length >= ${SCRAPE_LIMIT}`,
        { timeout: SELECTOR_WAIT_MS },
      )
      .catch(() => {});
    // Selectors evaluate in the page; only plain data comes back.
    const items = (await page.$$eval(
      cfg.itemSelector,
      (els, opts) =>
        els.slice(0, opts.limit).map((el) => {
          const q = (sel: string | undefined) => (sel ? el.querySelector(sel) : null);
          const linkEl =
            (opts.linkSelector ? q(opts.linkSelector) : null) ??
            (el.tagName === "A" && el.hasAttribute("href") ? el : el.querySelector("a[href]"));
          return {
            text: el.textContent ?? "",
            href: linkEl?.getAttribute("href") ?? undefined,
            meta: opts.metaSelector ? (q(opts.metaSelector)?.textContent ?? undefined) : undefined,
          };
        }),
      { limit: SCRAPE_LIMIT + 8, linkSelector: cfg.linkSelector, metaSelector: cfg.metaSelector },
    )) as RawItem[];
    const rows = normalizeRows(items, cfg.url);
    if (rows.length === 0) {
      // Name where the browser actually ended up - redirects to a
      // different UI (old.reddit -> www) are the usual culprit.
      const landed = page.url();
      throw new Error(
        `selector "${cfg.itemSelector}" matched nothing on the rendered page` +
          (landed && landed !== cfg.url ? ` (landed on ${landed})` : ""),
      );
    }
    return { rows };
  } finally {
    await browser.close();
  }
}

export function render(data: ScrapeData, _cfg: ScrapeWidget): SafeHtml {
  return renderList(data.rows);
}

// CSS selector sanity: printable, no quotes-only nonsense, bounded. The
// selector runs inside the sandboxed rendering browser, not in any
// viewer's page, so this is a shape check rather than a security wall.
const SELECTOR_RE = /^[^{}<>]{1,200}$/;

function selector(v: unknown, where: string, required: boolean): string | undefined {
  if (v === undefined || v === "") {
    if (required) throw new Error(`${where}: required`);
    return undefined;
  }
  if (typeof v !== "string" || !SELECTOR_RE.test(v)) throw new Error(`${where}: bad selector`);
  return v;
}

export const def: WidgetDef<ScrapeWidget, ScrapeData> = {
  meta: {
    title: "Web scrape",
    icon: "🕷️",
    defaultTitle: "Scrape",
    category: "Display",
    description: "Render any page in a headless browser and map elements to a list with CSS selectors.",
    requirements:
      "Uses Cloudflare Browser Rendering (the BROWSER binding in wrangler.jsonc). Free-tier browser time is limited - prefer refresh intervals of 30m or more.",
  },
  sourceFields: ["url"],
  form: [
    {
      key: "url",
      label: "Page URL",
      kind: "url",
      required: true,
      placeholder: "https://www.reddit.com/r/selfhosted/",
      prefill: "https://www.reddit.com/r/selfhosted/",
    },
    {
      key: "item_selector",
      label: "Item selector",
      kind: "text",
      required: true,
      placeholder: 'a[slot="full-post-link"]',
      prefill: 'a[slot="full-post-link"]',
      help: "CSS selector for each list item. If it isn't a link itself, the first link inside it is used.",
    },
    {
      key: "link_selector",
      label: "Link selector",
      kind: "text",
      advanced: true,
      placeholder: "a.comments",
      help: "Optional selector WITHIN each item for the row's link.",
    },
    {
      key: "meta_selector",
      label: "Meta selector",
      kind: "text",
      advanced: true,
      placeholder: ".score",
      help: "Optional selector WITHIN each item for a muted second line.",
    },
    {
      key: "refresh_interval",
      label: "Refresh every",
      kind: "interval",
      required: true,
      prefill: "30m",
      placeholder: "30m",
      help: "Each refresh runs a real browser - slower is cheaper.",
    },
  ],
  parse(w, where, common, h) {
    const refreshSeconds = h.parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    const url = h.str(w.url, `${where}.url`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${where}.url: bad url`);
    }
    // Public https/http only - mirrors safefetch's destination policy for
    // the rendering browser.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`${where}.url: must be http(s)`);
    }
    const host = parsed.hostname;
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
      host.includes(":")
    ) {
      throw new Error(`${where}.url: non-public destination`);
    }
    return {
      ...common,
      type: "scrape",
      refreshSeconds,
      url,
      itemSelector: selector(w.item_selector, `${where}.item_selector`, true)!,
      ...(selector(w.link_selector, `${where}.link_selector`, false) !== undefined
        ? { linkSelector: selector(w.link_selector, `${where}.link_selector`, false)! }
        : {}),
      ...(selector(w.meta_selector, `${where}.meta_selector`, false) !== undefined
        ? { metaSelector: selector(w.meta_selector, `${where}.meta_selector`, false)! }
        : {}),
    };
  },
  fetchData,
  render,
};
