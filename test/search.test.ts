import { test } from "node:test";
import assert from "node:assert/strict";
import { def, ENGINES, ENGINE_OPTIONS, renderStatic, type SearchWidget } from "../src/widgets/search";
import { parseHelpers } from "../src/widgets/def";

const common = { id: "w_1", name: "s-1", title: "Search" };
const parse = (raw: Record<string, unknown>) =>
  def.parse(raw, "pages[0].widgets[0]", common, parseHelpers) as SearchWidget;

test("search: a preset sets the URL and the query parameter together", () => {
  // the parameter is the point - these three disagree
  assert.deepEqual(
    [parse({ engine: "Google" }), parse({ engine: "Startpage" }), parse({ engine: "YouTube" })].map((w) => [w.url, w.param]),
    [
      ["https://www.google.com/search", "q"],
      ["https://www.startpage.com/sp/search", "query"],
      ["https://www.youtube.com/results", "search_query"],
    ],
  );
});

test("search: preset names are matched case-insensitively", () => {
  assert.equal(parse({ engine: "duckduckgo" }).url, ENGINES.duckduckgo!.url);
  assert.equal(parse({ engine: "  BING  " }).url, ENGINES.bing!.url);
});

test("search: a preset overrides any URL left in the config", () => {
  const w = parse({ engine: "Bing", url: "https://example.com/", param: "zzz" });
  assert.equal(w.url, "https://www.bing.com/search");
  assert.equal(w.param, "q");
});

test("search: Custom hands control back to the URL and parameter fields", () => {
  const w = parse({ engine: "Custom", url: "https://search.marginalia.nu/search", param: "query" });
  assert.equal(w.url, "https://search.marginalia.nu/search");
  assert.equal(w.param, "query");
});

// Configs written before presets existed have a url and no engine.
test("search: a config with no engine keeps using its own URL", () => {
  const legacy = parse({ url: "https://search.marginalia.nu/search", param: "query" });
  assert.equal(legacy.url, "https://search.marginalia.nu/search");
  assert.equal(legacy.param, "query");
  // and a bare widget still defaults to something that works
  const bare = parse({});
  assert.equal(bare.url, ENGINES.duckduckgo!.url);
  assert.equal(bare.param, "q");
});

test("search: an unknown engine is refused rather than sent somewhere else", () => {
  assert.throws(() => parse({ engine: "Googel" }), /unknown search engine "Googel"/);
});

test("search: the CSP names the preset's origin, not the stale url field", () => {
  const w = parse({ engine: "Kagi", url: "https://example.com/" });
  assert.deepEqual(def.cspOrigins!(w), { form: ["https://kagi.com"] });
});

test("search: every option in the editor's list resolves (except Custom)", () => {
  for (const name of ENGINE_OPTIONS) {
    if (name === "Custom") continue;
    const w = parse({ engine: name });
    assert.ok(w.url.startsWith("https://"), `${name} has no https URL`);
    assert.match(w.param, /^[A-Za-z0-9_-]+$/, `${name} has a bad parameter`);
  }
  assert.equal(ENGINE_OPTIONS[0], "Custom", "unset must display as Custom, which is what unset means");
});

test("search: the form posts to the resolved engine with its parameter", () => {
  const out = renderStatic(parse({ engine: "Wikipedia" })).value;
  assert.match(out, /action="https:\/\/en\.wikipedia\.org\/w\/index\.php"/);
  assert.match(out, /name="search"/);
});
