import { test } from "node:test";
import assert from "node:assert/strict";
import { discover, connectionHeader, parseBearerChallenge, canonicalResource } from "../src/mcpclient";
import { sealSecret, openSecret } from "../src/vault";

// ---- fetch mocking ----
type Route = (url: string, init: RequestInit) => Response | undefined;
const realFetch = globalThis.fetch;
function withFetch(route: Route): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const res = route(url, init ?? {});
    return res ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const restoreFetch = (): void => {
  globalThis.fetch = realFetch;
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// ---- fake env (in-memory KV + a D1 stub for the connection statements) ----
interface ConnRow {
  name: string;
  server_url: string;
  origin: string;
  token_endpoint: string;
  client_id: string;
  scopes: string | null;
  ciphertext: string;
  iv: string;
  created_at: number;
  token_version: number;
  refresh_lease_until: number | null;
  binding_version: number;
}
function fakeEnv(row: ConnRow): Env {
  const kv = new Map<string, string>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes("SELECT * FROM mcp_connections")) {
                return args[0] === row.name ? { ...row } : null;
              }
              throw new Error(`unexpected first(): ${sql}`);
            },
            async run() {
              if (sql.includes("SET refresh_lease_until = ?1")) {
                const [until, name, version, now] = args as [number, string, number, number];
                const ok =
                  name === row.name &&
                  version === row.token_version &&
                  (row.refresh_lease_until === null || row.refresh_lease_until < now);
                if (ok) row.refresh_lease_until = until;
                return { meta: { changed_db: ok } };
              }
              if (sql.includes("token_version = token_version + 1")) {
                const [ct, iv, name, version] = args as [string, string, string, number];
                let ok = name === row.name && version === row.token_version;
                if (sql.includes("binding_version = 1")) ok = ok && row.binding_version === 1;
                if (ok) {
                  row.ciphertext = ct;
                  row.iv = iv;
                  row.token_version += 1;
                  row.refresh_lease_until = null;
                  if (sql.includes("binding_version = 2")) row.binding_version = 2;
                }
                return { meta: { changed_db: ok } };
              }
              if (sql.includes("SET refresh_lease_until = NULL")) {
                const [name, version] = args as [string, number];
                if (name === row.name && version === row.token_version) row.refresh_lease_until = null;
                return { meta: { changed_db: true } };
              }
              throw new Error(`unexpected run(): ${sql}`);
            },
          };
        },
      };
    },
  };
  return {
    DB: db,
    OAUTH_KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => void kv.set(k, v),
    },
  } as unknown as Env;
}

// ---------- P1: exact resource binding ----------

test("connection tokens never cross paths on a shared origin", async () => {
  const server = "https://host.example/tenant-a/mcp";
  const row: ConnRow = {
    name: "tenant-a",
    server_url: server,
    origin: "https://host.example",
    token_endpoint: "https://as.example/token",
    client_id: "c1",
    scopes: null,
    ciphertext: "",
    iv: "",
    created_at: Date.now(),
    token_version: 0,
    refresh_lease_until: null,
    binding_version: 2,
  };
  const env = fakeEnv(row);
  const sealed = await sealSecret(
    env,
    `mindash-conn2|tenant-a|${server}|https://as.example/token|c1`,
    JSON.stringify({ access_token: "tok-a" }),
  );
  row.ciphertext = sealed.ciphertext;
  row.iv = sealed.iv;

  // exact resource (fragment ignored) gets the token
  const okHeader = await connectionHeader(env, "tenant-a", "https://host.example/tenant-a/mcp#frag");
  assert.equal(okHeader.authorization, "Bearer tok-a");
  // ANY other path on the same origin is refused
  await assert.rejects(
    () => connectionHeader(env, "tenant-a", "https://host.example/tenant-b/collector"),
    /bound to https:\/\/host\.example\/tenant-a\/mcp/,
  );
  await assert.rejects(() => connectionHeader(env, "tenant-a", "https://host.example/tenant-a/mcp/extra"));
});

// ---------- P2: concurrent refresh with single-use rotation ----------

