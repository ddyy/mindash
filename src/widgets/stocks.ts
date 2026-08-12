import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { safeFetchText } from "../safefetch";
import { deltaSpan } from "./crypto";

export interface StocksWidget extends WidgetCommon {
  type: "stocks";
  symbols: string[];
}

// Stock ticker via Yahoo's keyless v8 chart endpoint (the same source
// Glance's market widget uses). One request per symbol; a symbol that
// fails becomes a "-" row instead of failing the whole widget.

export interface StocksData {
  rows: { symbol: string; price: number | null; change: number | null }[];
}

interface ChartResponse {
  chart?: {
    result?: {
      meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number };
    }[];
  };
}

async function quote(symbol: string): Promise<StocksData["rows"][number] & { err?: string }> {
  try {
    const text = await safeFetchText(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
    );
    let body: ChartResponse;
    try {
      body = JSON.parse(text) as ChartResponse;
    } catch {
      // Yahoo rate-limits with a 200 + plain-text body
      const reason = /too many requests/i.test(text) ? "rate limited by Yahoo - try again later" : "non-JSON response";
      return { symbol, price: null, change: null, err: reason };
    }
    const meta = body.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const prev = meta?.chartPreviousClose ?? meta?.previousClose;
    if (typeof price !== "number") return { symbol, price: null, change: null, err: "unknown symbol" };
    const change = typeof prev === "number" && prev > 0 ? ((price - prev) / prev) * 100 : null;
    return { symbol, price, change };
  } catch (e) {
    return { symbol, price: null, change: null, err: String(e instanceof Error ? e.message : e) };
  }
}

export async function fetchData(cfg: StocksWidget): Promise<StocksData> {
  const rows = await Promise.all(cfg.symbols.map(quote));
  if (rows.every((r) => r.price === null)) {
    throw new Error(rows[0]?.err ?? "no quotes returned - check the symbols");
  }
  return { rows: rows.map(({ symbol, price, change }) => ({ symbol, price, change })) };
}

export function render(data: StocksData, _cfg: StocksWidget): SafeHtml {
  return html`<ul class="kv">
    ${data.rows.map(
      (r) => html`<li><span class="k">${r.symbol}</span><span class="v">${
        r.price === null
          ? "-"
          : r.price.toLocaleString("en-US", { maximumFractionDigits: r.price >= 1000 ? 0 : 2 })
      } ${deltaSpan(r.change)}</span></li>`,
    )}
  </ul>`;
}

export const def: WidgetDef<StocksWidget, StocksData> = {
  meta: {
    title: "Stocks",
    icon: "📈",
    category: "Markets",
    description: "Quotes and day change via Yahoo Finance (no key).",
  },
  sourceFields: [],
  form: [
    { key: "symbols", label: "Symbols", kind: "strlist", search: "stocks", prefill: "AAPL, MSFT, SPY", placeholder: "AAPL", help: "Search or type tickers; indexes like ^GSPC work too." },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, prefill: "15m", placeholder: "15m" },
  ],
  parse(w, where, common, h) {
    const refreshSeconds = h.parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    const symbols = h.strList(w.symbols, `${where}.symbols`, /^[A-Za-z0-9.^=-]{1,12}$/, 12).map((x) =>
      x.toUpperCase(),
    );
    if (symbols.length === 0) throw new Error(`${where}: at least one symbol required`);
    return { ...common, refreshSeconds, type: "stocks", symbols };
  },
  fetchData,
  render,
};
