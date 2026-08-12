export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// CSRF boundary for cookie/pre-auth POST endpoints (SameSite=Lax is a
// mitigation, not the boundary).
// Fetch Metadata is the primary signal: browsers control Sec-Fetch-Site and
// our Referrer-Policy: no-referrer makes Chrome serialize Origin as "null"
// even on same-origin form POSTs, so Origin alone would false-negative.
export function sameOriginOk(req: Request, url: URL): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return false;
  const origin = req.headers.get("origin");
  if (origin === url.origin) return true;
  if (site === "same-origin" || site === "none") return true;
  return false;
}
