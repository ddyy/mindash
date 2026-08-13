import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDoc } from "../src/config";
import { themeCssVars, themeBodyCss, effectiveTheme, imgSrcFor, formActionFor, frameSrcFor, renderMain } from "../src/render";

// renderMain touches env only for pull/heartbeat widgets; widget-free
// docs render with a bare stub.
const fakeEnv = () => ({}) as never;

const doc = (over: object = {}) => ({ pages: [{ name: "Home", rows: [{ columns: [{ width: "full", widgets: [] }] }] }], ...over });
const withWidgets = (widgets: object[]) =>
  validateDoc({ pages: [{ name: "H", rows: [{ columns: [{ width: "full", widgets } ] }] }] }).runtime;

test("themeCssVars: hex + legacy triplets, radius pair, font stack", () => {
  const { runtime } = validateDoc(doc({ theme: { accent: "#ff0000", background: "220 30% 6%", radius: 0, font: "mono", card_opacity: 70 } }));
  const vars = themeCssVars(runtime.theme);
  assert.match(vars, /--accent-override: #ff0000/);
  assert.match(vars, /--bg-override: hsl\(220 30% 6%\)/);
  assert.match(vars, /--radius: 0px/);
  assert.match(vars, /--radius-sm: 0px/);
  assert.match(vars, /--card-opacity: 70%/);
  assert.match(vars, /ui-monospace/);
});

test("effectiveTheme: preset overlay, built-in fallback, custom shadows built-in", () => {
  const { runtime } = validateDoc(doc({
    theme: { accent: "#3d99f5", title: "mine" },
    themes: { nord: { accent: "#ff0000" } },
    pages: [
      { name: "A", theme: "nord", rows: [{ columns: [{ width: "full", widgets: [] }] }] },
      { name: "B", theme: "terminal", rows: [{ columns: [{ width: "full", widgets: [] }] }] },
    ],
  }));
  assert.equal(effectiveTheme(runtime, 0).accent, "#ff0000"); // custom shadows built-in nord
  assert.equal(effectiveTheme(runtime, 1).font, "mono"); // built-in terminal
  assert.equal(effectiveTheme(runtime, 1).title, "mine"); // identity inherits
});

test("imgSrcFor: theme refs, favicons, image widgets compose exact origins", () => {
  const runtime = withWidgets([
    { id: "w_1", name: "i-1", type: "image", source_url: "https://xkcd.com/info.0.json", path: "img", image_origin: "https://imgs.xkcd.com", refresh_interval: "6h" },
    { id: "w_2", name: "b-1", type: "bookmarks", links: [{ url: "https://github.com" }], favicons: "shown" },
    { id: "w_3", name: "i-2", type: "image", url: "/asset/widget-ab.png", refresh_interval: "1h" },
  ]);
  const src = imgSrcFor(runtime);
  assert.match(src, /'self'/);
  assert.match(src, /icons\.duckduckgo\.com/);
  assert.match(src, /imgs\.xkcd\.com/);
});

test("imgSrcFor: same-origin is always allowed, so the favicon loads", () => {
  // A page with no image widgets still links /favicon.svg; omitting
  // img-src let default-src 'none' block it, and listing only
  // third-party origins blocked it just as hard.
  assert.equal(imgSrcFor(withWidgets([])), "; img-src 'self'");
  const thirdParty = withWidgets([
    { id: "w_1", name: "b-1", type: "bookmarks", links: [{ url: "https://github.com" }], favicons: "shown" },
  ]);
  assert.equal(imgSrcFor(thirdParty), "; img-src 'self' https://icons.duckduckgo.com");
});

test("formActionFor: search engines contribute origins", () => {
  const runtime = withWidgets([
    { id: "w_1", name: "s-1", type: "search", url: "https://kagi.com/search" },
    { id: "w_2", name: "s-2", type: "search" },
  ]);
  const fa = formActionFor(runtime);
  assert.match(fa, /kagi\.com/);
  assert.match(fa, /duckduckgo\.com/);
});

test("frameSrcFor: iframe origins only", () => {
  const runtime = withWidgets([
    { id: "w_1", name: "f-1", type: "iframe", url: "https://grafana.example/d/1", height: 300 },
  ]);
  assert.match(frameSrcFor(runtime), /grafana\.example/);
});

test("themeBodyCss: background image rule only when set", () => {
  const none = validateDoc(doc()).runtime;
  assert.equal(themeBodyCss(none.theme), "");
  const withImg = validateDoc(doc({ theme: { background_image: "/asset/background-ab.webp" } })).runtime;
  assert.match(themeBodyCss(withImg.theme), /background-image: url\("\/asset\/background-ab\.webp"\)/);
});

test("imgSrcFor includes favicon origins (external and /asset/)", () => {
  const cfg = (favicon: string) => validateDoc({
    theme: { accent: "210 90% 60%", favicon },
    pages: [{ name: "H", rows: [{ columns: [{ width: "full", widgets: [] }] }] }],
  }).runtime;
  assert.ok(imgSrcFor(cfg("https://icons.example/f.png")).includes("https://icons.example"));
  assert.ok(imgSrcFor(cfg("/asset/abc123.png")).includes("'self'"));
});

test("rows carry row-fill by default; fill:false omits it", async () => {
  const doc = (row: any) => validateDoc({ pages: [{ name: "H", rows: [row] }] }).runtime;
  const on = await renderMain(fakeEnv(), doc({ columns: [{ width: "full", widgets: [] }] }), 0);
  assert.ok(on.value.includes("row-fill"));
  const off = await renderMain(fakeEnv(), doc({ fill: false, columns: [{ width: "full", widgets: [] }] }), 0);
  assert.ok(!off.value.includes("row-fill"));
});

test("owner refresh button renders only when requested", async () => {
  // minimal DB stub: no refresh_state rows, so the card is in its
  // "refresh pending" state - the button must render regardless.
  const dbEnv = {
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: {} }) }),
      }),
    },
  } as never;
  const runtime = withWidgets([
    { id: "w_1", name: "j-1", type: "json-api", url: "https://api.example.com/x", refresh_interval: "1h", fields: [{ label: "A", path: "a" }] },
  ]);
  const authed = (await renderMain(dbEnv, runtime, 0, true)).value;
  assert.match(authed, /data-refresh="w_1"/);
  assert.match(authed, /class="w-refresh"/);
  const anon = (await renderMain(dbEnv, runtime, 0, false)).value;
  assert.ok(!anon.includes("w-refresh"));
});

