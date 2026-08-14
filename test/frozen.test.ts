import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDoc, frozenWidgetIds } from "../src/config";
import { renderMain } from "../src/render";

const feed = (id: string, name: string) => ({
  id,
  name,
  type: "rss",
  title: name,
  urls: ["https://example.com/f.xml"],
  refresh_interval: "15m",
});

const page = (name: string, widgets: object[], frozen?: boolean) => ({
  name,
  ...(frozen ? { frozen: true } : {}),
  rows: [{ columns: [{ width: "full", widgets }] }],
});

test("frozen: the flag round-trips through the document", () => {
  const { doc, runtime } = validateDoc({ pages: [page("Demo", [feed("w_1", "a")], true), page("Live", [feed("w_2", "b")])] });
  assert.equal(doc.pages[0]!.frozen, true);
  assert.equal(runtime.pages[0]!.frozen, true);
  // stored only when set, like every other page flag
  assert.equal("frozen" in doc.pages[1]!, false);
  assert.equal(runtime.pages[1]!.frozen, false);
});

test("frozen: a page's own widgets are excluded from the sweep", () => {
  const { runtime } = validateDoc({ pages: [page("Demo", [feed("w_1", "a"), feed("w_2", "b")], true)] });
  assert.deepEqual([...frozenWidgetIds(runtime.pages)].sort(), ["w_1", "w_2"]);
});

// What makes "widgets of frozen pages" a complete answer: a card cannot
// straddle a frozen and an unfrozen page, because ids are unique across
// the whole document. If that ever loosened, freezing a demo copy could
// silently stop a card someone actually watches.
test("frozen: a widget cannot live on two pages, so membership is unambiguous", () => {
  const shared = feed("w_shared", "shared");
  assert.throws(
    () => validateDoc({ pages: [page("Demo", [shared], true), page("Live", [{ ...shared, name: "shared2" }])] }),
    /duplicate widget id/,
  );
});

test("frozen: unfrozen pages keep every one of their widgets", () => {
  const { runtime } = validateDoc({
    pages: [page("Demo", [feed("w_1", "a")], true), page("Live", [feed("w_2", "b"), feed("w_3", "c")])],
  });
  const frozen = frozenWidgetIds(runtime.pages);
  assert.deepEqual([...frozen], ["w_1"]);
});

test("frozen: nothing freezes when no page carries the flag", () => {
  const { runtime } = validateDoc({ pages: [page("Live", [feed("w_1", "a")])] });
  assert.equal(frozenWidgetIds(runtime.pages).size, 0);
});

// A frozen card is deliberately past due forever, so the "overdue" stamp
// (which exists to surface a sweep that silently stopped) must not fire:
// every card on the page would turn stale-red within three intervals.
test("frozen: cards do not claim to be overdue", async () => {
  const stale = Date.now() - 86400_000; // a day old, interval is 15m
  // fetchedAt lives INSIDE the stored payload, which is what the stamp reads
  const payload = JSON.stringify({ fetchedAt: stale, data: { items: [] } });
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [{ instance_id: "w_1", source_rev: 1, payload, current_key: null, prev_key: null, fetched_at: stale, last_error: null, updated_at: stale }],
          }),
          first: async () => null,
          run: async () => ({ meta: {} }),
        }),
      }),
    },
  } as never;

  const frozenDoc = validateDoc({ pages: [page("Demo", [feed("w_1", "a")], true)] });
  const liveDoc = validateDoc({ pages: [page("Live", [feed("w_1", "a")])] });
  const frozenOut = (await renderMain(env, frozenDoc.runtime, 0)).value;
  const liveOut = (await renderMain(env, liveDoc.runtime, 0)).value;
  assert.ok(!frozenOut.includes("overdue"), "a frozen card must not be marked overdue");
  assert.match(liveOut, /overdue/, "an unfrozen card this stale still is");
});
