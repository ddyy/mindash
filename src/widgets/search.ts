import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import css from "./search.css";

export interface SearchWidget extends WidgetCommon {
  type: "search";
  url: string; // engine base URL the form GETs to
  param: string; // query parameter name
  placeholder?: string;
}

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
  // Where typed queries are SENT - exposure decision.
  sourceFields: ["url", "param"],
  form: [
    { key: "url", label: "Engine URL", kind: "url", prefill: "https://duckduckgo.com/", placeholder: "https://duckduckgo.com/" },
    { key: "placeholder", label: "Placeholder text", kind: "text", placeholder: "Search…" },
    { key: "param", label: "Query parameter", kind: "text", advanced: true, placeholder: "q", help: "The URL parameter the engine expects (q for most engines)." },
  ],
  parse(w, where, common, _h) {
    const url = typeof w.url === "string" && w.url.trim() ? w.url.trim() : "https://duckduckgo.com/";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${where}: bad engine url`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`${where}: engine url must be http(s)`);
    }
    const param = typeof w.param === "string" && w.param.trim() ? w.param.trim() : "q";
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
