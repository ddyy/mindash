import type { FieldSpec, WidgetCommon, WidgetDef } from "./def";
import { credentialHeader } from "../vault";
import { html, type SafeHtml } from "../html";
import { safeFetchText } from "../safefetch";
import { parseListSpec, extractList, renderList, LIST_FIELDS, type ListSpec, type ListRow } from "./listmap";

// Generic JSON-API widget (Glance's custom-api equivalent): URL + dot-path
// field mapping, all in config - a new source is a config mutation, no
// deploy. Values are plain data rendered through the escaping template;
// there is no template language and no raw HTML.

export interface JsonApiData {
  values: { label: string; value: string }[];
  rows?: ListRow[];
}


// Canonical home is listmap (leaf module); re-exported for existing importers.
import { resolvePath } from "./listmap";
export { resolvePath };

function formatValue(v: unknown): string {
  if (v === undefined) return "-";
  if (typeof v === "number") {
    return Math.abs(v) >= 10000 ? v.toLocaleString("en-US") : String(v);
  }
  if (typeof v === "string") return v.length > 140 ? `${v.slice(0, 140)}…` : v;
  if (typeof v === "boolean" || v === null) return String(v);
  return JSON.stringify(v).slice(0, 140);
}

// Raw response body for the editor's field picker.
export async function fetchSampleRoot(cfg: JsonApiWidget, env: Env): Promise<unknown> {
  return fetchBody(cfg, env);
}

async function fetchBody(cfg: JsonApiWidget, env: Env): Promise<unknown> {
  // The vault is the enforcement point: type + destination origin are
  // checked (and AEAD-bound) immediately before the fetch, not at save.
  const headers: Record<string, string> = cfg.authSecret
    ? await credentialHeader(env, cfg.authSecret, "json-api", cfg.url)
    : {};
  const text = await safeFetchText(cfg.url, {
    accept: ["application/json"],
    headers,
  });
  return JSON.parse(text) as unknown;
}

export async function fetchData(cfg: JsonApiWidget, env: Env): Promise<JsonApiData> {
  const body = await fetchBody(cfg, env);
  return {
    values: cfg.fields.map((f: FieldSpec) => ({
      label: f.label,
      value: formatValue(resolvePath(body, f.path)),
    })),
    rows: cfg.list ? extractList(body, cfg.list) : undefined,
  };
}

export function render(data: JsonApiData, cfg: JsonApiWidget): SafeHtml {
  if (cfg.list) return renderList(data.rows ?? []);
  return html`<ul class="kv">
    ${data.values.map(
      (v) =>
        html`<li>${v.label ? html`<span class="k">${v.label}</span>` : null}<span class="v">${v.value}</span></li>`,
    )}
  </ul>`;
}

export interface JsonApiWidget extends WidgetCommon {
  type: "json-api";
  url: string;
  fields: FieldSpec[];
  authSecret?: string; // vault credential NAME (never a value)
  list?: ListSpec;
}

export const def: WidgetDef<JsonApiWidget, JsonApiData> = {
  meta: {
    title: "JSON API",
    icon: "📊",
    category: "Display",
    description: "Fetch any JSON endpoint and display chosen fields.",
    requirements: "Authenticated sources use a credential saved under Settings - API credentials.",
  },
  sourceFields: ["url", "auth_secret"],
  form: [
    {
      key: "url",
      label: "Endpoint URL",
      kind: "url",
      required: true,
      placeholder: "https://api.github.com/repos/cloudflare/workers-sdk",
      prefill: "https://api.github.com/repos/cloudflare/workers-sdk",
    },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, placeholder: "1h", prefill: "1h" },
    {
      key: "fields",
      label: "Fields",
      kind: "fieldmap",
      placeholder: "Stars: stargazers_count",
      prefill: "Stars: stargazers_count\nOpen issues: open_issues_count\nForks: forks_count",
    },
    ...LIST_FIELDS,
    {
      key: "auth_secret",
      label: "Credential (optional)",
      kind: "secret",
      advanced: true,
      help: "Names only - the value stays encrypted in the vault, never in config.",
    },
  ],
  parse(w, where, common, h) {
    const refreshSeconds = h.parseInterval(w.refresh_interval, `${where}.refresh_interval`);
    const authSecret =
      w.auth_secret === undefined || w.auth_secret === "" ? undefined : h.credentialName(w.auth_secret, `${where}.auth_secret`);
    const url = h.str(w.url, `${where}.url`);
    const list = parseListSpec(w, where, h);
    const fields = h.parseFields(w.fields, where);
    if (fields.length === 0 && !list) {
      throw new Error(`${where}: json-api requires fields or a list mapping`);
    }
    return { ...common, refreshSeconds, type: "json-api", url, fields, authSecret, list };
  },
  fetchData,
  render,
};
