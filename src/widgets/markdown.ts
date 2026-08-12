import { html, safeUrl, type SafeHtml } from "../html";

// Safe markdown subset: headings, bold, inline code, links (sanitized
// URLs), bullet lists, fenced code. Everything flows through the escaping
// template - raw HTML in the source renders as text, never as markup.
function mdInline(text: string): SafeHtml {
  const parts: SafeHtml[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(html`${text.slice(last, m.index)}`);
    if (m[1] !== undefined && m[2] !== undefined) {
      parts.push(html`<a href="${safeUrl(m[2])}" rel="noreferrer">${m[1]}</a>`);
    } else if (m[3] !== undefined) {
      parts.push(html`<strong>${m[3]}</strong>`);
    } else if (m[4] !== undefined) {
      parts.push(html`<em>${m[4]}</em>`);
    } else {
      parts.push(html`<code>${m[5]}</code>`);
    }
    last = m.index + m[0].length;
  }
  parts.push(html`${text.slice(last)}`);
  return html`${parts}`;
}

export function renderMarkdown(block: string): SafeHtml {
  const out: SafeHtml[] = [];
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) buf.push(lines[i++] ?? "");
      i++;
      out.push(html`<pre class="mcp-pre">${buf.join("\n")}</pre>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i++] ?? "").replace(/^\s*[-*]\s+/, ""));
      }
      out.push(html`<ul class="mcp-ul">${items.map((it) => html`<li>${mdInline(it)}</li>`)}</ul>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quoted.push((lines[i++] ?? "").replace(/^>\s?/, ""));
      }
      out.push(html`<blockquote class="mcp-quote">${mdInline(quoted.join(" "))}</blockquote>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(html`<p class="mcp-h">${mdInline(h[2] ?? "")}</p>`);
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() && !/^(#{1,6})\s|^```|^\s*[-*]\s+/.test(lines[i] ?? "")) {
      buf.push(lines[i++] ?? "");
    }
    if (buf.length) {
      // GitHub-comment semantics: single newlines inside a paragraph are
      // real line breaks - notes typed line-by-line must not collapse
      // into one run-on sentence.
      out.push(
        html`<p class="mcp-text">${buf.map((ln, bi) =>
          bi === 0 ? mdInline(ln) : html`<br>${mdInline(ln)}`,
        )}</p>`,
      );
    }
    else i++;
  }
  return html`${out}`;
}