test("iframe height: px renders inline, fill renders the flex class", async () => {
  const px = withWidgets([{ id: "w_1", name: "f-1", type: "iframe", url: "https://s.example/", height: 300 }]);
  const out1 = (await renderMain(fakeEnv(), px, 0)).value;
  assert.match(out1, /height:300px/);
  assert.ok(!out1.includes("iframe-fill"));
  const fill = withWidgets([{ id: "w_1", name: "f-1", type: "iframe", url: "https://s.example/", height: "fill" }]);
  const out2 = (await renderMain(fakeEnv(), fill, 0)).value;
  assert.match(out2, /class="iframe-fill"/);
  assert.ok(!/height:\d+px/.test(out2));
});

test("card footer: refresh icon precedes the stamp, which links to the log", async () => {
  // stub a cached payload so the "updated ..." stamp exists alongside the
  // button - the two together are what the footer orders.
  const payload = JSON.stringify({ fetchedAt: Date.now() - 60_000, data: { values: [] } });
  const dbEnv = {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [{ instance_id: "w_1", source_rev: 1, payload, current_key: null, prev_key: null, fetched_at: Date.now() - 60_000, last_error: null }] }),
          first: async () => null,
          run: async () => ({ meta: {} }),
        }),
      }),
    },
  } as never;
  const runtime = withWidgets([
    { id: "w_1", name: "j-1", type: "json-api", url: "https://api.example.com/x", refresh_interval: "1h", fields: [{ label: "A", path: "a" }] },
  ]);
  const authed = (await renderMain(dbEnv, runtime, 0, true)).value;
  const btn = authed.indexOf('class="w-refresh"');
  const stamp = authed.indexOf("updated ");
  assert.ok(btn > -1 && stamp > -1, "both footer parts render for owners");
  assert.ok(btn < stamp, "refresh icon comes before the updated stamp");
  assert.match(authed, /class="w-log" href="\/settings\/log\?widget=w_1"/);
  // public: plain stamp, no button and no log link
  const anon = (await renderMain(dbEnv, runtime, 0, false)).value;
  assert.match(anon, /updated /);
  assert.ok(!anon.includes("w-refresh") && !anon.includes("w-log"));
});

