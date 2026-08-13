// Whether an uploaded SVG is safe to STORE and serve from /asset/.
//
// This is deliberately the second line of defence, not the first. The
// serve route sends `default-src 'none'; sandbox`, which makes any asset
// inert as a document - so even a file that slipped past this check
// cannot run script in the dashboard's origin. That ordering matters:
// SVG sanitizers have a long history of parser-differential bypasses, and
// one that is the ONLY thing between a stored file and same-origin script
// execution is a bet on being cleverer than everyone who lost that bet
// before.
//
// So the rules here are blunt on purpose, and this REJECTS rather than
// strips: a favicon is authored once and re-uploaded freely, so refusing
// a suspicious file costs one edit, while silently rewriting one leaves
// the user with an image that is not what they drew and no idea why.
const DENY: [RegExp, string][] = [
  [/<!DOCTYPE/i, "a DOCTYPE"], // XXE
  [/<!ENTITY/i, "an entity declaration"], // billion laughs
  [/<\s*(?:[A-Za-z0-9_-]+:)?script\b/i, "a <script> element"],
  [/<\s*(?:[A-Za-z0-9_-]+:)?foreignObject\b/i, "a <foreignObject> element"], // arbitrary HTML
  [/<\s*(?:[A-Za-z0-9_-]+:)?(?:iframe|embed|object|audio|video|handler)\b/i, "an embedded-content element"],
  // Event handlers. Anchored to the attribute-name position - whitespace
  // before, "=" after - so a title reading "on error" or a font-size
  // declaration is not caught by the word "on".
  [/\son[a-z]+\s*=/i, "an event-handler attribute"],
  [/javascript\s*:/i, "a javascript: URL"],
  [/@import/i, "a CSS @import"],
  // SMIL can animate an attribute INTO a javascript: URL, which is script
  // execution without the word "script" ever appearing next to it.
  [/attributeName\s*=\s*["']?\s*(?:xlink:)?href/i, "a SMIL animation of a URL attribute"],
];

// Every href/xlink:href VALUE in the document. Written as a value scan
// rather than one clever pattern: a negative lookahead inside an optional
// quote backtracks into matching the empty string, which turns the
// perfectly legal href="#gradient" into a rejection.
const HREF = /(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
// CSS url(...) values, same reasoning.
const CSS_URL = /url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi;

// A reference may point INSIDE this document (#id) or carry its own
// bytes (data: image). Anything else reaches the network the moment the
// file is opened - a tracking beacon at best, and a fetch the dashboard's
// CSP never authorized.
function localRef(raw: string): boolean {
  const v = raw.trim();
  return v.startsWith("#") || /^data:image\//i.test(v);
}

export interface SvgCheck {
  ok: boolean;
  error?: string;
}

export function checkSvg(text: string): SvgCheck {
  if (text.trim().length === 0) return { ok: false, error: "empty file" };
  // A NUL byte means this is not the text document it claims to be -
  // most likely a polyglot carrying another format's payload.
  if (text.includes("\u0000")) return { ok: false, error: "not a text document" };
  // Named hazards first, so the refusal says which one - the user is
  // about to hand-edit the file and try again, and "contains a DOCTYPE"
  // is actionable where "not an SVG document" would send them looking at
  // the wrong end of the file.
  for (const [pattern, what] of DENY) {
    if (pattern.test(text)) return { ok: false, error: `SVG contains ${what}` };
  }
  // The root element must be <svg>, with nothing before it but an XML
  // declaration, comments, or whitespace. This is what stops a file that
  // is valid HTML first and SVG second.
  const preamble = text
    .replace(/^﻿/, "")
    .replace(/<\?xml[^>]*\?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trimStart();
  if (!/^<\s*(?:[A-Za-z0-9_-]+:)?svg[\s>]/i.test(preamble)) {
    return { ok: false, error: "must be an SVG document (root element <svg>)" };
  }
  for (const m of text.matchAll(HREF)) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    if (!localRef(value)) return { ok: false, error: "SVG contains an external reference" };
  }
  for (const m of text.matchAll(CSS_URL)) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    if (!localRef(value)) return { ok: false, error: "SVG contains an external CSS reference" };
  }
  return { ok: true };
}