test("concurrent refreshes serialize: one exchange, both callers succeed", async () => {
  const server = "https://host.example/mcp";
  const row: ConnRow = {
    name: "conn",
    server_url: server,
    origin: "https://host.example",
    token_endpoint: "https://as.example/token",
    client_id: "c1",
    scopes: null,
    ciphertext: "",
    iv: "",
    created_at: Date.now(),
    token_version: 0,
    refresh_lease_until: null,
    binding_version: 2,
  };
  const env = fakeEnv(row);
  const sealed = await sealSecret(
    env,
    `mindash-conn2|conn|${server}|https://as.example/token|c1`,
    JSON.stringify({ access_token: "old", refresh_token: "rt-1", expires_at: Date.now() + 1000 }),
  );
  row.ciphertext = sealed.ciphertext;
  row.iv = sealed.iv;

  let exchanges = 0;
  withFetch((url, init) => {
    if (url === "https://as.example/token") {
      const body = String(init.body);
      if (!body.includes("refresh_token=rt-1")) return json({ error: "invalid_grant" }, 400);
      exchanges++;
      if (exchanges > 1) return json({ error: "invalid_grant (single-use token reused)" }, 400);
      return json({ access_token: "new-tok", refresh_token: "rt-2", expires_in: 3600 });
    }
    return undefined;
  });
  try {
    const [h1, h2] = await Promise.all([
      connectionHeader(env, "conn", server),
      connectionHeader(env, "conn", server),
    ]);
    assert.equal(exchanges, 1, "exactly one token exchange");
    assert.equal(h1.authorization, "Bearer new-tok");
    assert.equal(h2.authorization, "Bearer new-tok");
    assert.equal(row.token_version, 1);
    assert.equal(row.refresh_lease_until, null);
  } finally {
    restoreFetch();
  }
});

// ---------- P1: discovery validation ----------

const MCP = "https://host.example/tenant-a/mcp";
const initChallenge = (rm?: string, scope?: string) =>
  new Response("unauthorized", {
    status: 401,
    headers: {
      "www-authenticate": `Bearer realm="mcp"${rm ? `, resource_metadata="${rm}"` : ""}${scope ? `, scope="${scope}"` : ""}`,
    },
  });

test("parseBearerChallenge extracts resource_metadata and scope", () => {
  const c = parseBearerChallenge('Bearer realm="x", resource_metadata="https://a.example/prm", scope="mcp.read mcp.write"');
  assert.equal(c.resourceMetadata, "https://a.example/prm");
  assert.equal(c.scope, "mcp.read mcp.write");
  assert.deepEqual(parseBearerChallenge("Basic foo"), {});
});

test("discovery follows a challenge-only metadata URL", async () => {
  withFetch((url) => {
    if (url === MCP) return initChallenge("https://host.example/custom/prm-location", "mcp.read");
    if (url === "https://host.example/custom/prm-location") {
      return json({ resource: MCP, authorization_servers: ["https://as.example"] });
    }
    if (url === "https://as.example/.well-known/oauth-authorization-server") {
      return json({
        issuer: "https://as.example",
        authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token",
        code_challenge_methods_supported: ["S256"],
      });
    }
    return undefined; // every constructed PRM candidate 404s
  });
  try {
    const d = await discover(MCP);
    assert.equal(d.tokenEndpoint, "https://as.example/token");
    assert.equal(d.scopes, "mcp.read"); // from the challenge
  } finally {
    restoreFetch();
  }
});

test("PRM whose resource mismatches is ignored", async () => {
  withFetch((url) => {
    if (url === MCP) return initChallenge();
    if (url.includes("oauth-protected-resource")) {
      // metadata claims a DIFFERENT resource — must not be trusted
      return json({ resource: "https://host.example/tenant-b/mcp", authorization_servers: ["https://as.example"] });
    }
    return undefined; // fallback AS (origin) has no metadata either
  });
  try {
    await assert.rejects(() => discover(MCP), /no valid OAuth authorization server metadata/);
  } finally {
    restoreFetch();
  }
});

test("AS metadata with a mismatched issuer is rejected", async () => {
  withFetch((url) => {
    if (url === MCP) return initChallenge();
    if (url.includes("oauth-protected-resource")) {
      return json({ resource: MCP, authorization_servers: ["https://as.example"] });
    }
    if (url.startsWith("https://as.example/.well-known/")) {
      return json({
        issuer: "https://other-as.example", // wrong identity
        authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token",
      });
    }
    return undefined;
  });
  try {
    await assert.rejects(() => discover(MCP), /no valid OAuth authorization server metadata/);
  } finally {
    restoreFetch();
  }
});

