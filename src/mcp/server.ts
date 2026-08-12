import {
  docToYaml,
  docWidgets,
  getCurrentConfig,
  redactDoc,
  yamlToRaw,
  type RawDoc,
  type RawWidget,
} from "../config";
import { publishConfig, rollbackConfig, type PublishResult } from "../configstore";
import { forceRefresh } from "../refresh";
import { sha256Hex } from "../auth/util";

// Stateless MCP endpoint (Streamable HTTP, JSON responses). These tools are
// plain operations over D1 - no session state, no server push - so a
// hand-rolled JSON-RPC dispatcher is all that's needed (plan: no McpAgent).
// Auth (this lane): scoped static bearer tokens, hashed + epoch-stamped in
// D1 - the plan's secondary lane for header-capable clients; OAuth 2.1 is
// the primary connector flow and lands separately.

const PROTOCOL_VERSION = "2025-06-18";

export interface TokenInfo {
  scopes: Set<string>;
  epoch: number;
  label: string;
}

// Static-bearer lane (plan: secondary lane for header-capable clients).
// Plugged into workers-oauth-provider as resolveExternalToken, so both
// lanes share the /mcp route.
export async function resolveStaticToken(token: string, env: Env): Promise<TokenInfo | null> {
  const hash = await sha256Hex(token);
  const row = await env.DB
    .prepare(
      `SELECT scopes, epoch, label FROM mcp_tokens
       WHERE token_hash = ?1 AND revoked_at IS NULL
         AND epoch = (SELECT epoch FROM owner_state WHERE id = 1)`,
    )
    .bind(hash)
    .first<{ scopes: string; epoch: number; label: string | null }>();
  if (!row) return null;
  // Normalize short-form scopes ("layout") to the canonical OAuth form.
  const scopes = new Set(row.scopes.split(",").map((s) => (s.startsWith("config:") ? s : `config:${s}`)));
  return { scopes, epoch: row.epoch, label: row.label ?? "mcp" };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}