// Freshness stamp states. A failed refresh writes only last_error and
// updated_at, so payload/fetched_at keep pointing at the last SUCCESS -
// these pin that the card says so rather than leaving one ambiguous
// timestamp under a red line.
function stampEnv(over: { fetchedAt: number; last_error?: string | null; updated_at?: number | null }) {
  const row = {
    instance_id: "w_1",
    source_rev: 1,
    payload: JSON.stringify({ fetchedAt: over.fetchedAt, data: { values: [] } }),
    current_key: null,
    prev_key: null,
    fetched_at: over.fetchedAt,
    last_error: over.last_error ?? null,
    updated_at: over.updated_at ?? null,
  };
  return {
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [row] }), first: async () => null, run: async () => ({ meta: {} }) }),
      }),
    },
  } as never;
}
const stampWidget = () =>
  withWidgets([
    { id: "w_1", name: "j-1", type: "json-api", url: "https://api.example.com/x", refresh_interval: "15m", fields: [{ label: "A", path: "a" }] },
  ]);

test("stamp: a healthy card just says when it updated", async () => {
  const out = (await renderMain(stampEnv({ fetchedAt: Date.now() - 60_000 }), stampWidget(), 0)).value;
  assert.match(out, /updated 1m ago/);
  assert.ok(!out.includes("stamp-stale"), "healthy cards carry no mark");
  assert.ok(!out.includes("overdue") && !out.includes("showing data from"));
});

// The error text belongs to the STAMP's tooltip, not the card body: it is
// diagnostics about the card rather than content of it, and a long error
// line used to push real content down (or out of a fit-screen column)
// every time a source blipped.
test("stamp: a failed fetch names both times - when it failed, and how old the data is", async () => {
  const out = (
    await renderMain(
      stampEnv({ fetchedAt: Date.now() - 3 * 3600_000, last_error: "timeout", updated_at: Date.now() - 4 * 60_000 }),
      stampWidget(),
      0,
    )
  ).value;
  assert.match(out, /title="last fetch failed 4m ago: timeout"/);
  assert.match(out, /showing data from 3h ago/); // whose timestamp it is, said plainly
  assert.match(out, /stamp-stale/);
  assert.ok(!out.includes("updated 3h ago"), "the bare wording would read as the failure's age");
  assert.ok(!/<p class="error">last fetch failed/.test(out), "the card body no longer carries the error");
});

test("stamp: a failure with no recorded time still reads correctly", async () => {
  const out = (
    await renderMain(stampEnv({ fetchedAt: Date.now() - 3600_000, last_error: "boom" }), stampWidget(), 0)
  ).value;
  assert.match(out, /title="last fetch failed: boom"/);
  assert.match(out, /showing data from 1h ago/);
});

// The one case with no success to stamp: without a stamp of its own the
// failure would have nowhere left to appear at all.
test("stamp: a card that never fetched still reports its failure", async () => {
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [{
              instance_id: "w_1", source_rev: 1, payload: null, current_key: null, prev_key: null,
              fetched_at: null, last_error: "dns lookup failed", updated_at: Date.now() - 2 * 60_000,
            }],
          }),
          first: async () => null,
          run: async () => ({ meta: {} }),
        }),
      }),
    },
  } as never;
  const out = (await renderMain(env, stampWidget(), 0)).value;
  assert.match(out, /fetch failed 2m ago/);
  assert.match(out, /title="dns lookup failed"/);
  assert.match(out, /stamp-stale/);
  assert.match(out, /refresh pending/, "the body still says why there is nothing to show");
});

// An overdue card has no error text to borrow, so its tooltip has to
// explain the mark on its own.
test("stamp: the overdue mark carries its own explanation", async () => {
  const out = (await renderMain(stampEnv({ fetchedAt: Date.now() - 2 * 3600_000 }), stampWidget(), 0)).value;
  assert.match(
    out,
    /title="last successful refresh 2h ago - well past the 15m refresh interval, and nothing was recorded as failing"/,
  );
});