test("path-based issuers try the full RFC 8414/OIDC candidate set", async () => {
  const issuer = "https://as.example/tenant-a";
  withFetch((url) => {
    if (url === MCP) return initChallenge();
    if (url.includes("oauth-protected-resource")) {
      return json({ resource: MCP, authorization_servers: [issuer] });
    }
    // ONLY the OIDC path-suffix form exists
    if (url === "https://as.example/tenant-a/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: "https://as.example/tenant-a/authorize",
        token_endpoint: "https://as.example/tenant-a/token",
        code_challenge_methods_supported: ["S256"],
      });
    }
    return undefined;
  });
  try {
    const d = await discover(MCP);
    assert.equal(d.authorizationEndpoint, "https://as.example/tenant-a/authorize");
  } finally {
    restoreFetch();
  }
});

test("non-https endpoints are refused", async () => {
  withFetch((url) => {
    if (url === MCP) return initChallenge();
    if (url.includes("oauth-protected-resource")) {
      return json({ resource: MCP, authorization_servers: ["https://as.example"] });
    }
    if (url.startsWith("https://as.example/.well-known/")) {
      return json({
        issuer: "https://as.example",
        authorization_endpoint: "http://as.example/authorize", // http!
        token_endpoint: "https://as.example/token",
      });
    }
    return undefined;
  });
  try {
    await assert.rejects(() => discover(MCP), /no valid OAuth authorization server metadata/);
  } finally {
    restoreFetch();
  }
});

test("canonicalResource strips fragments and requires https", () => {
  assert.equal(canonicalResource("https://a.example/mcp#frag"), "https://a.example/mcp");
  assert.throws(() => canonicalResource("http://a.example/mcp"));
});

test("a wrong MASTER_KEY produces an explicit mismatch error, not corrupt-looking data", async () => {
  const kv = new Map<string, string>();
  const baseEnv = {
    OAUTH_KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) },
  } as unknown as Env;
  const sealed = await sealSecret(baseEnv, "b|x", "secret-value"); // creates KV key + fingerprint
  assert.equal(await openSecret(baseEnv, "b|x", sealed.ciphertext, sealed.iv), "secret-value");
  const wrongKey = Buffer.alloc(32, 7).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const wrongEnv = { ...(baseEnv as object), MASTER_KEY: wrongKey } as unknown as Env;
  await assert.rejects(() => openSecret(wrongEnv, "b|x", sealed.ciphertext, sealed.iv), /vault master key mismatch/);
});

test("legacy origin-bound rows open once and reseal under the complete binding", async () => {
  const server = "https://host.example/legacy/mcp";
  const row: ConnRow = {
    name: "legacy",
    server_url: server,
    origin: "https://host.example",
    token_endpoint: "https://as.example/token",
    client_id: "c9",
    scopes: null,
    ciphertext: "",
    iv: "",
    created_at: Date.now(),
    token_version: 0,
    refresh_lease_until: null,
    binding_version: 1,
  };
  const env = fakeEnv(row);
  const sealed = await sealSecret(env, "mindash-conn|legacy|https://host.example", JSON.stringify({ access_token: "old-style" }));
  row.ciphertext = sealed.ciphertext;
  row.iv = sealed.iv;
  const h = await connectionHeader(env, "legacy", server);
  assert.equal(h.authorization, "Bearer old-style");
  assert.equal(row.token_version, 1, "reseal bumped the version");
  assert.equal(row.binding_version, 2, "reseal advanced the binding version");
  const again = await connectionHeader(env, "legacy", server);
  assert.equal(again.authorization, "Bearer old-style");
  row.token_endpoint = "https://evil.example/token";
  await assert.rejects(() => connectionHeader(env, "legacy", server), /failed to decrypt/);
});

test("resource and issuer identity is exact - trailing slashes differ", async () => {
  withFetch((url) => {
    if (url === MCP) return initChallenge();
    if (url.includes("oauth-protected-resource")) {
      return json({ resource: MCP + "/", authorization_servers: ["https://as.example"] });
    }
    return undefined;
  });
  try {
    await assert.rejects(() => discover(MCP), /no valid OAuth authorization server metadata/);
  } finally {
    restoreFetch();
  }
  withFetch((url) => {
    if (url === MCP) return initChallenge();
    if (url.includes("oauth-protected-resource")) {
      return json({ resource: MCP, authorization_servers: ["https://as.example/tenant"] });
    }
    if (url.startsWith("https://as.example/")) {
      return json({
        issuer: "https://as.example/tenant/",
        authorization_endpoint: "https://as.example/tenant/authorize",
        token_endpoint: "https://as.example/tenant/token",
      });
    }
    return undefined;
  });
  try {
    await assert.rejects(() => discover(MCP), /no valid OAuth authorization server metadata/);
  } finally {
    restoreFetch();
  }
});