function errText(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

function publishOutcome(res: PublishResult): ToolResult {
  if (res.ok) return text(JSON.stringify({ ok: true, version: res.version }));
  if ("conflict" in res && res.conflict) {
    return errText(
      JSON.stringify({
        error: "version conflict - re-read config and reapply your change",
        currentVersion: res.currentVersion,
      }),
    );
  }
  return errText(JSON.stringify({ error: "error" in res ? res.error : "unknown error" }));
}

const TOOLS = [
  {
    name: "list_config",
    description:
      "Read the current dashboard config as YAML plus its version number. Pass the version as base_version to mutation tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_widget",
    description:
      "Add a widget to a page/column. Widget object uses config YAML fields (type, title, refresh_interval, url, ...) WITHOUT an id or name - both are server-assigned. Requires config:sources. Call refresh_widget with the new id afterwards to fetch its data immediately.",
    inputSchema: {
      type: "object",
      properties: {
        base_version: { type: "integer" },
        page: { type: "string", description: "page name" },
        row: { type: "integer", description: "0-based row index (default 0)" },
        column: { type: "integer", description: "0-based column index within the row" },
        widget: { type: "object" },
      },
      required: ["base_version", "page", "column", "widget"],
      additionalProperties: false,
    },
  },
  {
    name: "update_widget",
    description:
      "Patch fields on an existing widget by id. Layout fields need config:layout; source/schedule fields need config:sources.",
    inputSchema: {
      type: "object",
      properties: {
        base_version: { type: "integer" },
        id: { type: "string" },
        patch: { type: "object", description: "fields to set; null removes a field" },
      },
      required: ["base_version", "id", "patch"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_widget",
    description: "Remove a widget by id (its history is preserved, the instance is tombstoned). Requires config:sources.",
    inputSchema: {
      type: "object",
      properties: { base_version: { type: "integer" }, id: { type: "string" } },
      required: ["base_version", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "rollback_config",
    description:
      "Copy a historical config version forward as a new version (rollback). Requires config:sources.",
    inputSchema: {
      type: "object",
      properties: { base_version: { type: "integer" }, to_version: { type: "integer" } },
      required: ["base_version", "to_version"],
      additionalProperties: false,
    },
  },
  {
    name: "refresh_widget",
    description: "Force a pull widget to refetch its source right now (by widget id). Any scope.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_config",
    description:
      "Replace the whole config document (pages, rows, columns, widgets, theme, themes presets). YAML string or JSON object. Existing widgets keep their server-assigned ids; new widgets omit id/name. Scope rules match the diff (layout-only changes need config:layout; sources/pages-public/theme-image changes need config:sources).",
    inputSchema: {
      type: "object",
      properties: {
        base_version: { type: "integer" },
        doc: { description: "full config document: JSON object, or YAML as a string" },
      },
      required: ["base_version", "doc"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot_config",
    description: "Export the current config as YAML (for saving to the repo) with its version.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function callTool(env: Env, token: TokenInfo, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const hasSources = token.scopes.has("config:sources");
  const actor = `mcp:${token.label}`;

  if (name === "list_config" || name === "snapshot_config") {
    const { version, doc } = await getCurrentConfig(env);
    const visible = hasSources ? doc : redactDoc(doc);
    return text(JSON.stringify({ version, yaml: docToYaml(visible), redacted: !hasSources }));
  }

  if (name === "refresh_widget") {
    const res = await forceRefresh(env, String(args.id ?? ""));
    return res.ok ? text(JSON.stringify(res)) : errText(JSON.stringify(res));
  }

  const base = typeof args.base_version === "number" ? args.base_version : NaN;
  if (!Number.isInteger(base)) return errText("base_version (integer) is required");
  const { doc } = await getCurrentConfig(env);
  const working = JSON.parse(JSON.stringify(doc)) as RawDoc;

  if (name === "update_config") {
    const base = Number(args.base_version);
    if (!Number.isInteger(base)) return errText("base_version required");
    let candidate: unknown = args.doc;
    if (typeof candidate === "string") {
      try {
        candidate = yamlToRaw(candidate);
      } catch (e) {
        return errText(`YAML parse error: ${String(e instanceof Error ? e.message : e)}`);
      }
    }
    if (typeof candidate !== "object" || candidate === null) return errText("doc must be a mapping");
    if (!hasSources) {
      // Layout tokens read redacted documents; restore "[redacted]"
      // sentinels from the base version so read-modify-write round-trips.
      const baseRow = await env.DB
        .prepare("SELECT doc FROM config_versions WHERE version = ?1")
        .bind(base)
        .first<{ doc: string }>();
      if (!baseRow) return errText(`base_version ${base} not found`);
      const { validateDoc: vd, unredactDoc } = await import("../config");
      const restored = unredactDoc(candidate, vd(JSON.parse(baseRow.doc)).doc);
      if (!restored.ok) return errText(restored.error);
      candidate = restored.doc;
    }
    return publishOutcome(
      await publishConfig(env, { baseVersion: base, candidate, actor, hasSources, epoch: token.epoch }),
    );
  }
  if (name === "add_widget") {
    const page = working.pages.find((p) => p.name === args.page);
    if (!page) return errText(`unknown page "${String(args.page)}"`);
    const row = page.rows[Number(args.row ?? 0)];
    if (!row) return errText(`page has no row ${String(args.row ?? 0)}`);
    const col = row.columns[Number(args.column)];
    if (!col) return errText(`row has no column ${String(args.column)}`);
    const widget = args.widget as RawWidget;
    if (widget && widget.id !== undefined) return errText("ids are server-assigned - omit id");
    col.widgets.push(widget);
    return publishOutcome(
      await publishConfig(env, { baseVersion: base, candidate: working, actor, hasSources, epoch: token.epoch }),
    );
  }

  if (name === "update_widget" || name === "remove_widget") {
    const id = String(args.id ?? "");
    let found = false;
    for (const p of working.pages) {
      for (const c of p.rows.flatMap((r) => r.columns)) {
        const idx = c.widgets.findIndex((w) => String(w.id) === id);
        if (idx === -1) continue;
        found = true;
        if (name === "remove_widget") {
          c.widgets.splice(idx, 1);
        } else {
          const patch = (args.patch ?? {}) as Record<string, unknown>;
          if (patch.id !== undefined) return errText("id is immutable");
          const target = c.widgets[idx] as RawWidget;
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete target[k];
            else target[k] = v;
          }
        }
      }
    }
    if (!found) return errText(`no widget with id "${id}"`);
    return publishOutcome(
      await publishConfig(env, { baseVersion: base, candidate: working, actor, hasSources, epoch: token.epoch }),
    );
  }

  if (name === "rollback_config") {
    const to = Number(args.to_version);
    if (!Number.isInteger(to)) return errText("to_version (integer) is required");
    return publishOutcome(await rollbackConfig(env, base, to, actor, hasSources, token.epoch));
  }

  return errText(`unknown tool "${name}"`);
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

// Dispatch a single JSON-RPC message for an already-authenticated caller
// (either lane - OAuth grant props or static token).
export async function dispatchMcp(req: Request, env: Env, token: TokenInfo): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only (stateless MCP endpoint)" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST" },
    });
  }
  let msg: JsonRpcRequest;
  try {
    msg = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "batch requests not supported");
  if (msg.method?.startsWith("notifications/")) return new Response(null, { status: 202 });

  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id ?? null, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "mindash", version: "0.1.0" },
      });
    case "ping":
      return rpcResult(msg.id ?? null, {});
    case "tools/list":
      return rpcResult(msg.id ?? null, { tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(msg.id ?? null, await callTool(env, token, name, args));
      } catch (e) {
        return rpcResult(msg.id ?? null, errText(String(e instanceof Error ? e.message : e)));
      }
    }
    default:
      return rpcError(msg.id ?? null, -32601, `method not found: ${msg.method}`);
  }
}

function rpcResult(id: number | string | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });
}

function rpcError(id: number | string | null, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
