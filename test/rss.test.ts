import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, fetchData } from "../src/widgets/rss";
import { parseHelpers } from "../src/widgets/def";
import { def as rssDef } from "../src/widgets/rss";

test("parseFeed: entities decode (numeric, named, double-encoded), CDATA, tags stripped", () => {
  const xml = `<rss><channel>
    <item><title>Anker&#8217;s charger &amp;#8220;great&amp;#8221; &mdash; yes</title><link>https://a.example/1</link></item>
    <item><title><![CDATA[CDATA <b>clean</b> &amp; safe]]></title><link>https://a.example/2</link></item>
  </channel></rss>`;
  const { items } = parseFeed(xml, 10);
  // the entity map deliberately normalizes mdash to ASCII "-"
  assert.equal(items[0]!.title, "Anker’s charger “great” - yes");
  assert.equal(items[1]!.title, "CDATA clean & safe");
});

test("multi-feed merge: newest first, per-item source, failed feed tolerated", async () => {
  const feeds: Record<string, string> = {
    "https://a.example/f": `<rss><channel><item><title>Old A</title><link>https://a/1</link><pubDate>Mon, 10 Aug 2026 01:00:00 GMT</pubDate></item></channel></rss>`,
    "https://b.example/f": `<rss><channel><item><title>New B</title><link>https://b/1</link><pubDate>Tue, 11 Aug 2026 01:00:00 GMT</pubDate></item></channel></rss>`,
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    for (const [k, v] of Object.entries(feeds)) {
      if (u.startsWith(k)) return new Response(v, { status: 200, headers: { "content-type": "application/rss+xml" } });
    }
    throw new Error("connect fail");
  }) as any;
  try {
    const cfg = (rssDef as any).parse(
      { urls: ["https://a.example/f", "https://b.example/f", "https://dead.example/f"], refresh_interval: "1h", limit: 5 },
      "t", { id: "w_1", name: "r-1", title: "R" }, parseHelpers,
    );
    const data = await fetchData(cfg);
    assert.equal(data.items[0]!.title, "New B");
    assert.equal(data.items[0]!.source, "b.example");
    assert.equal(data.items.length, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("legacy single url still parses into urls[]", () => {
  const cfg = (rssDef as any).parse({ url: "https://a.example/f", refresh_interval: "1h" }, "t", { id: "w", name: "r", title: "R" }, parseHelpers);
  assert.deepEqual(cfg.urls, ["https://a.example/f"]);
});
