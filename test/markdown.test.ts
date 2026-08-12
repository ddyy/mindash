import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../src/widgets/markdown";

test("markdown subset: headings, bold, italics, code, lists, links", () => {
  const out = renderMarkdown("## Title\n\n**bold** and *ital* and `code` [link](https://a.example/x)\n\n- one\n- two").value;
  assert.match(out, /class="mcp-h"/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>ital<\/em>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /href="https:\/\/a.example\/x"/);
  assert.equal((out.match(/<li>/g) || []).length, 2);
});

test("markdown subset: blockquotes group and render inline", () => {
  const out = renderMarkdown("> *quoted* line one\n> line two\n\nafter").value;
  assert.match(out, /class="mcp-quote"/);
  assert.match(out, /<em>quoted<\/em>/);
  assert.ok(!out.includes("&gt; "));
});

test("markdown subset: raw HTML stays text (XSS)", () => {
  const out = renderMarkdown('<script>alert(1)</script> <img src=x onerror=y>').value;
  assert.ok(!out.includes("<script>"));
  assert.ok(!out.includes("<img"));
  assert.match(out, /&lt;script&gt;/);
});

test("markdown subset: fenced code blocks preserved verbatim", () => {
  const out = renderMarkdown('```\n{ "a": 1 }\n```').value;
  assert.match(out, /class="mcp-pre"/);
  assert.match(out, /&quot;a&quot;: 1/);
});
