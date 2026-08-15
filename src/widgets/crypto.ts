import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { safeFetchJson } from "../safefetch";
import { credentialHeader } from "../vault";

export interface CryptoWidget extends WidgetCommon {
  type: "crypto";
  coins: string[]; // CoinGecko ids
  currency: string;
  apiKeySecret?: string; // vault credential NAME (never a value)
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

async function fetchPrices(configs: readonly CryptoWidget[], env: Env): Promise<Map<string, CryptoData>> {
  if (configs.length === 0) return new Map();
  const currency = configs[0]?.currency;
  if (!currency || configs.some((cfg) => cfg.currency !== currency)) {
    throw new Error("crypto batch mixed incompatible currencies");
  }
  const coins = [...new Set(configs.flatMap((cfg) => cfg.coins))];
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coins.join(","))}` +
    `&vs_currencies=${encodeURIComponent(currency)}&include_24hr_change=true`;
  // Keyless calls share their rate limit with every other Cloudflare
  // customer on the same egress IP, which in practice means mostly 429s.
  // A (free) demo key gets a per-key limit instead. The vault emits it as
  // the bare x-cg-demo-api-key header CoinGecko expects.
  const secretName = configs.find((cfg) => cfg.apiKeySecret)?.apiKeySecret;
  const headers = secretName ? await credentialHeader(env, secretName, "crypto", url) : undefined;
  const body = (await safeFetchJson(url, headers ? { headers } : {})) as Record<
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

export async function fetchData(cfg: CryptoWidget, env: Env): Promise<CryptoData> {
  const result = await fetchPrices([cfg], env);
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
    description: "Prices and 24h change via CoinGecko - keyless, or with a free demo key for a rate limit of your own.",
  },
  sourceFields: ["api_key_secret"], // the key names a vault credential
  form: [
    { key: "coins", label: "Coins", kind: "strlist", search: "coins", prefill: "bitcoin, ethereum", placeholder: "bitcoin", help: "Add coins via search; remove with ✕." },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, prefill: "15m", placeholder: "15m" },
    { key: "currency", label: "Currency", kind: "text", advanced: true, placeholder: "usd" },
    {
      key: "api_key_secret",
      label: "CoinGecko API key (optional)",
      kind: "secret",
      advanced: true,
      help: "Names a Settings credential holding a free demo key. Keyless requests share one rate limit with every other Cloudflare user, so they mostly see 429s; a key gets its own.",
    },
  ],
  parse(w, where, common, h) {
    const refreshSeconds = h.parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    const coins = h.strList(w.coins, `${where}.coins`, /^[a-z0-9-]{1,50}$/, 12);
    if (coins.length === 0) throw new Error(`${where}: at least one coin id required`);
    const currency =
      typeof w.currency === "string" && w.currency.trim() ? w.currency.trim().toLowerCase() : "usd";
    if (!/^[a-z]{2,6}$/.test(currency)) throw new Error(`${where}: bad currency`);
    const apiKeySecret =
      typeof w.api_key_secret === "string" && w.api_key_secret.trim() ? w.api_key_secret.trim() : undefined;
    return { ...common, refreshSeconds, type: "crypto", coins, currency, ...(apiKeySecret ? { apiKeySecret } : {}) };
  },
  batch: {
    // Keyed and keyless requests must not share a batch: one request
    // carries one key, and a keyless rider would silently borrow it.
    groupKey: (cfg) => `${cfg.currency}:${cfg.apiKeySecret ?? ""}`,
    // Each widget accepts up to 12 coins. Keep a generous ceiling on the
    // union and URL length even when every widget contains distinct IDs.
    maxBatchSize: 8,
    fetch: fetchPrices,
  },
  fetchData,
  render,
};
