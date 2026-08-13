import { test } from "node:test";
import { summarize } from "../src/editor/api";
import assert from "node:assert/strict";
import {
  validateDoc, parseProbeWidget, classifyDiff, countdownEpoch,
  enforceIdDiscipline, BUILTIN_THEMES,
} from "../src/config";

const page = (over: object = {}) => ({ name: "Home", rows: [{ columns: [{ width: "full", widgets: [] }] }], ...over });
const doc = (over: object = {}) => ({ pages: [page()], ...over });

test("validateDoc: minimal doc — theme stays empty (defaults live in CSS fallbacks)", () => {
  const { runtime } = validateDoc(doc());
  assert.equal(runtime.pages.length, 1);
  assert.deepEqual(runtime.theme, {});
});

test("pages round-trip the collapsed-navigation option", () => {
  const { runtime, doc: normalized } = validateDoc(doc({ pages: [page({ collapse_navigation: true })] }));
  assert.equal(runtime.pages[0]!.collapseNav, true);
  assert.equal(normalized.pages[0]!.collapse_navigation, true);
  const plain = validateDoc(doc()).doc;
  assert.equal("collapse_navigation" in plain.pages[0]!, false);
});

test("validateDoc: bad column width rejected", () => {
  assert.throws(
    () => validateDoc({ pages: [{ name: "X", rows: [{ columns: [{ width: "7/9", widgets: [] }] }] }] }),
    /width must be one of/,
  );
});

test("validateDoc: legacy pages->columns shape normalizes", () => {
  const { runtime } = validateDoc({ pages: [{ name: "X", columns: [{ width: "full", widgets: [] }] }] });
  assert.equal(runtime.pages[0]!.rows.length, 1);
});

test("validateDoc: duplicate widget ids rejected", () => {
  const w = { id: "w_a", name: "hn-1", type: "hackernews", refresh_interval: "15m" };
  assert.throws(
    () => validateDoc({ pages: [{ name: "X", rows: [{ columns: [{ width: "full", widgets: [w, { ...w, name: "hn-2" }] }] }] }] }),
    /duplicate widget id/,
  );
});

test("widgets: clock accepts editor {label,path} shape and defaults trio", () => {
  const c = parseProbeWidget({ type: "clock", clocks: [{ label: "NYC", path: "America/New_York" }] }) as any;
  assert.equal(c.clocks[0].tz, "America/New_York");
  const d = parseProbeWidget({ type: "clock" }) as any;
  assert.equal(d.clocks.length, 3);
  assert.throws(() => parseProbeWidget({ type: "clock", clocks: [{ label: "X", tz: "Mars/Olympus" }] }), /unknown timezone/);
});

test("widgets: countdown zoned epoch handles DST and explicit offsets", () => {
  assert.equal(new Date(countdownEpoch("2026-12-31 17:00", "America/New_York")).toISOString(), "2026-12-31T22:00:00.000Z");
  assert.equal(new Date(countdownEpoch("2026-07-04 12:00", "America/New_York")).toISOString(), "2026-07-04T16:00:00.000Z");
  assert.equal(new Date(countdownEpoch("2026-12-31T17:00-05:00", "Asia/Tokyo")).toISOString(), "2026-12-31T22:00:00.000Z");
});

test("widgets: bookmarks derive titles, reject non-http urls", () => {
  const b = parseProbeWidget({ type: "bookmarks", links: [{ url: "https://github.com" }] }) as any;
  assert.equal(b.links[0].title, "github.com");
  assert.throws(() => parseProbeWidget({ type: "bookmarks", links: [{ url: "javascript:alert(1)" }] }), /http/);
});

test("widgets: search defaults + param validation", () => {
  const s = parseProbeWidget({ type: "search" }) as any;
  assert.equal(s.url, "https://duckduckgo.com/");
  assert.equal(s.param, "q");
  assert.throws(() => parseProbeWidget({ type: "search", param: "q uery" }), /parameter/);
});

