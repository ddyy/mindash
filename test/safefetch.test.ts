import { test } from "node:test";
import assert from "node:assert/strict";
import { safeFetchText } from "../src/safefetch";

const realFetch = globalThis.fetch;
function streamOf(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

test("truncation keeps the exact prefix - never NUL padding", async () => {
  try {
    // first chunk alone exceeds the cap
    globalThis.fetch = (async () => streamOf(["ABCDEFGHIJ"])) as typeof fetch;
    const t1 = await safeFetchText("https://x.example/a", { maxBytes: 4, allowTruncate: true });
    assert.equal(t1, "ABCD");
    assert.ok(!t1.includes("\u0000"));
    // a later chunk crosses the boundary
    globalThis.fetch = (async () => streamOf(["ABC", "DEF", "GHI"])) as typeof fetch;
    const t2 = await safeFetchText("https://x.example/a", { maxBytes: 7, allowTruncate: true });
    assert.equal(t2, "ABCDEFG");
    // without allowTruncate the cap still throws
    globalThis.fetch = (async () => streamOf(["ABCDEFGHIJ"])) as typeof fetch;
    await assert.rejects(() => safeFetchText("https://x.example/a", { maxBytes: 4 }), /exceeded 4 byte cap/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
