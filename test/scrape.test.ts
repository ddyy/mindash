import { test } from "node:test";
import assert from "node:assert/strict";
import { def as scrapeDef, normalizeRows, render, SCRAPE_LIMIT, type ScrapeWidget } from "../src/widgets/scrape";
import { parseHelpers } from "../src/widgets/def";

const common = { id: "w1", name: "scrape", title: "Scrape" };

test("parse: url policy (public http(s) only), selectors validated", () => {
  const w = scrapeDef.parse(
    { url: "https://old.reddit.com/r/selfhosted/", item_selector: "a.title", refresh_interval: "30m" },
    "w", common, parseHelpers,
  ) as ScrapeWidget;
  assert.equal(w.itemSelector, "a.title");
  assert.equal(w.linkSelector, undefined);
  const bad = (raw: Record<string, unknown>, re: RegExp) =>
    assert.throws(() => scrapeDef.parse({ item_selector: "a", refresh_interval: "30m", ...raw }, "w", common, parseHelpers), re);
  bad({ url: "http://localhost:8787/" }, /non-public/);
  bad({ url: "https://10.0.0.1/x" }, /non-public/);
  bad({ url: "ftp://x.example" }, /http/);
  bad({ url: "https://ok.example", item_selector: "a { }" }, /bad selector/);
});

test("normalizeRows: whitespace collapsed, relative hrefs absolutized, junk dropped, capped", () => {
  const items = [
    { text: "  A \n post  ", href: "/r/x/comments/1/", meta: " 42  points " },
    { text: "External", href: "https://ex.example/page" },
    { text: "", href: "/skipped-no-title/" },
    { text: "No link at all" },
    { text: "Bad href", href: "javascript:alert(1)" },
    ...Array.from({ length: 20 }, (_, i) => ({ text: `filler ${i}` })),
  ];
  const rows = normalizeRows(items, "https://old.reddit.com/r/selfhosted/");
  assert.equal(rows[0]!.title, "A post");
  assert.equal(rows[0]!.url, "https://old.reddit.com/r/x/comments/1/");
  assert.equal(rows[0]!.meta, "42 points");
  assert.equal(rows[1]!.url, "https://ex.example/page");
  assert.equal(rows[2]!.title, "No link at all");
  assert.equal(rows[2]!.url, undefined);
  assert.equal(rows[3]!.title, "Bad href");
  assert.equal(rows[3]!.url, undefined); // javascript: dropped, row kept
  assert.equal(rows.length, SCRAPE_LIMIT);
});

test("render: rows go through the shared list renderer", () => {
  const out = render(
    { rows: [{ title: "Post", url: "https://ex.example/1", meta: "42 points" }] },
    { ...common, type: "scrape", refreshSeconds: 1800, url: "https://ex.example", itemSelector: "a" },
  ).toString();
  assert.match(out, /class="feed"/);
  assert.match(out, /href="https:\/\/ex\.example\/1"/);
  assert.match(out, /42 points/);
});