test("widgets: crypto/stocks lists parse from strings and arrays", () => {
  const c = parseProbeWidget({ type: "crypto", coins: "bitcoin, ethereum", refresh_interval: "15m" }) as any;
  assert.deepEqual(c.coins, ["bitcoin", "ethereum"]);
  const st = parseProbeWidget({ type: "stocks", symbols: ["aapl", "^gspc"], refresh_interval: "15m" }) as any;
  assert.deepEqual(st.symbols, ["AAPL", "^GSPC"]);
  assert.throws(() => parseProbeWidget({ type: "crypto", coins: "bad id!", refresh_interval: "15m" }), /bad entry/);
});

test("widgets: image modes validated", () => {
  const direct = parseProbeWidget({ type: "image", url: "https://cam.example/c.jpg", refresh_interval: "15m" }) as any;
  assert.equal(direct.url, "https://cam.example/c.jpg");
  const json = parseProbeWidget({ type: "image", source_url: "https://xkcd.com/info.0.json", path: "img", image_origin: "https://imgs.xkcd.com", refresh_interval: "6h" }) as any;
  assert.equal(json.imageOrigin, "https://imgs.xkcd.com");
  assert.throws(() => parseProbeWidget({ type: "image", url: "http://cam.example/c.jpg", refresh_interval: "15m" }), /https/);
  assert.throws(() => parseProbeWidget({ type: "image", source_url: "https://x.example/a.json", path: "img", refresh_interval: "15m" }), /image_origin/);
});

test("widgets: derived field labels skip generic segments", () => {
  const w = parseProbeWidget({ type: "json-api", url: "https://x.example/a", refresh_interval: "1h",
    fields: [{ path: "result.0.text" }, { path: "items.0.story_title" }, { label: "Kept", path: "text" }] }) as any;
  assert.equal(w.fields[0].label, "");
  assert.equal(w.fields[1].label, "Story title");
  assert.equal(w.fields[2].label, "Kept");
});

test("themes: presets validate, pages select custom or built-in, bad names rejected", () => {
  const { runtime } = validateDoc(doc({
    themes: { night: { accent: "#ff0000" } },
    pages: [page({ theme: "night" }), page({ name: "B", theme: "terminal" })],
  }));
  assert.equal(runtime.pages[0]!.theme, "night");
  assert.ok(Object.keys(BUILTIN_THEMES).includes("terminal"));
  assert.throws(() => validateDoc(doc({ pages: [page({ theme: "nope" })] })), /must name a preset/);
  assert.throws(() => validateDoc(doc({ themes: { "Bad Name": {} } })), /kebab-case/);
});

test("themes: field validation (colors, radius, opacity, image refs)", () => {
  assert.throws(() => validateDoc(doc({ theme: { accent: "red" } })), /hex color/);
  assert.throws(() => validateDoc(doc({ theme: { radius: 7 } })), /radius/);
  assert.throws(() => validateDoc(doc({ theme: { card_opacity: 5 } })), /20-100/);
  assert.throws(() => validateDoc(doc({ theme: { background_image: "javascript:x" } })), /asset|https/);
});

test("classifyDiff: creation/removal/source changes need sources scope", () => {
  const w = { id: "w_a", name: "rss-1", type: "rss", urls: ["https://a.example/f"], refresh_interval: "1h" };
  const base = validateDoc({ pages: [{ name: "H", rows: [{ columns: [{ width: "full", widgets: [w] }] }] }] }).doc;
  const changed = validateDoc({ pages: [{ name: "H", rows: [{ columns: [{ width: "full", widgets: [{ ...w, urls: ["https://b.example/f"] }] }] }] }] }).doc;
  const diff = classifyDiff(base, changed);
  assert.equal(diff.sourceChangedIds.length, 1);
  assert.ok(diff.needsSources.length > 0);
});

test("classifyDiff: making a page public needs sources; private does not", () => {
  const priv = validateDoc(doc()).doc;
  const pub = validateDoc(doc({ pages: [page({ public: true })] })).doc;
  assert.ok(classifyDiff(priv, pub).needsSources.some((r) => /public/.test(r)));
  assert.equal(classifyDiff(pub, priv).needsSources.length, 0);
});

