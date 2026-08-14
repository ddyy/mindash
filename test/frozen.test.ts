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

// ---------- per-widget pause ----------
//
// Pause shares the sweep-skip with frozen but is its OPPOSITE in
// appearance: a frozen page is a demo that must read as live, so it says
// nothing; a paused card must say so, or it is indistinguishable from
// one whose pipeline quietly died.

const paused = (id: string, name: string) => ({ ...feed(id, name), paused: true });

test("paused: the flag round-trips and is stored only when set", () => {
  const { doc, runtime } = validateDoc({ pages: [page("P", [paused("w_1", "a"), feed("w_2", "b")])] });
  const raw = doc.pages[0]!.rows[0]!.columns[0]!.widgets;
  assert.equal(raw[0]!.paused, true);
  assert.equal("paused" in raw[1]!, false);
  assert.equal(runtime.widgets.find((w) => w.id === "w_1")!.paused, true);
  assert.equal(runtime.widgets.find((w) => w.id === "w_2")!.paused, undefined);
});

test("paused: the editor checkbox value is accepted like expand's", () => {
  const { runtime } = validateDoc({ pages: [page("P", [{ ...feed("w_1", "a"), paused: "yes" }])] });
  assert.equal(runtime.widgets[0]!.paused, true);
});

test("paused: a paused card is excluded from the sweep, its siblings are not", () => {
  const { runtime } = validateDoc({ pages: [page("P", [paused("w_1", "a"), feed("w_2", "b")])] });
  const skip = frozenWidgetIds(runtime.pages);
  assert.equal(skip.has("w_1"), true);
  assert.equal(skip.has("w_2"), false, "pausing one card must not stop its neighbours");
});

test("paused: page-frozen and card-paused both land in the skip set", () => {
  const { runtime } = validateDoc({
    pages: [page("Demo", [feed("w_1", "a")], true), page("Live", [paused("w_2", "b"), feed("w_3", "c")])],
  });
  const skip = frozenWidgetIds(runtime.pages);
  assert.deepEqual([...skip].sort(), ["w_1", "w_2"]);
});

test("paused says so on the card; frozen stays silent", async () => {
  const { runtime } = validateDoc({
    pages: [page("Demo", [feed("w_1", "a")], true), page("Live", [paused("w_2", "b")])],
  });
  // Both cards are a day stale against a 15m interval: without their
  // flags each would go stale-red as "overdue".
  const stale = Date.now() - 86400_000;
  const payload = JSON.stringify({ fetchedAt: stale, data: { items: [] } });
  const row = (id: string) => ({
    instance_id: id, source_rev: 1, payload, current_key: null, prev_key: null,
    fetched_at: stale, last_error: null, updated_at: stale,
  });
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [row("w_1"), row("w_2")] }),
          first: async () => null,
          run: async () => ({ meta: {} }),
        }),
      }),
    },
  } as never;

  const frozenHtml = (await renderMain(env, runtime, 0, true)).value;
  assert.equal(/paused/.test(frozenHtml), false, "a frozen demo page must not advertise itself");
  assert.equal(/overdue/.test(frozenHtml), false, "and must not go stale-red either");

  const pausedHtml = (await renderMain(env, runtime, 1, true)).value;
  assert.match(pausedHtml, /paused/, "a paused card must say so");
  assert.equal(/overdue/.test(pausedHtml), false, "paused is deliberate, so never overdue");
  assert.equal(/stamp-stale/.test(pausedHtml), false, "and never the fault colour");
});
