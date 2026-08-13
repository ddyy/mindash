import { test } from "node:test";
import assert from "node:assert/strict";
import { batchJobs } from "../src/refresh";
import { def as cryptoDef, type CryptoWidget } from "../src/widgets/crypto";

function widget(id: string, currency = "usd", coins = ["bitcoin"]): CryptoWidget {
  return { id, name: id, title: id, type: "crypto", refreshSeconds: 900, currency, coins };
}

test("optional batching groups compatible widgets and honors maxBatchSize", () => {
  const widgets = [
    ...Array.from({ length: 9 }, (_, i) => widget(`usd-${i}`)),
    widget("eur-1", "eur"),
  ];
  const jobs = batchJobs(widgets as any, "cron") as any[];
  assert.deepEqual(jobs.map((job) => job.widgets.length).sort((a, b) => a - b), [1, 1, 8]);
  assert.ok(jobs.every((job) => job.batch), "crypto uses its optional batch provider");
  assert.ok(jobs.every((job) => new Set(job.widgets.map((x: any) => x.currency)).size === 1));
});

test("crypto batch unions coin ids once and fans results out by widget id", async () => {
  const oldFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({
      bitcoin: { usd: 100, usd_24h_change: 1 },
      ethereum: { usd: 50, usd_24h_change: -2 },
      solana: { usd: 25, usd_24h_change: 3 },
    }), { headers: { "content-type": "application/json" } });
  };
  try {
    const batch = cryptoDef.batch;
    assert.ok(batch);
    const results = await batch.fetch([
      widget("a", "usd", ["bitcoin", "ethereum"]),
      widget("b", "usd", ["ethereum", "solana"]),
    ], {} as Env);
    assert.equal(urls.length, 1);
    const url = new URL(urls[0] ?? "");
    assert.deepEqual(new Set((url.searchParams.get("ids") ?? "").split(",")), new Set(["bitcoin", "ethereum", "solana"]));
    assert.deepEqual(results.get("a")?.rows.map((x) => x.name), ["Bitcoin", "Ethereum"]);
    assert.deepEqual(results.get("b")?.rows.map((x) => x.name), ["Ethereum", "Solana"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