test("enforceIdDiscipline: unknown ids rejected, new widgets get ids", () => {
  const cand = { pages: [{ name: "H", rows: [{ columns: [{ width: "full", widgets: [{ type: "hackernews" }, { id: "w_known" }] }] }] }] };
  const created = enforceIdDiscipline(cand, new Set(["w_known"]));
  assert.equal(created.length, 1);
  assert.throws(
    () => enforceIdDiscipline({ pages: [{ name: "H", rows: [{ columns: [{ width: "full", widgets: [{ id: "w_evil" }] }] }] }] }, new Set()),
    /server-assigned/,
  );
});

test("seed config bootstraps: id assignment + validation, MCP demo included", async () => {
  const { seedRaw, enforceIdDiscipline: enforce, validateDoc: vd } = await import("../src/config");
  const raw = seedRaw() as Record<string, unknown>;
  const created = enforce(raw, new Set());
  const { runtime } = vd(raw);
  assert.ok(created.length >= 10);
  const types = new Set(runtime.widgets.map((w) => w.type));
  for (const t of ["heartbeat", "json-api", "mcp"]) assert.ok(types.has(t), `seed missing ${t}`);
});

test("theme.favicon rides the full image security pipeline", () => {
  const page = (theme: any, themes?: any) =>
    ({ theme, ...(themes ? { themes } : {}), pages: [{ name: "H", rows: [{ columns: [{ width: "full", widgets: [] }] }] }] });
  // external favicon change requires config:sources
  const base = validateDoc(page({ accent: "210 90% 60%" })).doc;
  const next = validateDoc(page({ accent: "210 90% 60%", favicon: "https://icons.example/f.png" })).doc;
  const diff = classifyDiff(base, next);
  assert.ok(diff.needsSources.some((l) => l.includes("favicon") && l.includes("icons.example")));
  // presets reject favicon like the other image fields
  assert.throws(() => validateDoc(page({ accent: "210 90% 60%" }, { p1: { accent: "1 1% 1%", favicon: "https://x.example/f.png" } })));
});

