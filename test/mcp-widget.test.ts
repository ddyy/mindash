import { test } from "node:test";
import assert from "node:assert/strict";
import { render, def as mcpDef } from "../src/widgets/mcp";
import { parseHelpers } from "../src/widgets/def";

const parse = (raw: object) => (mcpDef as any).parse({ url: "https://docs.mcp.cloudflare.com/mcp", tool: "search_cloudflare_documentation", refresh_interval: "1h", ...raw }, "t", { id: "w_1", name: "m-1", title: "M" }, parseHelpers);

test("parse: any https MCP endpoint is accepted without code enrollment", () => {
  const cfg = (mcpDef as any).parse(
    { url: "https://any-server.example/mcp", tool: "some_tool", args: { anything: "goes" }, refresh_interval: "1h" },
    "t", { id: "w_1", name: "m-1", title: "M" }, parseHelpers,
  );
  assert.equal(cfg.url, "https://any-server.example/mcp");
  assert.equal(cfg.tool, "some_tool");
});

test("render precedence: fields > markdown > links > plain text", () => {
  const links = [{ title: "A", url: "https://a.example/1" }];
  const blocks = ["## Heading\n**bold**"];
  const fieldsCfg = parse({ fields: [{ path: "x" }] });
  assert.match(render({ values: [{ label: "X", value: "1" }], links, blocks }, fieldsCfg).value, /class="kv"/);
  const mdCfg = parse({ render: "markdown" });
  const mdOut = render({ values: [], links, blocks }, mdCfg).value;
  assert.match(mdOut, /mcp-h/);
  assert.ok(!mdOut.includes('class="feed"'));
  const plainCfg = parse({});
  assert.match(render({ values: [], links, blocks }, plainCfg).value, /class="feed"/);
  assert.match(render({ values: [], links: [], blocks }, plainCfg).value, /## Heading/);
});

test("parse: OAuth connection is accepted, but not alongside a credential", () => {
  const cfg = parse({ connection: "my-notes" });
  assert.equal(cfg.connection, "my-notes");
  assert.throws(() => parse({ connection: "Bad Name" }), /kebab-case/);
  assert.throws(() => parse({ connection: "my-notes", auth_secret: "gh" }), /not both/);
});

test("parse: tool name pattern and args shape validated", () => {
  assert.throws(() => parse({ tool: "bad tool!" }), /bad tool name/);
  assert.throws(() => parse({ args: [1] }), /JSON object/);
  const ok = parse({ args: { query: "x" }, render: "markdown" });
  assert.equal(ok.markdown, true);
});

test("empty labels render without a label span", () => {
  const cfg = parse({ fields: [{ path: "text" }] });
  const out = render({ values: [{ label: "", value: "v" }], links: [], blocks: [] }, cfg).value;
  assert.ok(!out.includes('class="k"'));
  assert.match(out, /class="v"/);
});
