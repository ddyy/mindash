import type { FieldSpec, WidgetCommon, WidgetDef } from "./def";
import { credentialHeader } from "../vault";
import { connectionHeader } from "../mcpclient";
import { html, safeUrl, type SafeHtml } from "../html";
import { renderMarkdown } from "./markdown";
import { safeFetchRaw, type RawFetchResult } from "../safefetch";
import { resolvePath } from "./json-api";
import { parseListSpec, extractList, renderList, LIST_FIELDS, type ListSpec, type ListRow } from "./listmap";

export interface McpWidget extends WidgetCommon {
  type: "mcp";
  url: string; // Streamable-HTTP MCP endpoint
  tool: string;
  args?: Record<string, unknown>;
  fields: FieldSpec[]; // optional mapping into structuredContent / JSON text
  list?: ListSpec; // declarative list mapping (wins over fields/heuristics)
  answerPath?: string; // dot-path to a single prose answer in the response
  markdown: boolean; // render text blocks through the safe markdown subset
  authSecret?: string; // vault credential NAME (never a value)
  connection?: string; // OAuth MCP connection NAME (Settings - MCP connections)
}

// MCP-backed widget: call one tool on a Streamable-HTTP MCP server each
// refresh and render the result. Three auth modes: unauthenticated,
// vault credential (static bearer), or an OAuth connection established in
// Settings (src/mcpclient.ts handles the flow + refresh). All requests
// ride the outbound-fetch safety contract: https-only (POSTs count as
// credentialed), no redirects, bounded bodies and deadlines. Results are
// plain data - field values and text blocks are escaped at render like
// every other widget.

export interface McpData {
  values: { label: string; value: string }[];
  links: { title: string; url: string }[];
  blocks: string[];
  rows?: ListRow[]; // explicit list mapping output
  answer?: string; // explicit answer mapping output
}

interface RpcMessage {
  result?: {
    isError?: boolean;
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
  };
  error?: { code?: number; message?: string };
  id?: unknown;
}

// Streamable HTTP allows JSON or SSE responses; for SSE take the message
// carrying our request id (or the last data event as a fallback).
function parseRpc(res: RawFetchResult): RpcMessage {
  if (res.contentType.startsWith("text/event-stream")) {
    let last: RpcMessage | undefined;
    for (const line of res.text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim()) as RpcMessage;
        if (msg.result !== undefined || msg.error !== undefined) last = msg;
      } catch {
        // ignore non-JSON keepalive events
      }
    }
    if (!last) throw new Error("no JSON-RPC message in event stream");
    return last;
  }
  return JSON.parse(res.text) as RpcMessage;
}

async function rpc(
  url: string,
  auth: Record<string, string>,
  payload: unknown,
  sessionId?: string,
  protocolVersion?: string,
): Promise<RawFetchResult> {
  return safeFetchRaw(url, {
    method: "POST",
    body: JSON.stringify(payload),
    timeoutMs: 15_000,
    headers: {
      ...auth,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
  });
}

const CALL_ID = 1;

function callPayload(cfg: McpWidget): unknown {
  return {
    jsonrpc: "2.0",
    id: CALL_ID,
    method: "tools/call",
    params: { name: cfg.tool, arguments: cfg.args ?? {} },
  };
}

// The raw object that fieldmap paths resolve against - used by the
// editor's field picker. Same fetch path and contract as fetchData.
export async function fetchSampleRoot(cfg: McpWidget, env: Env): Promise<unknown> {
  const data = await fetchDataWithRoot(cfg, env);
  return data.root ?? (data.blocks.length ? { text: data.blocks } : undefined);
}

async function authFor(url: string, cfg: { authSecret?: string; connection?: string }, env: Env): Promise<Record<string, string>> {
  // Vault/connection binding (type + origin) re-checked at fetch time,
  // same as json-api - save-time validation is not the enforcement point.
  if (cfg.connection) return connectionHeader(env, cfg.connection, url);
  if (cfg.authSecret) return credentialHeader(env, cfg.authSecret, "mcp", url);
  return {};
}

// Conforming lifecycle on every operation: initialize (validating the
// negotiated version and tools capability) -> notifications/initialized ->
// the request (with session id + negotiated MCP-Protocol-Version headers)
// -> best-effort session close. No pre-initialization requests.
async function rpcResult(url: string, auth: Record<string, string>, method: string, params: unknown): Promise<unknown> {
  const init = await rpc(url, auth, {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mindash", version: "1.0" },
    },
  });
  if (!init.ok) throw new Error(`MCP initialize failed (${init.status})`);
  const initMsg = parseRpc(init);
  if (initMsg.error) throw new Error(`MCP initialize: ${initMsg.error.message ?? "error"}`);
  const negotiated = initMsg.result as
    | { protocolVersion?: unknown; capabilities?: { tools?: unknown } }
    | undefined;
  if (typeof negotiated?.protocolVersion !== "string") {
    throw new Error("MCP initialize: server returned no protocol version");
  }
  // Only versions whose Streamable-HTTP transport + lifecycle this client
  // actually implements; anything else means disconnect, per the spec.
  const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26"];
  if (!SUPPORTED_PROTOCOLS.includes(negotiated.protocolVersion)) {
    throw new Error(`MCP server negotiated unsupported protocol version "${negotiated.protocolVersion}"`);
  }
  if (negotiated.capabilities?.tools === undefined) {
    throw new Error("MCP server does not advertise the tools capability");
  }
  const proto = negotiated.protocolVersion;
  const sessionId = init.headers.get("mcp-session-id") ?? undefined;
  try {
    await rpc(url, auth, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId, proto);
    const res = await rpc(url, auth, { jsonrpc: "2.0", id: CALL_ID, method, params }, sessionId, proto);
    if (!res.ok) throw new Error(`upstream ${res.status} from MCP server`);
    const msg = parseRpc(res);
    if (msg.error) throw new Error(`MCP error: ${msg.error.message ?? `code ${msg.error.code}`}`);
    if (!msg.result) throw new Error("MCP response had no result");
    return msg.result;
  } finally {
    if (sessionId) {
      // established sessions are closed when finished (best effort)
      await safeFetchRaw(url, {
        method: "DELETE",
        timeoutMs: 5_000,
        headers: { ...auth, "mcp-session-id": sessionId, "mcp-protocol-version": proto },
      }).catch(() => undefined);
    }
  }
}

