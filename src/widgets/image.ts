import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { safeFetchJson } from "../safefetch";
import { resolvePath } from "./json-api";
import css from "./image.css";

// Generic image card. Three sources:
//  - a direct image URL (webcams: a cache-busting param is appended per
//    refresh so the browser re-fetches through the soft refresh)
//  - an uploaded /asset/ path (theme R2 pipeline, kind=widget)
//  - a JSON endpoint + dot-path that resolves to the image URL each
//    refresh (xkcd, APOD, daily-anything APIs). The resolved URL must be
//    on the pinned image origin so the page CSP stays exact.
export interface ImageWidget extends WidgetCommon {
  type: "image";
  url?: string; // direct image URL or /asset/ path
  sourceUrl?: string; // JSON endpoint
  path?: string; // dot-path to the image URL within the JSON
  imageOrigin?: string; // required for JSON mode; CSP + resolution guard
  height?: number; // px; natural height when unset
  fit: "cover" | "contain";
  link?: string; // optional: clicking the image opens this https URL
}

export interface ImageData {
  img: string;
}

export async function fetchData(cfg: ImageWidget): Promise<ImageData> {
  if (cfg.sourceUrl && cfg.path) {
    const body = await safeFetchJson(cfg.sourceUrl);
    const v = resolvePath(body, cfg.path);
    if (typeof v !== "string") throw new Error(`no image URL at path "${cfg.path}"`);
    let resolved: URL;
    try {
      resolved = new URL(v);
    } catch {
      throw new Error("resolved value is not a URL");
    }
    if (resolved.protocol !== "https:") throw new Error("resolved image URL must be https");
    if (cfg.imageOrigin && resolved.origin !== cfg.imageOrigin) {
      throw new Error(`resolved image is on ${resolved.origin}, not the allowed ${cfg.imageOrigin}`);
    }
    return { img: resolved.toString() };
  }
  const url = cfg.url as string; // parse guarantees one mode is configured
  if (url.startsWith("/asset/")) return { img: url }; // immutable, no busting
  // URL-object construction keeps the buster in the query (before any
  // fragment) and preserves existing parameters
  const busted = new URL(url);
  busted.searchParams.set("_mindash", String(Date.now()));
  return { img: busted.toString() };
}

function parseLink(v: unknown, where: string): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(v.trim());
  } catch {
    throw new Error(`${where}: bad link url`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${where}: link must be http(s)`);
  }
  return parsed.toString();
}

export function render(data: ImageData, cfg: ImageWidget): SafeHtml {
  const style = `${cfg.height ? `height:${cfg.height}px;` : ""}object-fit:${cfg.fit};`;
  // The image carries no alt: what it shows changes every refresh (a
  // webcam, today's comic), so any fixed text would be a guess, and the
  // card's own heading already names it. That leaves a linked image with
  // no accessible name at all, which is a link a screen reader cannot
  // announce - so the LINK borrows the card's title instead.
  const img = html`<img class="image-widget" src="${data.img}" alt="" loading="lazy" style="${style}">`;
  return cfg.link
    ? html`<a class="image-link" href="${cfg.link}" rel="noreferrer" aria-label="${cfg.title}">${img}</a>`
    : img;
}

export const def: WidgetDef<ImageWidget, ImageData> = {
  meta: {
    title: "Image",
    icon: "\u{1F4F7}",
    category: "Display",
    description: "A picture: webcam snapshot, uploaded image, or one resolved from a JSON API.",
  },
  sourceFields: ["url", "source_url", "path", "image_origin"],
  form: [
    {
      key: "url",
      label: "Image",
      kind: "upload",
      placeholder: "https://….jpg - or upload",
      help: "A direct image URL (webcams re-fetch each refresh) or an uploaded file.",
    },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, placeholder: "15m", prefill: "15m" },
    {
      key: "link",
      label: "Link (optional)",
      kind: "url",
      placeholder: "https://\u2026",
      help: "Clicking the image opens this URL. Empty = not clickable.",
    },
    { key: "height", label: "Height (px)", kind: "number", advanced: true, placeholder: "auto" },
    {
      key: "fit",
      label: "Fit",
      kind: "select",
      options: ["contain", "cover"],
      advanced: true,
    },
    {
      key: "source_url",
      label: "JSON endpoint (instead of a direct URL)",
      kind: "url",
      advanced: true,
      placeholder: "https://xkcd.com/info.0.json",
      help: "Fetched each refresh; the image URL is read from the path below.",
    },
    { key: "path", label: "Image URL path", kind: "text", advanced: true, placeholder: "img" },
    {
      key: "image_origin",
      label: "Allowed image origin",
      kind: "url",
      advanced: true,
      placeholder: "https://imgs.xkcd.com",
      help: "JSON mode: images must resolve to this origin (also CSP-listed).",
    },
  ],
  parse(w, where, common, h) {
    const refreshSeconds = h.parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    const fit = w.fit === "cover" ? "cover" : "contain";
    let height: number | undefined;
    if (w.height !== undefined && w.height !== "") {
      height = Math.min(Math.max(60, Math.trunc(h.num(Number(w.height), `${where}.height`))), 1200);
    }
    const sourceUrl = typeof w.source_url === "string" && w.source_url.trim() ? w.source_url.trim() : undefined;
    if (sourceUrl) {
      const pathStr = h.str(w.path, `${where}.path`);
      if (!/^[A-Za-z0-9_.-]+$/.test(pathStr)) throw new Error(`${where}: bad path`);
      const originRaw = h.str(w.image_origin, `${where}.image_origin`);
      let origin: URL;
      try {
        origin = new URL(originRaw);
      } catch {
        throw new Error(`${where}: bad image origin`);
      }
      if (origin.protocol !== "https:") throw new Error(`${where}: image origin must be https`);
      try {
        if (new URL(sourceUrl).protocol !== "https:" && new URL(sourceUrl).protocol !== "http:") throw new Error("x");
      } catch {
        throw new Error(`${where}: bad JSON endpoint url`);
      }
      return { ...common, refreshSeconds, type: "image", sourceUrl, path: pathStr, imageOrigin: origin.origin, height, fit, link: parseLink(w.link, where) };
    }
    const url = h.str(w.url, `${where}.url`);
    if (!/^\/asset\/[A-Za-z0-9_-]+\.(png|jpe?g|webp)$/.test(url)) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`${where}: image must be an https URL or an uploaded /asset/ path`);
      }
      if (parsed.protocol !== "https:") throw new Error(`${where}: image URL must be https`);
    }
    return { ...common, refreshSeconds, type: "image", url, height, fit, link: parseLink(w.link, where) };
  },
  fetchData,
  render,
  css,
};
