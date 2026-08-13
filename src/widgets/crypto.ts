import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { safeFetchJson } from "../safefetch";

export interface CryptoWidget extends WidgetCommon {
  type: "crypto";
  coins: string[]; // CoinGecko ids
  currency: string;
}

// Crypto ticker via CoinGecko's keyless simple/price endpoint. One request
// covers every configured coin; ids are CoinGecko ids (bitcoin, ethereum).

export interface CryptoData {
  rows: { name: string; price: number | null; change: number | null }[];
  currency: string;
}

function pretty(id: string): string {
  return id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

async function fetchPrices(configs: readonly CryptoWidget[]): Promise<Map<string, CryptoData>> {
  if (configs.length === 0) return new Map();
  const currency = configs[0]?.currency;
  if (!currency || configs.some((cfg) => cfg.currency !== currency)) {
    throw new Error("crypto batch mixed incompatible currencies");
  }
  const coins = [...new Set(configs.flatMap((cfg) => cfg.coins))];
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coins.join(","))}` +
    `&vs_currencies=${encodeURIComponent(currency)}&include_24hr_change=true`;
  const body = (await safeFetchJson(url)) as Record<
    string,
    Record<string, number | undefined> | undefined
  >;
  return new Map(configs.map((cfg) => [
    cfg.id,
    {
      currency: cfg.currency,
      rows: cfg.coins.map((id) => {
        const entry = body[id];
        const price = entry?.[cfg.currency];
        const change = entry?.[`${cfg.currency}_24h_change`];
        return {
          name: pretty(id),
          price: typeof price === "number" ? price : null,
          change: typeof change === "number" ? change : null,
        };
      }),
    },
  ]));
}

export async function fetchData(cfg: CryptoWidget): Promise<CryptoData> {
  const result = await fetchPrices([cfg]);
  const data = result.get(cfg.id);
  if (!data) throw new Error("crypto provider returned no result");
  return data;
}

export function formatPrice(v: number, currency: string): string {
  const sym = currency === "usd" ? "$" : currency === "eur" ? "€" : currency === "gbp" ? "£" : "";
  const num =
    v >= 1000
      ? v.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : v >= 1
        ? v.toLocaleString("en-US", { maximumFractionDigits: 2 })
        : v.toPrecision(3);
  return sym ? `${sym}${num}` : `${num} ${currency.toUpperCase()}`;
}

export function deltaSpan(change: number | null): SafeHtml | null {
  if (change === null) return null;
  const cls = change >= 0 ? "delta up" : "delta down";
  return html`<span class="${cls}">${change >= 0 ? "+" : ""}${change.toFixed(1)}%</span>`;
}

export function render(data: CryptoData, _cfg: CryptoWidget): SafeHtml {
  return html`<ul class="kv">
    ${data.rows.map(
      (r) => html`<li><span class="k">${r.name}</span><span class="v">${
        r.price === null ? "-" : formatPrice(r.price, data.currency)
      } ${deltaSpan(r.change)}</span></li>`,
    )}
  </ul>`;
}

export const def: WidgetDef<CryptoWidget, CryptoData> = {
  meta: {
    title: "Crypto prices",
    icon: "🪙",
    defaultTitle: "Crypto",
    category: "Markets",
    description: "Prices and 24h change via CoinGecko (no key).",
  },
  sourceFields: [], // fixed public API host; coin list is presentation
  form: [
    { key: "coins", label: "Coins", kind: "strlist", search: "coins", prefill: "bitcoin, ethereum", placeholder: "bitcoin", help: "Add coins via search; remove with ✕." },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, prefill: "15m", placeholder: "15m" },
    { key: "currency", label: "Currency", kind: "text", advanced: true, placeholder: "usd" },
  ],
  parse(w, where, common, h) {
    const refreshSeconds = h.parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    const coins = h.strList(w.coins, `${where}.coins`, /^[a-z0-9-]{1,50}$/, 12);
    if (coins.length === 0) throw new Error(`${where}: at least one coin id required`);
    const currency =
      typeof w.currency === "string" && w.currency.trim() ? w.currency.trim().toLowerCase() : "usd";
    if (!/^[a-z]{2,6}$/.test(currency)) throw new Error(`${where}: bad currency`);
    return { ...common, refreshSeconds, type: "crypto", coins, currency };
  },
  batch: {
    groupKey: (cfg) => cfg.currency,
    // Each widget accepts up to 12 coins. Keep a generous ceiling on the
    // union and URL length even when every widget contains distinct IDs.
    maxBatchSize: 8,
    fetch: fetchPrices,
  },
  fetchData,
  render,
};