// Tool discovery for the editor's tool picker.
export async function listTools(
  url: string,
  auths: { authSecret?: string; connection?: string },
  env: Env,
): Promise<{ name: string; description: string }[]> {
  const auth = await authFor(url, auths, env);
  const result = (await rpcResult(url, auth, "tools/list", {})) as { tools?: { name?: string; description?: string }[] };
  return (result.tools ?? [])
    .filter((t) => typeof t.name === "string")
    .slice(0, 100)
    .map((t) => ({
      name: t.name as string,
      description: (t.description ?? "").slice(0, 160),
    }));
}

function parseAnswerPath(w: Record<string, unknown>, where: string, h: { str: (v: unknown, w: string) => string }): string | undefined {
  if (w.answer_path === undefined || w.answer_path === "") return undefined;
  const p = h.str(w.answer_path, `${where}.answer_path`);
  if (p !== "." && !/^[A-Za-z0-9_.-]+$/.test(p)) throw new Error(`${where}.answer_path: bad path`);
  return p;
}

export async function fetchData(cfg: McpWidget, env: Env): Promise<McpData> {
  const { values, links, blocks, rows, answer } = await fetchDataWithRoot(cfg, env);
  return { values, links, blocks, rows, answer }; // root stays out of the persisted payload
}

async function fetchDataWithRoot(cfg: McpWidget, env: Env): Promise<McpData & { root?: unknown }> {
  const auth = await authFor(cfg.url, cfg, env);
  const result = (await rpcResult(cfg.url, auth, "tools/call", {
    name: cfg.tool,
    arguments: cfg.args ?? {},
  })) as NonNullable<RpcMessage["result"]>;
  const rawBlocks = (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .slice(0, 8);
  // Search-shaped results (<result><url>..<title>.. pairs, as the
  // Cloudflare docs server emits) render as a link list, not raw markup.
  const links: McpData["links"] = [];
  for (const b of rawBlocks) {
    for (const m of b.matchAll(/<url>\s*([^<]+?)\s*<\/url>\s*<title>\s*([^<]+?)\s*<\/title>/g)) {
      if (links.length >= 10) break;
      links.push({ url: (m[1] ?? "").trim(), title: (m[2] ?? "").trim() });
    }
  }
  // Some servers emit markdown link digests instead ("* [Title](url)");
  // harvest those too, but only when the block reads as a link LIST -
  // two or more - so a prose paragraph with one inline link stays prose.
  if (links.length === 0) {
    for (const b of rawBlocks) {
      for (const m of b.matchAll(/\[([^\]]{1,140})\]\((https?:\/\/[^)\s]+)\)/g)) {
        if (links.length >= 10) break;
        links.push({ title: (m[1] ?? "").trim(), url: (m[2] ?? "").trim() });
      }
    }
    if (links.length < 2) links.length = 0;
  }
  const cap = cfg.markdown ? 4000 : 600;
  const blocks = rawBlocks.map((b) => (b.length > cap ? `${b.slice(0, cap)}\u2026` : b));
  if (result.isError) throw new Error(blocks.join(" ").slice(0, 200) || "tool returned an error");

  // Field mapping resolves against structuredContent, or the first text
  // block if it parses as JSON (many servers stringify their payload).
  let values: McpData["values"] = [];
  let root: unknown = result.structuredContent;
  if (root === undefined && rawBlocks[0]) {
    try {
      root = JSON.parse(rawBlocks[0]);
    } catch {
      root = undefined;
    }
  }
  let rows: ListRow[] | undefined;
  if (cfg.list && root !== undefined) {
    rows = extractList(root, cfg.list);
  }
  let answer: string | undefined;
  if (cfg.answerPath) {
    // "." = the whole text response (Q&A tools that answer in prose);
    // otherwise a path into the structured response
    if (cfg.answerPath === ".") {
      answer = rawBlocks.join("\n\n").slice(0, cfg.markdown ? 4000 : 1200);
    } else if (root !== undefined) {
      const v = resolvePath(root, cfg.answerPath);
      if (typeof v === "string") answer = v.slice(0, cfg.markdown ? 4000 : 1200);
      else if (v !== undefined && v !== null) answer = JSON.stringify(v).slice(0, 400);
    }
  }
  if (cfg.fields.length > 0) {
    const strCap = cfg.markdown ? 4000 : 140;
    values = cfg.fields.map((f) => {
      const v = resolvePath(root, f.path);
      let out: string;
      if (v === undefined) out = "-";
      else if (typeof v === "string") out = v.length > strCap ? `${v.slice(0, strCap)}…` : v;
      else if (typeof v === "number" && Math.abs(v) >= 10000) out = v.toLocaleString("en-US");
      else out = typeof v === "object" ? JSON.stringify(v).slice(0, 140) : String(v);
      return { label: f.label, value: out };
    });
  } else if (root !== null && typeof root === "object" && links.length === 0) {
    // No mapping configured: auto-extract the useful part instead of
    // dumping raw JSON. Arrays of objects render as a titled list; plain
    // objects render their scalar entries as kv rows.
    const scalar = (v: unknown): string | null => {
      if (typeof v === "string") return v.length > 140 ? `${v.slice(0, 140)}…` : v;
      if (typeof v === "number") return Math.abs(v) >= 10000 ? v.toLocaleString("en-US") : String(v);
      if (typeof v === "boolean") return String(v);
      return null;
    };
    const TITLE_KEYS = ["title", "name", "summary", "label", "headline", "subject"];
    const URL_KEYS = ["url", "link", "href", "html_url"];
    // an object wrapping exactly one array of objects IS that list
    // ({products: [...]}, {items: [...]}) - descend into it
    let listRoot: unknown = root;
    if (!Array.isArray(listRoot)) {
      const arrays = Object.values(root as Record<string, unknown>).filter(
        (v) => Array.isArray(v) && v.length > 0 && typeof v[0] === "object",
      );
      if (arrays.length === 1) listRoot = arrays[0];
    }
    if (Array.isArray(listRoot)) {
      for (const item of listRoot.slice(0, 8)) {
        if (item === null || typeof item !== "object") continue;
        const o = item as Record<string, unknown>;
        const tKey = TITLE_KEYS.find((k) => typeof o[k] === "string");
        const uKey = URL_KEYS.find((k) => typeof o[k] === "string");
        if (tKey && uKey) links.push({ title: String(o[tKey]).slice(0, 120), url: String(o[uKey]) });
        else if (tKey) values.push({ label: "", value: String(o[tKey]).slice(0, 140) });
      }
    } else {
      for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
        if (values.length >= 8) break;
        const sv = scalar(v);
        if (sv === null) continue;
        const label = k.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
        values.push({ label, value: sv });
      }
    }
  }
  return { values, links, blocks, rows, answer, root };
}

