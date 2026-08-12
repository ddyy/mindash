import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import css from "./bookmarks.css";

export interface BookmarkLink {
  title: string;
  url: string;
}
export interface BookmarksWidget extends WidgetCommon {
  type: "bookmarks";
  links: BookmarkLink[];
  favicons: boolean;
}

// One fixed icon origin regardless of link count - DuckDuckGo's favicon
// service - so the CSP lists a single host and bookmarked sites are never
// contacted at render time.
export function faviconUrl(link: string): string {
  try {
    return `https://icons.duckduckgo.com/ip3/${new URL(link).hostname}.ico`;
  } catch {
    return "";
  }
}

export function renderStatic(w: BookmarksWidget): SafeHtml {
  return html`<ul class="feed bookmarks-list">${w.links.map(
      (l) => html`<li>${
        w.favicons ? html`<img class="favicon" src="${faviconUrl(l.url)}" alt="" loading="lazy">` : null
      }<a href="${l.url}" rel="noreferrer">${l.title}</a></li>`,
    )}</ul>`;
}

// The ONE predicate for "favicons are on" - parse and authorization
// diffing must never disagree on which raw values enable third-party
// icon traffic ("shown" from the editor select, true from MCP/YAML).
function faviconsEnabled(v: unknown): boolean {
  return v === "shown" || v === true;
}

export const def: WidgetDef<BookmarksWidget> = {
  meta: {
    title: "Bookmarks",
    icon: "🔖",
    category: "Personal",
    description: "Groups of links - the new-tab-page staple.",
  },
  css,
  // Favicons make every VIEWER contact DuckDuckGo with each bookmarked
  // hostname - enabling that (or changing which hostnames are disclosed
  // while it's on) is a sources decision. With icons hidden, links stay
  // layout-only.
  sourceFields: ["favicons"],
  extraSourceFields: (base, next) =>
    faviconsEnabled(base?.favicons) || faviconsEnabled(next.favicons) ? ["links"] : [],
  form: [
    {
      key: "links",
      label: "Links",
      kind: "linklist",
      prefill: "GitHub: https://github.com\nHacker News: https://news.ycombinator.com",
      help: "Up to 30 links. Empty titles use the site's hostname.",
    },
    {
      key: "favicons",
      label: "Site icons",
      kind: "select",
      options: ["hidden", "shown"],
      help: "Icons load from DuckDuckGo's icon service, not the sites themselves.",
    },
  ],
  parse(w, where, common, h) {
    if (!Array.isArray(w.links)) throw new Error(`${where}: links must be a list of {title, url}`);
    if (w.links.length > 30) throw new Error(`${where}: at most 30 links`);
    const links: BookmarkLink[] = w.links.map((l, i) => {
      const o = l as Record<string, unknown>;
      const url = h.str(o?.url, `${where}.links[${i}].url`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`${where}.links[${i}]: bad url`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`${where}.links[${i}]: url must be http(s)`);
      }
      const title =
        typeof o?.title === "string" && o.title.trim()
          ? o.title.trim().slice(0, 60)
          : parsed.hostname.replace(/^www\./, "");
      return { title, url };
    });
    return { ...common, type: "bookmarks", refreshSeconds: 0, links, favicons: faviconsEnabled(w.favicons) };
  },
  renderStatic,
};
