import { test } from "node:test";
import assert from "node:assert/strict";
import { render, type ImageWidget } from "../src/widgets/image";

const cfg = (over: Partial<ImageWidget> = {}): ImageWidget => ({
  id: "w_1", name: "img-1", type: "image", title: "Today's xkcd",
  refreshSeconds: 900, fit: "contain", ...over,
} as ImageWidget);

// A linked image whose <img> is alt="" has no accessible name at all: a
// screen reader announces "link" and nothing else. The alt stays empty on
// purpose (what the image shows changes each refresh), so the name has to
// come from the card's title.
test("image: a linked image takes its accessible name from the card title", () => {
  const out = render({ img: "https://imgs.xkcd.com/comics/x.png" }, cfg({ link: "https://xkcd.com/" })).value;
  assert.match(out, /<a class="image-link"[^>]*aria-label="Today&#39;s xkcd"/);
  assert.match(out, /alt=""/, "the image itself stays decorative - the link carries the name");
});

test("image: an unlinked image needs no name (the heading above it is the label)", () => {
  const out = render({ img: "https://imgs.xkcd.com/comics/x.png" }, cfg()).value;
  assert.ok(!out.includes("<a "), "no link, nothing to name");
  assert.match(out, /alt=""/);
});

test("image: the accessible name is escaped, not injected", () => {
  const out = render(
    { img: "https://imgs.xkcd.com/comics/x.png" },
    cfg({ title: '"><script>alert(1)</script>', link: "https://xkcd.com/" }),
  ).value;
  assert.ok(!out.includes("<script>alert(1)"));
  assert.match(out, /&lt;script&gt;/);
});