export function render(data: McpData, cfg: McpWidget): SafeHtml {
  return renderBody(data, cfg);
}

function renderBody(data: McpData, cfg: McpWidget): SafeHtml {
  if (cfg.list) return renderList(data.rows ?? []);
  if (cfg.answerPath) {
    if (!data.answer) return html`<p class="empty">No answer at the mapped path.</p>`;
    return cfg.markdown ? renderMarkdown(data.answer) : html`<p class="mcp-text">${data.answer}</p>`;
  }
  if (data.values.length > 0) {
    if (cfg.markdown) {
      // field values as markdown sections, label (when present) as heading
      return html`${data.values.map(
        (v) => html`${v.label ? html`<p class="mcp-h">${v.label}</p>` : null}${renderMarkdown(v.value)}`,
      )}`;
    }
    return html`<ul class="kv">
      ${data.values.map(
        (v) =>
          html`<li>${v.label ? html`<span class="k">${v.label}</span>` : null}<span class="v">${v.value}</span></li>`,
      )}
    </ul>`;
  }
  if (data.blocks.length === 0 && data.links.length === 0) {
    return html`<p class="empty">Tool returned no content.</p>`;
  }
  // Explicit markdown mode wins over the link-list heuristic.
  if (cfg.markdown && data.blocks.length > 0) return html`${data.blocks.map(renderMarkdown)}`;
  if (data.links.length > 0) {
    return html`<ul class="feed">
      ${data.links.map(
        (l) => html`<li><a href="${safeUrl(l.url)}" rel="noreferrer">${l.title}</a></li>`,
      )}
    </ul>`;
  }
  return html`${data.blocks.map((b) => html`<p class="mcp-text">${b}</p>`)}`;
}

