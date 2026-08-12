// Outbound-fetch safety contract shared by every pull widget (see
// the design notes): https/public only, bounded deadlines, manual
// redirects with a hop limit, content-type checks, and a decoded-body cap
// enforced while consuming the stream - one hostile source must not be able
// to take down the whole sweep.

export interface FetchLimits {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string[];
  headers?: Record<string, string>; // credentialed fetches refuse redirects
  method?: "GET" | "POST" | "DELETE" | "HEAD";
  body?: string;
  // Return the first maxBytes instead of throwing when a body exceeds the
  // cap - for pages whose useful data lives at the top (head metadata).
  allowTruncate?: boolean;
}

export interface RawFetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  text: string;
  headers: Headers;
}

const DEFAULTS = { maxBytes: 1_000_000, timeoutMs: 10_000, maxRedirects: 3 };

// Plain http is allowed for UNCREDENTIALED fetches (old RSS feeds often
// have no TLS; content is escaped by construction so spoofing can't become
// script). Credentialed requests are https-only - enforced in safeFetchText.
function assertPublicHttp(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`blocked destination scheme: ${url.protocol}//${url.hostname}`);
  }
  const host = url.hostname;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":")
  ) {
    throw new Error(`blocked non-public destination: ${host}`);
  }
}

// Core fetch under the full safety contract; returns status + headers so
// protocol clients (MCP) can react to non-2xx without losing the limits.
export async function safeFetchRaw(rawUrl: string, limits: FetchLimits = {}): Promise<RawFetchResult> {
  const { maxBytes, timeoutMs, maxRedirects, headers, method, body } = { ...DEFAULTS, ...limits };
  let url = new URL(rawUrl);
  const credentialed = (headers !== undefined && Object.keys(headers).length > 0) || method === "POST" || method === "DELETE";
  for (let hop = 0; ; hop++) {
    assertPublicHttp(url);
    if (credentialed && url.protocol !== "https:") {
      throw new Error("credentialed requests must use https");
    }
    const res = await fetch(url.toString(), {
      method: method ?? "GET",
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", ...headers },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      // Credentialed requests (and all POSTs) never follow redirects - a
      // credential or body must not be replayed to a location the policy
      // didn't name.
      if (credentialed) {
        throw new Error(`credentialed request redirected (${res.status}); refusing`);
      }
      if (!loc || hop >= maxRedirects) {
        throw new Error(`redirect limit exceeded or missing location (${res.status})`);
      }
      url = new URL(loc, url);
      continue;
    }
    return {
      ok: res.ok,
      status: res.status,
      contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
      text: await readBounded(res, maxBytes, limits.allowTruncate === true),
      headers: res.headers,
    };
  }
}

export async function safeFetchText(rawUrl: string, limits: FetchLimits = {}): Promise<string> {
  const res = await safeFetchRaw(rawUrl, limits);
  if (!res.ok) {
    throw new Error(`upstream ${res.status} from ${new URL(rawUrl).hostname}`);
  }
  const accept = limits.accept;
  if (accept && accept.length > 0 && !accept.some((a) => res.contentType.startsWith(a))) {
    throw new Error(`unexpected content-type "${res.contentType}" from ${new URL(rawUrl).hostname}`);
  }
  return res.text;
}

async function readBounded(res: Response, maxBytes: number, allowTruncate = false): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      if (!allowTruncate) throw new Error(`response exceeded ${maxBytes} byte cap`);
      // keep exactly the remaining prefix of the overflowing chunk
      const keep = value.subarray(0, maxBytes - total);
      if (keep.byteLength > 0) {
        chunks.push(keep);
        total += keep.byteLength;
      }
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function safeFetchJson(rawUrl: string, limits: FetchLimits = {}): Promise<unknown> {
  const text = await safeFetchText(rawUrl, { accept: ["application/json"], ...limits });
  return JSON.parse(text);
}
