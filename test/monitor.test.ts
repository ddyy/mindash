import { test } from "node:test";
import assert from "node:assert/strict";
import { def as monitorDef, fetchData, render, type MonitorWidget } from "../src/widgets/monitor";
import { parseHelpers } from "../src/widgets/def";

const common = { id: "w1", name: "mon", title: "Monitor" };

function cfg(sites: { title: string; url: string }[]): MonitorWidget {
  return { ...common, type: "monitor", refreshSeconds: 300, sites };
}

test("parse: urls validated, titles default to hostname, caps enforced", () => {
  const w = monitorDef.parse(
    { sites: [{ url: "https://demo.mindash.dev" }, { title: "GH", url: "https://github.com" }], refresh_interval: "5m" },
    "pages[0].widgets[0]",
    common,
    parseHelpers,
  ) as MonitorWidget;
  assert.equal(w.sites[0]!.title, "demo.mindash.dev");
  assert.equal(w.sites[1]!.title, "GH");
  assert.equal(w.refreshSeconds, 300);
  assert.throws(() => monitorDef.parse({ sites: [], refresh_interval: "5m" }, "w", common, parseHelpers), /at least one/);
  assert.throws(
    () => monitorDef.parse({ sites: [{ url: "ftp://x.example" }], refresh_interval: "5m" }, "w", common, parseHelpers),
    /http/,
  );
});

test("fetchData: up rows, HEAD->GET fallback on 405, per-site failure isolation", async () => {
  const origFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    methods.push(`${init.method} ${new URL(u).hostname}`);
    if (u.includes("up.example")) return new Response(null, { status: 200 });
    if (u.includes("headless.example")) {
      return init.method === "HEAD" ? new Response(null, { status: 405 }) : new Response("ok", { status: 200 });
    }
    if (u.includes("broken.example")) return new Response("boom", { status: 500 });
    throw new Error("getaddrinfo ENOTFOUND");
  }) as any;
  try {
    const data = await fetchData(
      cfg([
        { title: "Up", url: "https://up.example" },
        { title: "NoHead", url: "https://headless.example" },
        { title: "Broken", url: "https://broken.example" },
        { title: "Gone", url: "https://gone.example" },
      ]),
    );
    assert.deepEqual(
      data.rows.map((r) => [r.title, r.up, r.status]),
      [["Up", true, 200], ["NoHead", true, 200], ["Broken", false, 500], ["Gone", false, null]],
    );
    assert.ok(methods.includes("HEAD headless.example") && methods.includes("GET headless.example"));
    assert.match(data.rows[3]!.err!, /ENOTFOUND/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("render: latency for up rows, code/error text for down rows", () => {
  const out = render(
    {
      rows: [
        { title: "Up", url: "https://up.example", up: true, status: 200, ms: 142 },
        { title: "Broken", url: "https://broken.example", up: false, status: 500, ms: 30 },
        { title: "Gone", url: "https://gone.example", up: false, status: null, ms: 0, err: "timeout" },
      ],
    },
    cfg([{ title: "Up", url: "https://up.example" }]),
  ).toString();
  assert.match(out, /dot up/);
  assert.match(out, /142 ms/);
  assert.match(out, /HTTP 500/);
  assert.match(out, /timeout/);
  assert.match(out, /href="https:\/\/up\.example/);
});

test("history: rolls forward through the cached payload, capped, keyed by url", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as any;
  const prevHistory = {
    "https://up.example": Array.from({ length: 40 }, (_, i) => ({ t: i, up: i % 5 !== 0 })),
    "https://removed.example": [{ t: 1, up: true }],
  };
  const envStub = {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ payload: JSON.stringify({ fetchedAt: 1, data: { rows: [], history: prevHistory } }) }),
        }),
      }),
    },
  } as unknown as Env;
  try {
    const data = await fetchData(cfg([{ title: "Up", url: "https://up.example" }]), envStub);
    const h = data.history!["https://up.example"]!;
    assert.equal(h.length, 30); // 40 prior + 1 new, capped at 30
    assert.equal(h[h.length - 1]!.up, true); // newest entry is this check
    assert.ok(!("https://removed.example" in data.history!)); // dropped sites fall away
    // without an env (probes, tests) history starts fresh instead of failing
    const bare = await fetchData(cfg([{ title: "Up", url: "https://up.example" }]));
    assert.equal(bare.history!["https://up.example"]!.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("render: history bars appear once there are 2+ checks, with ok/fail classes", () => {
  const rows = [{ title: "Up", url: "https://up.example", up: true, status: 200, ms: 10 }];
  const two = render(
    { rows, history: { "https://up.example": [{ t: 1, up: true }, { t: 2, up: false }] } },
    cfg([{ title: "Up", url: "https://up.example" }]),
  ).toString();
  assert.match(two, /mon-bars/);
  assert.match(two, /bar ok/);
  assert.match(two, /bar fail/);
  const one = render(
    { rows, history: { "https://up.example": [{ t: 1, up: true }] } },
    cfg([{ title: "Up", url: "https://up.example" }]),
  ).toString();
  assert.ok(!one.includes("mon-bars")); // a single check draws no strip
});

test("render: latency graph - bar heights scale to the site's slowest check", () => {
  const rows = [{ title: "Up", url: "https://up.example", up: true, status: 200, ms: 10 }];
  const out = render(
    {
      rows,
      history: {
        "https://up.example": [
          { t: 1, up: true, ms: 400 },   // slowest -> full height
          { t: 2, up: true, ms: 100 },   // quarter height
          { t: 3, up: true, ms: 1 },     // floored
          { t: 4, up: false },           // down -> full-height red
        ],
      },
    },
    cfg([{ title: "Up", url: "https://up.example" }]),
  ).toString();
  assert.match(out, /bar ok" style="height:16px" title="[^"]+ · 400 ms"/);
  assert.match(out, /bar ok" style="height:4px" title="[^"]+ · 100 ms"/);
  assert.match(out, /bar ok" style="height:3px" title="[^"]+ · 1 ms"/);
  assert.match(out, /bar fail" style="height:16px" title="[^"]+ · down"/);
});

test("history: up entries store latency for the tooltip, down entries don't", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) =>
    String(url).includes("up.example") ? new Response(null, { status: 200 }) : new Response("x", { status: 500 })) as any;
  try {
    const data = await fetchData(
      cfg([
        { title: "Up", url: "https://up.example" },
        { title: "Down", url: "https://down.example" },
      ]),
    );
    const up = data.history!["https://up.example"]![0]!;
    const down = data.history!["https://down.example"]![0]!;
    assert.equal(typeof up.ms, "number");
    assert.ok(!("ms" in down));
  } finally {
    globalThis.fetch = origFetch;
  }
});
