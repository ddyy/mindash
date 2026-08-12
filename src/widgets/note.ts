import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { renderMarkdown } from "./markdown";

export interface NoteWidget extends WidgetCommon {
  type: "note";
  text: string;
  markdown: boolean;
}

export function renderStatic(w: NoteWidget): SafeHtml {
  return w.markdown ? renderMarkdown(w.text) : html`<p class="mcp-text">${w.text}</p>`;
}

export const def: WidgetDef<NoteWidget> = {
  meta: {
    title: "Note",
    icon: "📝",
    category: "Personal",
    description: "A pinned card of text - markdown supported.",
  },
  sourceFields: [],
  form: [
    {
      key: "text",
      label: "Text",
      kind: "textarea",
      required: true,
      prefill: "Edit me - **bold**, [links](https://example.com), lists:\n\n- one\n- two",
    },
    { key: "render", label: "Rendering", kind: "select", options: ["markdown", "plain"] },
  ],
  parse(w, where, common, h) {
    const text = h.str(w.text, `${where}.text`).slice(0, 4000);
    return { ...common, type: "note", refreshSeconds: 0, text, markdown: w.render !== "plain" };
  },
  renderStatic,
};
