import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import css from "./iframe.css";

export interface IframeWidget extends WidgetCommon {
  type: "iframe";
  url: string;
  height: number | "fill"; // px, or fill the card (great on fit-screen pages)
}

// The one sanctioned hole in the rendering-safety contract: always
// sandboxed, no same-origin capability.
export function renderStatic(w: IframeWidget): SafeHtml {
  if (w.height === "fill") {
    // The card is a flex column; the frame takes whatever height the card
    // has (fit-screen rows, fill rows), with a floor for auto-height cards.
    return html`<iframe
      class="iframe-fill"
      src="${w.url}"
      style="width:100%;border:0"
      sandbox="allow-scripts allow-forms"
      referrerpolicy="no-referrer"
      loading="lazy"
    ></iframe>`;
  }
  return html`<iframe
      src="${w.url}"
      style="width:100%;border:0;height:${w.height}px"
      sandbox="allow-scripts allow-forms"
      referrerpolicy="no-referrer"
      loading="lazy"
    ></iframe>`;
}

export const def: WidgetDef<IframeWidget> = {
  meta: {
    title: "Embedded frame",
    icon: "🖼",
    defaultTitle: "Embed",
    category: "Display",
    description: "Sandboxed iframe for Grafana panels, status pages, anything external.",
  },
  sourceFields: ["url"],
  form: [
    { key: "url", label: "Frame URL", kind: "url", required: true, placeholder: "https://status.example.com/" },
    {
      key: "height",
      label: "Height",
      kind: "text",
      placeholder: "300",
      help: 'Pixels, or "fill" to take the whole card - pairs well with fit-to-screen pages.',
    },
  ],
  parse(w, where, common, h) {
    let height: number | "fill";
    if (typeof w.height === "string" && w.height.trim().toLowerCase() === "fill") {
      height = "fill";
    } else {
      const n = w.height === undefined || w.height === "" ? 300 : Number(w.height);
      if (!Number.isFinite(n)) throw new Error(`${where}.height: pixels or "fill"`);
      height = Math.min(Math.max(80, Math.trunc(n)), 1200);
    }
    return {
      ...common,
      type: "iframe",
      refreshSeconds: 0,
      url: h.str(w.url, `${where}.url`),
      height,
    };
  },
  renderStatic,
  // Historically the iframe card renders <section class="widget"> with no
  // type class - preserve that exactly.
  sectionClass: "",
  cspOrigins(cfg) {
    try {
      return { frame: [new URL(cfg.url).origin] };
    } catch {
      return {};
    }
  },
  css,
};
