// Rendering-safety contract: every interpolated value is escaped for HTML
// context unless it is already SafeHtml produced by this module. There is
// deliberately no raw-HTML primitive - widget data can never reach the page
// unescaped.

const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < vals.length; i++) {
    out += renderValue(vals[i]) + (strings[i + 1] ?? "");
  }
  return new SafeHtml(out);
}

// URL context: only http(s) survives; anything else renders as "#".
export function safeUrl(raw: unknown): string {
  if (typeof raw !== "string") return "#";
  try {
    const u = new URL(raw);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    // fall through
  }
  return "#";
}
