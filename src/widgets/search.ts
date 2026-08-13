import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import css from "./search.css";

export interface SearchWidget extends WidgetCommon {
  type: "search";
  url: string; // engine base URL the form GETs to
  param: string; // query parameter name
  placeholder?: string;
}

// Presets carry the query PARAMETER as well as the URL, which is the
// whole point of having them: the engines disagree (Startpage wants
// "query", Wikipedia "search", YouTube "search_query"), and picking an
// engine without its parameter silently produces a search box that
// searches nothing.
export const ENGINES: Record<string, { url: string; param: string }> = {
  duckduckgo: { url: "https://duckduckgo.com/", param: "q" },
  google: { url: "https://www.google.com/search", param: "q" },
  bing: { url: "https://www.bing.com/search", param: "q" },
  brave: { url: "https://search.brave.com/search", param: "q" },
  startpage: { url: "https://www.startpage.com/sp/search", param: "query" },
  ecosia: { url: "https://www.ecosia.org/search", param: "q" },
  kagi: { url: "https://kagi.com/search", param: "q" },
  wikipedia: { url: "https://en.wikipedia.org/w/index.php", param: "search" },
  youtube: { url: "https://www.youtube.com/results", param: "search_query" },
};

// What the editor's select offers. "Custom" leads because an unset value
// displays as the first option, and unset means exactly that: a config
// written before presets existed, still driven by its own URL field. New
// widgets get a real preset via the field's prefill.
export const ENGINE_OPTIONS = [
  "Custom", "DuckDuckGo", "Google", "Bing", "Brave",
  "Startpage", "Ecosia", "Kagi", "Wikipedia", "YouTube",
];

export function renderStatic(w: SearchWidget): SafeHtml {
  return html`<form method="get" action="${w.url}" class="search-form">
      <input type="search" name="${w.param}" placeholder="${w.placeholder ?? "Search…"}" aria-label="${w.title}">
    </form>`;
}

export const def: WidgetDef<SearchWidget> = {
  meta: {
    title: "Search box",
    icon: "🔍",
    defaultTitle: "Search",
    category: "Personal",
    description: "Type and hit enter - searches your engine of choice.",
  },
  // Where typed queries are SENT - exposure decision. `engine` picks the
  // destination just as surely as `url` does, so it carries the same
  // authority.
  sourceFields: ["engine", "url", "param"],
  form: [
    {
      key: "engine",
      label: "Search engine",
      kind: "select",
      options: ENGINE_OPTIONS,
      prefill: "DuckDuckGo",
      help: "Sets the URL and the query parameter together. Choose Custom to type your own below.",
    },
    { key: "placeholder", label: "Placeholder text", kind: "text", placeholder: "Search…" },
    {
      key: "url",
      label: "Engine URL (Custom only)",
      kind: "url",
      advanced: true,
      placeholder: "https://duckduckgo.com/",
      help: "Used when Search engine is Custom; a preset overrides it.",
    },
    {
      key: "param",
      label: "Query parameter (Custom only)",
      kind: "text",
      advanced: true,
      placeholder: "q",
      help: "The parameter the engine expects - q for most, but not all.",
    },
  ],
  parse(w, where, common, _h) {
    // Three cases, in this order: a named preset wins; "Custom" (or a
    // config written before presets existed, which has a url and no
    // engine) uses the fields below it; anything else defaults.
    const named = typeof w.engine === "string" ? w.engine.trim().toLowerCase() : "";
    let url: string;
    let param: string;
    if (named && named !== "custom") {
      const preset = ENGINES[named];
      if (!preset) {
        throw new Error(`${where}: unknown search engine "${String(w.engine).slice(0, 24)}" (or use Custom)`);
      }
      url = preset.url;
      param = preset.param;
    } else {
      url = typeof w.url === "string" && w.url.trim() ? w.url.trim() : ENGINES.duckduckgo!.url;
      param = typeof w.param === "string" && w.param.trim() ? w.param.trim() : "q";
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${where}: bad engine url`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`${where}: engine url must be http(s)`);
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(param)) throw new Error(`${where}: bad query parameter name`);
    const placeholder =
      typeof w.placeholder === "string" && w.placeholder.trim() ? w.placeholder.trim().slice(0, 60) : undefined;
    return { ...common, type: "search", refreshSeconds: 0, url, param, placeholder };
  },
  renderStatic,
  // Search forms GET to their engine's origin; the CSP must name each one.
  cspOrigins(cfg) {
    try {
      return { form: [new URL(cfg.url).origin] };
    } catch {
      return {};
    }
  },
  css,
};