test("non-canonical https image URLs canonicalize and still need sources", () => {
  const page = (theme: any) =>
    ({ theme, pages: [{ name: "H", rows: [{ columns: [{ width: "full", widgets: [] }] }] }] });
  const base = validateDoc(page({ accent: "210 90% 60%" })).doc;
  for (const key of ["background_image", "logo", "favicon"]) {
    for (const raw of ["HTTPS://Icons.Example/f.png", "  https://icons.example/f.png"]) {
      const next = validateDoc(page({ accent: "210 90% 60%", [key]: raw })).doc;
      // stored form is canonical: lowercase scheme+host, trimmed
      assert.match(String(next.theme[key]), /^https:\/\/icons\.example\//, `${key} canonical for ${JSON.stringify(raw)}`);
      const diff = classifyDiff(base, next);
      assert.ok(
        diff.needsSources.some((l) => l.includes(key) && l.includes("https://icons.example")),
        `${key} needs sources for ${JSON.stringify(raw)}`
      );
    }
  }
});

test("row fill defaults on; fill:false round-trips", () => {
  const page = (row: any) => ({ pages: [{ name: "H", rows: [row] }] });
  const on = validateDoc(page({ columns: [{ width: "full", widgets: [] }] }));
  assert.equal(on.runtime.pages[0]!.rows[0]!.fill, true);
  assert.ok(!("fill" in on.doc.pages[0]!.rows[0]!));
  const off = validateDoc(page({ fill: false, columns: [{ width: "full", widgets: [] }] }));
  assert.equal(off.runtime.pages[0]!.rows[0]!.fill, false);
  assert.equal(off.doc.pages[0]!.rows[0]!.fill, false);
});

test("fill-only edits are reported, not 'No changes'", () => {
  const doc = (fill: boolean) => validateDoc({ pages: [{ name: "H", rows: [{ ...(fill ? {} : { fill: false }), columns: [{ width: "full", widgets: [] }] }] }] }).doc;
  const { summary } = summarize(doc(true), doc(false));
  assert.ok(summary.length > 0, "fill toggle must produce a summary entry");
});

test("refresh intervals accept days and reject sub-minute or bad units", () => {
  const w = (iv: string) =>
    parseProbeWidget({ type: "hackernews", refresh_interval: iv }) as { refreshSeconds: number };
  assert.equal(w("15m").refreshSeconds, 900);
  assert.equal(w("2h").refreshSeconds, 7200);
  assert.equal(w("1d").refreshSeconds, 86_400);   // days: new unit
  assert.equal(w("7d").refreshSeconds, 604_800);  // a weekly feed needs no 168h
  assert.equal(w("60s").refreshSeconds, 60);      // still accepted from YAML/MCP
  assert.throws(() => w("30s"), /below 60s/);
  assert.throws(() => w("15 min"), /bad interval/);
  assert.throws(() => w("1w"), /bad interval/);
});

// A page favicon is the same security question as a theme image, asked
// per page: an uploaded file contacts nobody, an external URL makes every
// viewer of that page call someone else's host.
test("page favicon: uploads are layout-scope, external URLs are not", () => {
  const doc = (favicon?: string) => ({
    theme: { accent: "210 90% 60%" },
    pages: [{ name: "H", ...(favicon ? { favicon } : {}), rows: [{ columns: [{ width: "full", widgets: [] }] }] }],
  });
  const base = validateDoc(doc()).doc;

  const uploaded = validateDoc(doc("/asset/favicon-abc123.svg")).doc;
  assert.equal(uploaded.pages[0]!.favicon, "/asset/favicon-abc123.svg", "svg uploads are storable refs");
  assert.deepEqual(classifyDiff(base, uploaded).needsSources, [], "an upload contacts nobody, so layout scope suffices");

  const external = validateDoc(doc("https://icons.example/f.png")).doc;
  assert.ok(
    classifyDiff(base, external).needsSources.some((l) => l.includes("favicon") && l.includes("icons.example")),
    "pointing a page at someone else's host is a sources-scope act",
  );
  // and it canonicalizes like every other stored ref
  assert.equal(validateDoc(doc("  HTTPS://Icons.Example/f.png")).doc.pages[0]!.favicon, "https://icons.example/f.png");
  assert.throws(() => validateDoc(doc("javascript:alert(1)")), /uploaded \/asset\/ path or an https URL/);
});

test("page favicon: the runtime page carries it and the doc round-trips it", () => {
  const { runtime, doc } = validateDoc({
    theme: {},
    pages: [
      { name: "A", favicon: "/asset/favicon-aaa.svg", rows: [{ columns: [{ width: "full", widgets: [] }] }] },
      { name: "B", rows: [{ columns: [{ width: "full", widgets: [] }] }] },
    ],
  });
  assert.equal(runtime.pages[0]!.favicon, "/asset/favicon-aaa.svg");
  assert.equal(runtime.pages[1]!.favicon, undefined, "absent stays absent rather than becoming empty string");
  assert.equal(doc.pages[0]!.favicon, "/asset/favicon-aaa.svg");
  assert.ok(!("favicon" in doc.pages[1]!), "a page without one writes no key");
});

// The review dialog is the last thing read before publishing, so a change
// it does not mention is a change nobody agreed to. Setting a page icon
// summarized as "No changes" until this was covered.
test("page favicon: the pre-publish summary says so", () => {
  const doc = (favicon?: string) =>
    validateDoc({
      theme: {},
      pages: [{ name: "Home", ...(favicon ? { favicon } : {}), rows: [{ columns: [{ width: "full", widgets: [] }] }] }],
    }).doc;
  const set = summarize(doc(), doc("/asset/favicon-abc.svg")).summary;
  assert.ok(set.some((l) => l.includes("favicon") && l.includes("Home")), `expected a favicon line, got ${JSON.stringify(set)}`);
  const cleared = summarize(doc("/asset/favicon-abc.svg"), doc()).summary;
  assert.ok(cleared.some((l) => /Clear page "Home" favicon/.test(l)), `expected a clear line, got ${JSON.stringify(cleared)}`);
  assert.deepEqual(summarize(doc("/asset/favicon-abc.svg"), doc("/asset/favicon-abc.svg")).summary, [], "unchanged stays quiet");
});