// A healthy stamp is bare text - no wrapper, and nothing to hover.
test("stamp: a healthy card has no tooltip", async () => {
  const out = (await renderMain(stampEnv({ fetchedAt: Date.now() - 60_000 }), stampWidget(), 0)).value;
  assert.ok(!/title=""/.test(out), "an empty tooltip is worse than none");
});

test("stamp: data far past its interval is overdue even with no error recorded", async () => {
  // 15m interval, last success 2h ago, nothing logged as failing: the
  // silent case (a sweep that stopped running) nothing else surfaces
  const out = (await renderMain(stampEnv({ fetchedAt: Date.now() - 2 * 3600_000 }), stampWidget(), 0)).value;
  assert.match(out, /updated 2h ago · overdue/);
  assert.match(out, /stamp-stale/);
  // one missed sweep is not overdue
  const fine = (await renderMain(stampEnv({ fetchedAt: Date.now() - 20 * 60_000 }), stampWidget(), 0)).value;
  assert.match(fine, /updated 20m ago/);
  assert.ok(!fine.includes("overdue"));
});

test("countdown formats: auto keeps two units, the rest are explicit floors", async () => {
  const { fmtRemaining } = await import("../src/widgets/countdown");
  const ms = (d: number, h: number, m: number, s: number) => ((d * 24 + h) * 60 + m) * 60_000 + s * 1000;
  const far = ms(141, 11, 23, 45);
  assert.equal(fmtRemaining(far, "auto"), "141d 11h");
  assert.equal(fmtRemaining(far, "days"), "141d");
  assert.equal(fmtRemaining(far, "minutes"), "141d 11h 23m");
  assert.equal(fmtRemaining(far, "seconds"), "141d 11h 23m 45s");
  // inside a day the larger units drop out rather than showing zeros
  const soon = ms(0, 0, 3, 7);
  assert.equal(fmtRemaining(soon, "auto"), "3m");
  assert.equal(fmtRemaining(soon, "seconds"), "3m 7s");
  assert.equal(fmtRemaining(soon, "days"), "under a day");
  assert.equal(fmtRemaining(0, "seconds"), "done");
  assert.equal(fmtRemaining(-5000, "auto"), "done");
});

test("countdown renders its format for the ticker to read", async () => {
  const runtime = withWidgets([
    { id: "w_1", name: "c-1", type: "countdown", target: "2099-01-01", format: "seconds" },
    { id: "w_2", name: "c-2", type: "countdown", target: "2099-01-01" },
  ]);
  const out = (await renderMain(fakeEnv(), runtime, 0)).value;
  assert.match(out, /data-fmt="seconds"/);
  assert.match(out, /data-fmt="auto"/); // unset falls back, never empty
});

test("clock formats: auto defers to the viewer, 12h/24h pin the style", async () => {
  const { clockOptions } = await import("../src/widgets/clock");
  assert.equal(clockOptions("auto").hour12, undefined); // locale decides
  assert.equal(clockOptions("auto").second, undefined);
  assert.equal(clockOptions("12h").hour12, true);
  assert.equal(clockOptions("24h").hour12, false);
  assert.equal(clockOptions("24h").hourCycle, "h23"); // 00:xx, never 24:xx
  assert.equal(clockOptions("24h + seconds").second, "2-digit");
  assert.equal(clockOptions("12h + seconds").hour12, true);
});

test("clock and countdown carry format and size to the client", async () => {
  const runtime = withWidgets([
    { id: "w_1", name: "k-1", type: "clock", clocks: [{ label: "SF", tz: "America/Los_Angeles" }], format: "24h + seconds", size: "large" },
    { id: "w_2", name: "c-1", type: "countdown", target: "2099-01-01", size: "x-large" },
  ]);
  const out = (await renderMain(fakeEnv(), runtime, 0)).value;
  assert.match(out, /data-fmt="24h \+ seconds"/);
  assert.match(out, /class="kv size-large"/);
  assert.match(out, /cd-remaining size-xlarge/);
  // an unknown size falls back rather than emitting a bogus class
  const bad = withWidgets([{ id: "w_3", name: "c-2", type: "countdown", target: "2099-01-01", size: "gigantic" }]);
  const out2 = (await renderMain(fakeEnv(), bad, 0)).value;
  assert.match(out2, /class="cd-remaining "/);
});