export const def: WidgetDef<McpWidget, McpData> = {
  meta: {
    title: "MCP tool",
    icon: "🔌",
    defaultTitle: "MCP",
    category: "Display",
    description: "Call a tool on any MCP server and display the result.",
    requirements: "Any Streamable-HTTP server (https): unauthenticated, a Settings credential (static bearer), or a Settings MCP connection (OAuth).",
  },
  sourceFields: ["url", "tool", "args", "auth_secret", "connection"],
  form: [
    { key: "url", label: "Server URL", kind: "url", required: true, placeholder: "https://docs.mcp.cloudflare.com/mcp", prefill: "https://docs.mcp.cloudflare.com/mcp" },
    { key: "tool", label: "Tool name", kind: "text", required: true, placeholder: "migrate_pages_to_workers_guide", prefill: "migrate_pages_to_workers_guide" },
    { key: "args", label: "Arguments (JSON object)", kind: "json", placeholder: '{"query": "workers limits"}' },
    {
      key: "fields",
      label: "Fields",
      kind: "fieldmap",
      help: "Optional - maps into the tool's structured result. Leave empty to show its text output.",
    },
    {
      key: "render",
      label: "Text rendering",
      kind: "select",
      options: ["plain", "markdown"],
      prefill: "markdown",
      help: "Markdown renders headings, bold, lists, code, and links (safe subset).",
    },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, placeholder: "1h", prefill: "1h" },
    ...LIST_FIELDS,
    {
      key: "answer_path",
      label: "Answer path",
      kind: "text",
      advanced: true,
      placeholder: "answer",
      help: 'For question-answering tools: show one prose value. "." = the whole text response. Pairs well with markdown rendering.',
    },
    {
      key: "auth_secret",
      label: "Credential (optional)",
      kind: "secret",
      advanced: true,
      help: "Names only - the value stays encrypted in the vault, never in config.",
    },
    {
      key: "connection",
      label: "OAuth connection (optional)",
      kind: "connection",
      advanced: true,
      help: "For OAuth-protected servers: connect once under Settings - MCP connections, then pick it here.",
    },
  ],
  parse(w, where, common, h) {
    const refreshSeconds = h.parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    const url = h.str(w.url, `${where}.url`);
    const tool = h.str(w.tool, `${where}.tool`);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(tool)) throw new Error(`${where}: bad tool name`);
    if (w.args !== undefined && (typeof w.args !== "object" || w.args === null || Array.isArray(w.args))) {
      throw new Error(`${where}: args must be a JSON object`);
    }
    const authSecret =
      w.auth_secret === undefined || w.auth_secret === "" ? undefined : h.credentialName(w.auth_secret, `${where}.auth_secret`);
    const connection =
      w.connection === undefined || w.connection === "" ? undefined : h.credentialName(w.connection, `${where}.connection`);
    if (authSecret && connection) throw new Error(`${where}: use a credential or a connection, not both`);
    return {
      ...common,
      refreshSeconds,
      type: "mcp",
      url,
      tool,
      args: w.args as Record<string, unknown> | undefined,
      fields: h.parseFields(w.fields, where),
      list: parseListSpec(w, where, h),
      answerPath: parseAnswerPath(w, where, h),
      markdown: w.render === "markdown",
      authSecret,
      connection,
    };
  },
  fetchData,
  render,
};
