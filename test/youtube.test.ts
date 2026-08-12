import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYtFeed, feedUrl, formatViews, render, def } from "../src/widgets/youtube";
import { validateDoc } from "../src/config";
import { imgSrcFor } from "../src/render";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Test Channel</title>
 <entry>
  <yt:videoId>dQw4w9WgXcQ</yt:videoId>
  <title>First video &amp; a &#8217;quote&#8217;</title>
  <published>2026-08-10T10:00:00+00:00</published>
  <media:group>
   <media:thumbnail url="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/>
   <media:community>
    <media:statistics views="1234567"/>
   </media:community>
  </media:group>
 </entry>
 <entry>
  <yt:videoId>abc_def-123</yt:videoId>
  <title>Second video</title>
  <published>2026-08-11T10:00:00+00:00</published>
  <media:group><media:community><media:statistics views="999"/></media:community></media:group>
 </entry>
 <entry>
  <yt:videoId>bad id!!</yt:videoId>
  <title>Invalid id skipped</title>
 </entry>
</feed>`;

const widget = (over: object = {}) => ({
  name: "yt", type: "youtube", title: "YT",
  channels: ["UCXuqSBlHAE6Xw-yeJA0Tunw"], refresh_interval: "1h", ...over,
});

const docWith = (w: object) => ({
  pages: [{ name: "Home", rows: [{ columns: [{ width: "full", widgets: [{ id: "w_yt", ...w }] }] }] }],
});

test("youtube: feed parses ids, entities, views; invalid video ids skipped", () => {
  const { source, videos } = parseYtFeed(FEED, 10);
  assert.equal(source, "Test Channel");
  assert.equal(videos.length, 2);
  assert.equal(videos[0]!.id, "dQw4w9WgXcQ");
  assert.equal(videos[0]!.title, "First video & a ’quote’");
  assert.equal(videos[0]!.views, 1234567);
  assert.equal(videos[1]!.id, "abc_def-123");
});

test("youtube: feed URL derives from id kind and Shorts filter", () => {
  assert.equal(feedUrl("UCXuqSBlHAE6Xw-yeJA0Tunw"), "https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw");
  assert.match(feedUrl("PLBCF2DAC6FFB574DE"), /playlist_id=PLBCF2DAC6FFB574DE$/);
  // channel filters route through YouTube's derived playlists
  assert.match(feedUrl("UCXuqSBlHAE6Xw-yeJA0Tunw", "videos"), /playlist_id=UULFXuqSBlHAE6Xw-yeJA0Tunw$/);
  assert.match(feedUrl("UCXuqSBlHAE6Xw-yeJA0Tunw", "shorts"), /playlist_id=UUSHXuqSBlHAE6Xw-yeJA0Tunw$/);
  // playlists are taken as-is regardless of filter
  assert.match(feedUrl("PLBCF2DAC6FFB574DE", "shorts"), /playlist_id=PLBCF2DAC6FFB574DE$/);
});

test("youtube: filter parses with 'all' default", () => {
  assert.equal((cfg() as { filter: string }).filter, "all");
  assert.equal((cfg({ filter: "shorts" }) as { filter: string }).filter, "shorts");
  assert.equal((cfg({ filter: "nonsense" }) as { filter: string }).filter, "all");
});

function cfg(over: object = {}) {
  return validateDoc(docWith(widget(over))).runtime.widgets[0]!;
}

test("youtube: parse accepts channel/playlist ids, rejects junk, caps at 4", () => {
  const { runtime } = validateDoc(docWith(widget()));
  const w = runtime.widgets[0]! as { channels: { id: string; label?: string }[]; thumbnails: boolean; limit: number };
  assert.deepEqual(w.channels, [{ id: "UCXuqSBlHAE6Xw-yeJA0Tunw" }]);
  assert.equal(w.thumbnails, true); // default on
  assert.equal(w.limit, 5);
  assert.throws(() => validateDoc(docWith(widget({ channels: ["https://youtube.com/@x"] }))), /bad entry/);
  assert.throws(() => validateDoc(docWith(widget({ channels: [] }))), /at least one/);
  assert.throws(
    () => validateDoc(docWith(widget({ channels: ["UCXuqSBlHAE6Xw-yeJA0Tunw", "UCa1qSBlHAE6Xw-yeJA0Tunw", "UCb1qSBlHAE6Xw-yeJA0Tunw", "UCc1qSBlHAE6Xw-yeJA0Tunw", "UCd1qSBlHAE6Xw-yeJA0Tunw"] }))),
    /at most 4/,
  );
});

test("youtube: {id, label} entries keep the picker's channel name", () => {
  const { runtime } = validateDoc(
    docWith(widget({ channels: [{ id: "UCXuqSBlHAE6Xw-yeJA0Tunw", label: "Veritasium" }, "UCa1qSBlHAE6Xw-yeJA0Tunw"] })),
  );
  const w = runtime.widgets[0]! as { channels: { id: string; label?: string }[] };
  assert.deepEqual(w.channels, [
    { id: "UCXuqSBlHAE6Xw-yeJA0Tunw", label: "Veritasium" },
    { id: "UCa1qSBlHAE6Xw-yeJA0Tunw" },
  ]);
  assert.throws(() => validateDoc(docWith(widget({ channels: [{ id: "junk!" }] }))), /bad entry/);
});

test("youtube: thumbnails accept editor 'hidden' and YAML false", () => {
  for (const raw of ["hidden", false]) {
    const { runtime } = validateDoc(docWith(widget({ thumbnails: raw })));
    assert.equal((runtime.widgets[0] as { thumbnails: boolean }).thumbnails, false);
  }
});

test("youtube: render derives watch links and i.ytimg thumbnails from the id only", () => {
  const cfg = validateDoc(docWith(widget())).runtime.widgets[0]!;
  const out = render({ videos: parseYtFeed(FEED, 10).videos }, cfg as never).value;
  assert.ok(out.includes("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
  assert.ok(out.includes("https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"));
  assert.ok(out.includes("1.2M views"));
  // escaped title survives
  assert.ok(out.includes("First video &amp;"));
});

test("youtube: CSP img-src pins i.ytimg.com only while thumbnails are on", () => {
  const on = validateDoc(docWith(widget())).runtime;
  assert.ok(imgSrcFor(on).includes("https://i.ytimg.com"));
  const off = validateDoc(docWith(widget({ thumbnails: "hidden" }))).runtime;
  assert.ok(!imgSrcFor(off).includes("i.ytimg.com"));
});

test("youtube: view counts format compactly", () => {
  assert.equal(formatViews(532), "532 views");
  assert.equal(formatViews(1500), "1.5k views");
  assert.equal(formatViews(84210), "84k views");
  assert.equal(formatViews(1234567), "1.2M views");
  assert.equal(formatViews(23400000), "23M views");
});

test("youtube: def registered with source authority on channels and thumbnails", () => {
  assert.ok(def.sourceFields.includes("channels"));
  assert.ok(def.sourceFields.includes("thumbnails"));
});