test("a v2 row NEVER falls back to the legacy binding", async () => {
  // attacker scenario: row content satisfies the legacy AAD (name|origin)
  // but the trusted column says the row has migrated — decryption must
  // fail, not fall back (a tampered token_endpoint would satisfy legacy).
  const server = "https://host.example/v2/mcp";
  const row: ConnRow = {
    name: "v2conn",
    server_url: server,
    origin: "https://host.example",
    token_endpoint: "https://evil.example/token",
    client_id: "c1",
    scopes: null,
    ciphertext: "",
    iv: "",
    created_at: Date.now(),
    token_version: 0,
    refresh_lease_until: null,
    binding_version: 2,
  };
  const env = fakeEnv(row);
  const sealed = await sealSecret(env, "mindash-conn|v2conn|https://host.example", JSON.stringify({ access_token: "t" }));
  row.ciphertext = sealed.ciphertext;
  row.iv = sealed.iv;
  await assert.rejects(() => connectionHeader(env, "v2conn", server), /failed to decrypt/);
});

test("refresh publication that loses to a reconnect re-validates the resource", async () => {
  const server = "https://host.example/old/mcp";
  const row: ConnRow = {
    name: "flip",
    server_url: server,
    origin: "https://host.example",
    token_endpoint: "https://as.example/token",
    client_id: "c1",
    scopes: null,
    ciphertext: "",
    iv: "",
    created_at: Date.now(),
    token_version: 0,
    refresh_lease_until: null,
    binding_version: 2,
  };
  const env = fakeEnv(row);
  const sealed = await sealSecret(
    env,
    `mindash-conn2|flip|${server}|https://as.example/token|c1`,
    JSON.stringify({ access_token: "old", refresh_token: "rt-1", expires_at: Date.now() + 1000 }),
  );
  row.ciphertext = sealed.ciphertext;
  row.iv = sealed.iv;
  withFetch((url) => {
    if (url === "https://as.example/token") {
      // mid-exchange, the owner reconnects the NAME to a different resource
      row.server_url = "https://host.example/new/mcp";
      row.token_version += 1;
      return json({ access_token: "won't matter", expires_in: 3600 });
    }
    return undefined;
  });
  try {
    await assert.rejects(() => connectionHeader(env, "flip", server), /bound to https:\/\/host\.example\/new\/mcp/);
  } finally {
    restoreFetch();
  }
});

test("refresh waiters outlast a slow (>5s) winning exchange", { timeout: 20000 }, async () => {
  const server = "https://host.example/slow/mcp";
  const row: ConnRow = {
    name: "slow",
    server_url: server,
    origin: "https://host.example",
    token_endpoint: "https://as.example/token",
    client_id: "c1",
    scopes: null,
    ciphertext: "",
    iv: "",
    created_at: Date.now(),
    token_version: 0,
    refresh_lease_until: null,
    binding_version: 2,
  };
  const env = fakeEnv(row);
  const sealed = await sealSecret(
    env,
    `mindash-conn2|slow|${server}|https://as.example/token|c1`,
    JSON.stringify({ access_token: "old", refresh_token: "rt-1", expires_at: Date.now() + 1000 }),
  );
  row.ciphertext = sealed.ciphertext;
  row.iv = sealed.iv;
  let exchanges = 0;
  withFetch((url) => {
    if (url === "https://as.example/token") {
      exchanges++;
      return undefined as never; // replaced below by a delayed responder
    }
    return undefined;
  });
  // delayed responder: the winner's exchange takes 5.5s
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://as.example/token") {
      exchanges++;
      await new Promise((r) => setTimeout(r, 5500));
      return json({ access_token: "slow-tok", refresh_token: "rt-2", expires_in: 3600 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const [h1, h2] = await Promise.all([
      connectionHeader(env, "slow", server),
      connectionHeader(env, "slow", server),
    ]);
    assert.equal(exchanges, 1, "single exchange despite the slow winner");
    assert.equal(h1.authorization, "Bearer slow-tok");
    assert.equal(h2.authorization, "Bearer slow-tok");
  } finally {
    restoreFetch();
  }
});
