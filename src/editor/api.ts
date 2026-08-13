import {
  DEFAULT_TITLES,
  classifyDiff,
  parseProbeWidget,
  docToYaml,
  docWidgets,
  getCurrentConfig,
  validateDoc,
  yamlToRaw,
  type RawDoc,
  type RawWidget,
} from "../config";
import { publishConfig } from "../configstore";
import { renderMain, frameSrcFor } from "../render";
import { forceRefresh } from "../refresh";
import { json } from "../auth/util";
import { csrfToken } from "../settings";
import type { SessionInfo } from "../auth/session";

// Editor API (plan: "Settings editor"). The client edits a DRAFT document;
// nothing becomes active until save, which goes through publishConfig like
// every other writer. New widgets carry client-temporary `tmp_*` ids so
// preview/diff can address them; save strips them and the server assigns
// real instance ids (id discipline unchanged).

function stripTmpIds(doc: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(doc)) as {
    pages?: { rows?: { columns?: { widgets?: RawWidget[] }[] }[] }[];
  };
  for (const p of clone.pages ?? []) {
    for (const r of p.rows ?? []) {
      for (const c of r.columns ?? []) {
        for (const w of c.widgets ?? []) {
          if (typeof w.id === "string" && w.id.startsWith("tmp_")) delete w.id;
        }
      }
    }
  }
  return clone;
}

// tmp_* ids stay for preview/diff so the draft validates as-is.
function validateDraft(raw: unknown): { doc: RawDoc; error?: never } | { doc?: never; error: string } {
  try {
    return { doc: validateDoc(raw).doc };
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    return typeof b === "object" && b !== null ? b : null;
  } catch {
    return null;
  }
}

// A half-configured widget must not take down the whole preview: each
// widget is trial-parsed alone, and invalid ones are swapped for a
// "needs setup" note card (same id, so selection still works) before
// the document-level validation runs. Saving still requires validity.
function previewTolerant(raw: unknown): unknown {
  const clone = JSON.parse(JSON.stringify(raw)) as {
    timezone?: string;
    pages?: { rows?: { columns?: { widgets?: RawWidget[] }[] }[] }[];
  };
  // Trial parses inherit the document's zone, so a widget is judged the
  // same way the real validation will judge it.
  const docTz = typeof clone.timezone === "string" ? clone.timezone : undefined;
  let n = 0;
  for (const p of clone.pages ?? []) {
    for (const r of p.rows ?? []) {
      for (const c of r.columns ?? []) {
        const ws = c.widgets ?? [];
        for (let i = 0; i < ws.length; i++) {
          const w = ws[i] as RawWidget;
          try {
            // omit id/name so the probe defaults apply (explicit undefined
            // would override them and fail every widget)
            const { id: _id, name: _name, ...rest } = w;
            parseProbeWidget(rest as RawWidget, docTz);
          } catch (e) {
            n++;
            const msg = String(e instanceof Error ? e.message : e).replace(/^probe[.:]?\s*/, "");
            const title =
              (typeof w.title === "string" && w.title) ||
              DEFAULT_TITLES[String(w.type)] ||
              "Widget";
            ws[i] = {
              id: w.id,
              name:
                typeof w.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(w.name)
                  ? w.name
                  : `needs-setup-${n}`,
              type: "note",
              title: `\u26a0 ${title} - needs setup`,
              text: msg.slice(0, 200),
              render: "plain",
            };
          }
        }
      }
    }
  }
  return clone;
}

export async function editorPreview(req: Request, env: Env): Promise<Response> {
  const body = await readBody(req);
  if (!body?.doc) return json(400, { error: "doc required" });
  const v = validateDraft(previewTolerant(body.doc));
  if (v.error !== undefined) return json(200, { error: v.error });
  const runtime = validateDoc(v.doc).runtime;
  const pageIndex = Number(body.pageIndex ?? 0) || 0;
  const main = await renderMain(env, runtime, pageIndex);
  return json(200, { html: main.value, frameSrc: frameSrcFor(runtime) });
}

interface Position {
  page: string;
  row: number;
  col: number;
  idx: number;
}

function positions(doc: RawDoc): Map<string, Position> {
  const map = new Map<string, Position>();
  doc.pages.forEach((p) => {
    p.rows.forEach((r, ri) => {
      r.columns.forEach((c, ci) => {
        c.widgets.forEach((w, wi) => map.set(String(w.id), { page: p.name, row: ri, col: ci, idx: wi }));
      });
    });
  });
  return map;
}

function widgetLabel(w: RawWidget | undefined): string {
  if (!w) return "widget";
  // Human title first, then the type's default display name - never the
  // auto-generated instance name unless nothing better exists.
  return String(w.title ?? DEFAULT_TITLES[String(w.type)] ?? w.name ?? "widget");
}

// Semantic summary for the pre-save review: classifyDiff supplies the
// source-side facts; layout moves/retitles are computed here.
export function summarize(base: RawDoc, draft: RawDoc): {
  summary: string[];
  sensitive: string[];
  cacheClears: number;
} {
  const diff = classifyDiff(base, draft);
  const baseBy = new Map(docWidgets(base).map((w) => [String(w.id), w]));
  const draftBy = new Map(docWidgets(draft).map((w) => [String(w.id), w]));
  const basePos = positions(base);
  const draftPos = positions(draft);

  const summary: string[] = [];
  const sensitive = diff.needsSources.map((r) => r);

  for (const id of diff.createdIds) summary.push(`Add ${widgetLabel(draftBy.get(id))}`);
  for (const id of diff.removedIds) summary.push(`Remove ${widgetLabel(baseBy.get(id))}`);
  for (const [id, w] of draftBy) {
    const b = baseBy.get(id);
    if (!b) continue;
    const bp = basePos.get(id);
    const dp = draftPos.get(id);
    if (bp && dp && (bp.page !== dp.page || bp.row !== dp.row || bp.col !== dp.col)) {
      summary.push(`Move ${widgetLabel(w)} to ${dp.page} row ${dp.row + 1} column ${dp.col + 1}`);
    } else if (bp && dp && bp.idx !== dp.idx) {
      summary.push(`Reorder ${widgetLabel(w)} within its column`);
    }
    if (String(b.title ?? "") !== String(w.title ?? "")) {
      summary.push(`Retitle "${widgetLabel(b)}" to "${widgetLabel(w)}"`);
    }
    const layoutKeys = ["refresh_interval", "limit", "history", "height", "fields", "unit", "clocks", "target", "tz", "links", "text", "placeholder", "render", "coins", "symbols", "currency", "days", "accent", "items", "item_title", "item_url", "item_meta", "answer_path"];
    for (const k of layoutKeys) {
      if (JSON.stringify(b[k]) !== JSON.stringify(w[k])) summary.push(`Change ${k} on ${widgetLabel(w)}`);
    }
  }
  for (const r of diff.needsSources) {
    // create/remove already appear as Add/Remove lines above
    if (r.startsWith("create widget") || r.startsWith("remove widget")) continue;
    summary.push(r[0]?.toUpperCase() + r.slice(1));
  }
  if (JSON.stringify(base.theme) !== JSON.stringify(draft.theme)) summary.push("Change theme");
  if (JSON.stringify(base.themes ?? {}) !== JSON.stringify(draft.themes ?? {})) summary.push("Change theme presets");
  {
    const basePageTheme = new Map(base.pages.map((pg) => [pg.name, pg.theme]));
    for (const pg of draft.pages) {
      const prev = basePageTheme.get(pg.name);
      if (basePageTheme.has(pg.name) && prev !== pg.theme) {
        summary.push(`Set page "${pg.name}" theme to ${pg.theme ?? "default"}`);
      }
    }
  }
  const shape = (d: RawDoc) =>
    d.pages
      .map(
        (p) =>
          p.name +
          ":" +
          p.rows
            .map((r) => (r.title ?? "") + (r.fill === false ? "!fill" : "") + "[" + r.columns.map((c) => c.width + (c.title ?? "")).join(",") + "]")
            .join("|"),
      )
      .join(";");
  const pagesChanged = shape(base) !== shape(draft);
  if (pagesChanged) summary.push("Change page/column structure");

  return {
    summary: [...new Set(summary)],
    sensitive,
    cacheClears: diff.sourceChangedIds.length,
  };
}

export async function editorDiff(req: Request, env: Env): Promise<Response> {
  const body = await readBody(req);
  if (!body?.doc) return json(400, { error: "doc required" });
  const v = validateDraft(body.doc);
  if (v.error !== undefined) return json(200, { error: v.error });
  const { doc: baseDoc, version } = await getCurrentConfig(env);
  const s = summarize(baseDoc, v.doc);
  return json(200, { ...s, currentVersion: version });
}

export async function editorYaml(req: Request, _env: Env): Promise<Response> {
  const body = await readBody(req);
  if (!body?.doc) return json(400, { error: "doc required" });
  const v = validateDraft(body.doc);
  if (v.error !== undefined) return json(200, { error: v.error });
  return json(200, { yaml: docToYaml(v.doc) });
}

export async function editorParse(req: Request, _env: Env): Promise<Response> {
  const body = await readBody(req);
  if (typeof body?.yaml !== "string") return json(400, { error: "yaml required" });
  let raw: unknown;
  try {
    raw = yamlToRaw(body.yaml);
  } catch (e) {
    return json(200, { error: `YAML parse error: ${String(e)}` });
  }
  const v = validateDraft(raw);
  if (v.error !== undefined) return json(200, { error: v.error });
  return json(200, { doc: v.doc });
}

export async function editorSave(
  req: Request,
  env: Env,
  session: SessionInfo,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readBody(req);
  if (!body?.doc) return json(400, { error: "doc required" });
  if (String(body.csrf ?? "") !== (await csrfToken(session))) {
    return json(403, { error: "stale editor session (CSRF) - reload" });
  }
  const baseVersion = Number(body.base_version);
  if (!Number.isInteger(baseVersion)) return json(400, { error: "base_version required" });

  if (body.rebase) {
    const { doc: currentDoc, version: currentVersion } = await getCurrentConfig(env);
    if (Number(body.expected_current) !== currentVersion) {
      const baseRow0 = await env.DB
        .prepare("SELECT doc FROM config_versions WHERE version = ?1")
        .bind(baseVersion)
        .first<{ doc: string }>();
      const incoming = baseRow0
        ? summarize(validateDoc(JSON.parse(baseRow0.doc)).doc, currentDoc).summary
        : ["(base version no longer available)"];
      return json(409, { conflict: true, currentVersion, incoming });
    }
    const baseRow = await env.DB
      .prepare("SELECT doc FROM config_versions WHERE version = ?1")
      .bind(baseVersion)
      .first<{ doc: string }>();
    if (!baseRow) return json(200, { error: "base version no longer available - reload" });
    const baseDoc = validateDoc(JSON.parse(baseRow.doc)).doc;
    const { merged, conflicts, notes } = rebaseDraft(baseDoc, stripTmpIds(body.doc), currentDoc);
    if (conflicts.length > 0) return json(200, { rebase: true, conflicts });
    if (body.preview) {
      // stamp placeholder ids on creations so the summarizer can diff
      const previewCopy = JSON.parse(JSON.stringify(merged)) as {
        pages?: { rows?: { columns?: { widgets?: RawWidget[] }[] }[] }[];
      };
      let n = 0;
      for (const p of previewCopy.pages ?? [])
        for (const r of p.rows ?? [])
          for (const c of r.columns ?? [])
            for (const w of c.widgets ?? []) if (w.id === undefined) { w.id = `new_${++n}`; w.name = w.name ?? `new-${n}`; }
      try {
        const summary = summarize(currentDoc, validateDoc(previewCopy).doc).summary;
        return json(200, { rebase: true, summary: [...notes, ...summary] });
      } catch (e) {
        return json(200, { error: String(e instanceof Error ? e.message : e) });
      }
    }
    const epochR =
      (await env.DB.prepare("SELECT epoch FROM owner_state WHERE id = 1").first<{ epoch: number }>())
        ?.epoch ?? 1;
    const resR = await publishConfig(env, {
      baseVersion: currentVersion,
      candidate: merged,
      actor: "editor",
      hasSources: true,
      epoch: epochR,
    });
    if (resR.ok) {
      const newPulls = docWidgets(resR.doc).filter(
        (w) => resR.createdIds.includes(String(w.id)) && w.type !== "heartbeat" && w.type !== "iframe",
      );
      if (newPulls.length > 0) {
        ctx.waitUntil(
          Promise.allSettled(newPulls.map((w) => forceRefresh(env, String(w.id)))).then(() => undefined),
        );
      }
      return json(200, { ok: true, version: resR.version, doc: resR.doc });
    }
    if ("conflict" in resR && resR.conflict) {
      const { doc: cd2, version: v2 } = await getCurrentConfig(env);
      return json(409, { conflict: true, currentVersion: v2, incoming: summarize(currentDoc, cd2).summary });
    }
    return json(200, { error: "error" in resR ? resR.error : "unknown error" });
  }

  // If this save would overwrite concurrent edits, the compare-and-set
  // rejects it; the client shows the incoming changes (computed here on a
  // second round-trip via /diff against the new current) before retrying.
  const epoch =
    (await env.DB.prepare("SELECT epoch FROM owner_state WHERE id = 1").first<{ epoch: number }>())
      ?.epoch ?? 1;
  const res = await publishConfig(env, {
    baseVersion,
    candidate: stripTmpIds(body.doc),
    actor: "editor",
    hasSources: true,
    epoch,
  });
  if (res.ok) {
    // New AND source-changed pull widgets fetch immediately in the
    // background (same fenced path as the cron) instead of leaving a
    // "refresh pending" card until the next sweep.
    const wantIds = new Set([...res.createdIds, ...res.sourceChangedIds]);
    const refetch = docWidgets(res.doc).filter(
      (w) => wantIds.has(String(w.id)) && w.type !== "heartbeat" && w.type !== "iframe",
    );
    if (refetch.length > 0) {
      ctx.waitUntil(
        Promise.allSettled(refetch.map((w) => forceRefresh(env, String(w.id)))).then(() => undefined),
      );
    }
    return json(200, { ok: true, version: res.version, doc: res.doc });
  }
  if ("conflict" in res && res.conflict) {
    const { doc: currentDoc, version } = await getCurrentConfig(env);
    // Incoming changes = what happened between the editor's base and now.
    const baseRow = await env.DB
      .prepare("SELECT doc FROM config_versions WHERE version = ?1")
      .bind(baseVersion)
      .first<{ doc: string }>();
    const incoming = baseRow
      ? summarize(validateDoc(JSON.parse(baseRow.doc)).doc, currentDoc).summary
      : ["(base version no longer available)"];
    return json(409, { conflict: true, currentVersion: version, incoming });
  }
  return json(200, { error: "error" in res ? res.error : "unknown error" });
}

// ---------- three-way rebase (conflict recovery) ----------
// Widget-granular merge of base->draft onto current. Draft supplies the
// layout; widgets changed only in current are adopted, widgets deleted in
// current (and untouched in the draft) are removed, widgets added in
// current are re-inserted. Overlapping edits are reported as conflicts -
// never silently overwritten.

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
const stable = (v: unknown): string => JSON.stringify(sortKeysDeep(v));

function widgetLabelOf(w: RawWidget | undefined): string {
  if (!w) return "widget";
  return String(w.title ?? w.name ?? w.type ?? "widget");
}

interface DocShape {
  theme?: unknown;
  pages?: { name?: unknown; rows?: { columns?: { widgets?: RawWidget[] }[] }[] }[];
}

function widgetIndex(doc: DocShape): Map<string, RawWidget> {
  const out = new Map<string, RawWidget>();
  for (const p of doc.pages ?? []) {
    for (const r of p.rows ?? []) {
      for (const c of r.columns ?? []) {
        for (const w of c.widgets ?? []) if (typeof w.id === "string") out.set(w.id, w);
      }
    }
  }
  return out;
}

function layoutSignature(doc: DocShape): string {
  // EVERY structural property participates: page flags, row identity/
  // title/height, column title/width, widget placement. Anything missed
  // here could be silently replaced by the other draft during rebase.
  const pages = (doc.pages ?? []) as Record<string, unknown>[];
  return JSON.stringify(
    pages.map((p) => ({
      n: p.name,
      fit: p.fit_screen ?? null,
      pub: p.public ?? null,
      th: p.theme ?? null,
      hid: p.hidden ?? null,
      cn: p.collapse_navigation ?? null,
      ix: p.indexable ?? null,
      d: p.description ?? null,
      r: ((p.rows ?? []) as Record<string, unknown>[]).map((r) => ({
        nm: r.name ?? null,
        t: r.title ?? null,
        h: r.height ?? null,
        f: r.fill ?? null,
        c: ((r.columns ?? []) as Record<string, unknown>[]).map((c) => ({
          w: c.width ?? null,
          t: c.title ?? null,
          ids: ((c.widgets ?? []) as RawWidget[]).map((x) => x.id ?? "new"),
        })),
      })),
    })),
  );
}

export function rebaseDraft(
  baseDoc: unknown,
  draftDoc: unknown,
  currentDoc: unknown,
): { merged: unknown; conflicts: string[]; notes: string[] } {
  const base = baseDoc as DocShape;
  const current = currentDoc as DocShape;
  const draft = draftDoc as DocShape;
  // Layout base: when only the OTHER session rearranged (this draft's
  // structure matches base), its arrangement is adopted and this draft's
  // widget-level edits are grafted on. Otherwise the draft's layout hosts
  // the merge (both-changed structure is noted below).
  const conflicts: string[] = [];
  const notes: string[] = [];
  const draftMovedLayout = layoutSignature(draft) !== layoutSignature(base);
  const currentMovedLayout = layoutSignature(current) !== layoutSignature(base);
  const useCurrentLayout = !draftMovedLayout && currentMovedLayout;
  const merged = JSON.parse(JSON.stringify(useCurrentLayout ? current : draft)) as DocShape;
  if (useCurrentLayout) {
    // graft this draft's widget edits/additions/deletions onto current
    const draftByG = widgetIndex(draft);
    const baseByG = widgetIndex(base);
    const mergedByG = widgetIndex(merged);
    for (const [id, w] of draftByG) {
      const b = baseByG.get(id);
      const m = mergedByG.get(id);
      if (b && m && stable(b) !== stable(w)) {
        for (const k of Object.keys(m)) delete m[k];
        Object.assign(m, JSON.parse(JSON.stringify(w)));
      } else if (b && !m && stable(b) !== stable(w)) {
        conflicts.push(`"${widgetLabelOf(w)}" was deleted in the other session but edited here`);
      }
    }
    for (const [id, b] of baseByG) {
      if (!draftByG.has(id) && mergedByG.has(id)) {
        // deleted here; keep the deletion unless the other session edited it
        const curW = widgetIndex(current).get(id);
        if (curW && stable(curW) !== stable(b)) continue; // conflict reported below
        for (const pg of merged.pages ?? [])
          for (const r of pg.rows ?? [])
            for (const c of r.columns ?? []) c.widgets = (c.widgets ?? []).filter((x) => x.id !== id);
      }
    }
    // this draft's new widgets (no id yet) append to their draft column
    // path when it exists, else the first column
    (draft.pages ?? []).forEach((pg, pi) => {
      (pg.rows ?? []).forEach((r, ri) => {
        (r.columns ?? []).forEach((c, ci) => {
          for (const w of c.widgets ?? []) {
            if (w.id !== undefined) continue;
            const dest = merged.pages?.[pi]?.rows?.[ri]?.columns?.[ci] ?? merged.pages?.[0]?.rows?.[0]?.columns?.[0];
            if (dest) {
              dest.widgets = dest.widgets ?? [];
              dest.widgets.push(JSON.parse(JSON.stringify(w)) as RawWidget);
            }
          }
        });
      });
    });
  }
  const baseBy = widgetIndex(base);
  const draftBy = widgetIndex(merged);
  const curBy = widgetIndex(current);
  const changedInDraft = new Set<string>();
  for (const [id, w] of draftBy) {
    const b = baseBy.get(id);
    if (b && stable(b) !== stable(w)) changedInDraft.add(id);
  }
  const changedInCurrent = new Set<string>();
  for (const [id, w] of curBy) {
    const b = baseBy.get(id);
    if (b && stable(b) !== stable(w)) changedInCurrent.add(id);
  }

  // widgets changed only in current: adopt current's version in place
  for (const [id, w] of draftBy) {
    if (changedInCurrent.has(id) && !changedInDraft.has(id)) {
      const cur = curBy.get(id) as RawWidget;
      for (const k of Object.keys(w)) delete w[k];
      Object.assign(w, JSON.parse(JSON.stringify(cur)));
      notes.push(`kept the other session's changes to "${widgetLabelOf(cur)}"`);
    } else if (changedInCurrent.has(id) && changedInDraft.has(id)) {
      const cur = curBy.get(id);
      if (stable(cur) !== stable(w)) conflicts.push(`"${widgetLabelOf(w)}" was edited in both sessions`);
    }
  }
  // deletions
  for (const [id, b] of baseBy) {
    const inDraft = draftBy.has(id);
    const inCurrent = curBy.has(id);
    if (inDraft && !inCurrent) {
      if (changedInDraft.has(id)) {
        conflicts.push(`"${widgetLabelOf(b)}" was deleted in the other session but edited here`);
      } else {
        // remove from merged layout
        for (const p of merged.pages ?? []) {
          for (const r of p.rows ?? []) {
            for (const c of r.columns ?? []) {
              c.widgets = (c.widgets ?? []).filter((w) => w.id !== id);
            }
          }
        }
        notes.push(`removed "${widgetLabelOf(b)}" (deleted in the other session)`);
      }
    }
    if (!inDraft && inCurrent && changedInCurrent.has(id)) {
      conflicts.push(`"${widgetLabelOf(b)}" was deleted here but edited in the other session`);
    }
  }
  // additions in current: re-insert at the same structural path when it
  // exists, else the first column of the first page
  for (const [id, w] of curBy) {
    if (baseBy.has(id) || draftBy.has(id)) continue;
    let placed = false;
    (current.pages ?? []).forEach((p, pi) => {
      (p.rows ?? []).forEach((r, ri) => {
        (r.columns ?? []).forEach((c, ci) => {
          if (placed || !(c.widgets ?? []).some((x) => x.id === id)) return;
          const target = merged.pages?.[pi]?.rows?.[ri]?.columns?.[ci];
          const fallback = merged.pages?.[0]?.rows?.[0]?.columns?.[0];
          const dest = target ?? fallback;
          if (dest) {
            dest.widgets = dest.widgets ?? [];
            dest.widgets.push(JSON.parse(JSON.stringify(w)) as RawWidget);
            notes.push(`kept "${widgetLabelOf(w)}" (added in the other session)`);
            placed = true;
          }
        });
      });
    });
    if (!placed) conflicts.push(`could not place "${widgetLabelOf(w)}" (added in the other session)`);
  }
  // theme: field-wise three-way merge. The draft side comes from the
  // ACTUAL draft — when useCurrentLayout seeded merged from current, using
  // merged here would erase the draft's theme edits. The computed result
  // is always written into merged.
  {
    const bt = (base.theme ?? {}) as Record<string, unknown>;
    const dtSrc = ((draft as DocShape).theme ?? {}) as Record<string, unknown>;
    const ct = (current.theme ?? {}) as Record<string, unknown>;
    const out = JSON.parse(JSON.stringify(dtSrc)) as Record<string, unknown>;
    const keys = new Set([...Object.keys(bt), ...Object.keys(dtSrc), ...Object.keys(ct)]);
    let adopted = 0;
    for (const k of keys) {
      const dChanged = stable(dtSrc[k]) !== stable(bt[k]);
      const cChanged = stable(ct[k]) !== stable(bt[k]);
      if (cChanged && !dChanged) {
        if (ct[k] === undefined) delete out[k];
        else out[k] = JSON.parse(JSON.stringify(ct[k]));
        adopted++;
      } else if (cChanged && dChanged && stable(dtSrc[k]) !== stable(ct[k])) {
        conflicts.push(`theme.${k} was changed differently in both sessions`);
      }
    }
    if (Object.keys(out).length) merged.theme = out;
    else delete merged.theme;
    if (adopted > 0) {
      notes.push(`kept the other session's theme changes (${adopted} setting${adopted === 1 ? "" : "s"})`);
    }
  }
  // named theme presets: per-preset three-way merge, draft side from the
  // actual draft (same reasoning as above); result written into merged
  {
    const bth = (base as { themes?: Record<string, unknown> }).themes ?? {};
    const dthSrc = ((draft as { themes?: Record<string, unknown> }).themes ?? {}) as Record<string, unknown>;
    const cth = (current as { themes?: Record<string, unknown> }).themes ?? {};
    const out = JSON.parse(JSON.stringify(dthSrc)) as Record<string, unknown>;
    const names = new Set([...Object.keys(bth), ...Object.keys(dthSrc), ...Object.keys(cth)]);
    let adopted = 0;
    for (const name of names) {
      const dChanged = stable(dthSrc[name]) !== stable(bth[name]);
      const cChanged = stable(cth[name]) !== stable(bth[name]);
      if (cChanged && !dChanged) {
        if (cth[name] === undefined) delete out[name];
        else out[name] = JSON.parse(JSON.stringify(cth[name]));
        adopted++;
      } else if (cChanged && dChanged && stable(dthSrc[name]) !== stable(cth[name])) {
        conflicts.push(`theme preset "${name}" was changed differently in both sessions`);
      }
    }
    if (Object.keys(out).length) (merged as { themes?: Record<string, unknown> }).themes = out;
    else delete (merged as { themes?: Record<string, unknown> }).themes;
    if (adopted > 0) notes.push(`kept the other session's preset changes (${adopted})`);
  }
  // structural changes on BOTH sides: no safe operation-level merge exists
  // for arbitrary structure - block instead of publishing either layout
  // wholesale
  if (draftMovedLayout && currentMovedLayout) {
    conflicts.push(
      "layout/structure changed in both sessions (pages, rows, columns, or arrangement) - reload to start from latest, then re-apply your structural changes",
    );
  }
  if (useCurrentLayout) notes.push("adopted the other session's layout (you had no structural changes)");
  return { merged, conflicts, notes };
}

export async function editorRefresh(req: Request, env: Env): Promise<Response> {
  const body = await readBody(req);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return json(400, { error: "id required" });
  return json(200, await forceRefresh(env, id));
}

// Geocoding proxy for the weather widget's location search (open-meteo,
// keyless). Config-time only: results fill latitude/longitude; runtime
// refreshes never geocode.
export async function editorGeocode(req: Request, _env: Env): Promise<Response> {
  const body = await readBody(req);
  const q = String(body?.q ?? "").trim().slice(0, 60);
  if (!q) return json(400, { error: "q required" });
  const { safeFetchJson } = await import("../safefetch");
  try {
    const raw = (await safeFetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6`,
    )) as { results?: { name: string; admin1?: string; country_code?: string; latitude: number; longitude: number }[] };
    const results = (raw.results ?? []).map((r) => ({
      label: r.name + (r.admin1 ? `, ${r.admin1}` : "") + (r.country_code ? ` (${r.country_code})` : ""),
      name: r.name,
      lat: r.latitude,
      lon: r.longitude,
    }));
    return json(200, { results });
  } catch (e) {
    return json(200, { results: [], error: String(e instanceof Error ? e.message : e) });
  }
}

// Version history: last 30 versions with per-version semantic changes and
// what restoring each would change vs. current.
export async function editorHistory(req: Request, env: Env): Promise<Response> {
  await readBody(req);
  const { doc: currentDoc, version: currentVersion } = await getCurrentConfig(env);
  const { results: allRows } = await env.DB
    .prepare(
      `WITH RECURSIVE chain(version, doc, source_version, parent_version, created_at, created_by, depth) AS (
         SELECT v.version, v.doc, v.source_version, v.parent_version, v.created_at, v.created_by, 0
         FROM config_versions v WHERE v.version = ?1
         UNION ALL
         SELECT v.version, v.doc, v.source_version, v.parent_version, v.created_at, v.created_by, c.depth + 1
         FROM config_versions v
         JOIN chain c ON v.version = COALESCE(c.parent_version, c.version - 1)
         WHERE c.depth < 30
       )
       SELECT version, doc, source_version, parent_version, created_at, created_by FROM chain ORDER BY depth`,
    )
    .bind(currentVersion)
    .all<{ version: number; doc: string; source_version: number | null; parent_version: number | null; created_at: number; created_by: string }>();
  // Ancestry is anchored at the pointer and follows parent_version
  // directly - orphan rows and version-number gaps can never truncate or
  // pollute it (pre-migration rows fall back to version - 1).
  const results = allRows;
  const docs = new Map(results.map((r) => [r.version, validateDoc(JSON.parse(r.doc)).doc]));
  const items = results.slice(0, 30).map((r) => {
    const cur = docs.get(r.version) as RawDoc;
    const parentV = r.parent_version ?? r.version - 1;
    const prev = docs.get(parentV);
    const changes = prev ? summarize(prev, cur).summary : ["Initial import"];
    const restoreSummary = r.version === currentVersion ? [] : summarize(currentDoc, cur).summary;
    return {
      version: r.version,
      created_at: r.created_at,
      created_by: r.created_by,
      source_version: r.source_version,
      changes,
      restoreSummary,
    };
  });
  return json(200, { currentVersion, items });
}

export async function editorRestore(
  req: Request,
  env: Env,
  session: SessionInfo,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readBody(req);
  if (String(body?.csrf ?? "") !== (await csrfToken(session))) {
    return json(403, { error: "stale editor session (CSRF) - reload" });
  }
  const to = Number(body?.to_version);
  if (!Number.isInteger(to)) return json(400, { error: "to_version required" });
  const { version: currentVersion } = await getCurrentConfig(env);
  const epoch =
    (await env.DB.prepare("SELECT epoch FROM owner_state WHERE id = 1").first<{ epoch: number }>())
      ?.epoch ?? 1;
  const { rollbackConfig } = await import("../configstore");
  const res = await rollbackConfig(env, currentVersion, to, "editor", true, epoch);
  if (res.ok) {
    const newPulls = docWidgets(res.doc).filter(
      (w) => res.createdIds.includes(String(w.id)) && w.type !== "heartbeat" && w.type !== "iframe",
    );
    if (newPulls.length > 0) {
      ctx.waitUntil(
        Promise.allSettled(newPulls.map((w) => forceRefresh(env, String(w.id)))).then(() => undefined),
      );
    }
    return json(200, { ok: true, version: res.version, doc: res.doc });
  }
  if ("conflict" in res && res.conflict) {
    return json(409, { conflict: true, currentVersion: res.currentVersion });
  }
  return json(200, { error: "error" in res ? res.error : "unknown error" });
}

// Live-fetch a DRAFT widget's data so the preview fills in before save:
// runs the real widget module (same outbound-fetch contract) and returns
// the rendered body fragment. Nothing is persisted.
// Live sample for the field picker: fetch the widget's mapping root and
// flatten it to leaf paths with value previews. Nothing is persisted.
export async function editorSample(req: Request, env: Env): Promise<Response> {
  const body = await readBody(req);
  if (!body?.widget || typeof body.widget !== "object") return json(400, { error: "widget required" });
  let cfg;
  try {
    const { parseProbeWidget, getCurrentConfig } = await import("../config");
    // Probes inherit the saved document's timezone so a preview matches
    // what the widget will do once published.
    const docTz = (await getCurrentConfig(env)).runtime.timezone;
    cfg = parseProbeWidget(body.widget as RawWidget, docTz);
  } catch (e) {
    return json(200, { error: String(e instanceof Error ? e.message : e) });
  }
  if (cfg.type !== "mcp" && cfg.type !== "json-api") {
    return json(200, { error: "field picking applies to MCP and JSON API widgets" });
  }
  try {
    const mod =
      cfg.type === "mcp" ? await import("../widgets/mcp") : await import("../widgets/json-api");
    const root = await mod.fetchSampleRoot(cfg as never, env);
    if (root === undefined) return json(200, { error: "tool returned no mappable data" });
    const leaves: { path: string; preview: string }[] = [];
    const walk = (v: unknown, path: string, depth: number): void => {
      if (leaves.length >= 200 || depth > 6) return;
      if (v === null || typeof v !== "object") {
        const preview = String(v ?? "null").slice(0, 160);
        if (path) leaves.push({ path, preview });
        return;
      }
      if (Array.isArray(v)) {
        v.slice(0, 3).forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i), depth + 1));
        return;
      }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9_-]+$/.test(k)) continue; // path grammar
        walk(val, path ? `${path}.${k}` : k, depth + 1);
      }
    };
    walk(root, "", 0);
    return json(200, { leaves });
  } catch (e) {
    return json(200, { error: String(e instanceof Error ? e.message : e) });
  }
}

// Theme asset upload (background image / logo) into R2. Content-type is
// sniffed from magic bytes, never trusted from the request; keys are
// content-hashed so the serve route can cache immutably.
const ASSET_MAX_BYTES = 5 * 1024 * 1024;
function sniffImage(buf: Uint8Array): { ext: string; mime: string } | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mime: "image/png" };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  if (
    buf.length > 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

export async function editorUploadAsset(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const url = new URL(req.url);
  if (req.headers.get("x-csrf") !== (await csrfToken(session))) {
    return json(403, { error: "stale editor session (CSRF) - reload" });
  }
  const kind = url.searchParams.get("kind");
  if (kind !== "background" && kind !== "logo" && kind !== "widget" && kind !== "favicon") return json(400, { error: "kind must be background, logo, widget, or favicon" });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > ASSET_MAX_BYTES) return json(400, { error: "image too large (5 MB max)" });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength === 0) return json(400, { error: "empty upload" });
  if (body.byteLength > ASSET_MAX_BYTES) return json(400, { error: "image too large (5 MB max)" });
  const kindMeta = sniffImage(body);
  if (!kindMeta) return json(400, { error: "not a PNG, JPEG, or WebP image" });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const hash = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `${kind}-${hash}.${kindMeta.ext}`;
  await env.ASSETS.put(key, body, { httpMetadata: { contentType: kindMeta.mime } });
  return json(200, { path: `/asset/${key}` });
}

// Coin search proxy for the crypto widget (CoinGecko, keyless).
export async function editorCoinSearch(req: Request, _env: Env): Promise<Response> {
  const body = await readBody(req);
  const q = String(body?.q ?? "").trim().slice(0, 40);
  if (!q) return json(400, { error: "q required" });
  const { safeFetchJson } = await import("../safefetch");
  try {
    const raw = (await safeFetchJson(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`,
    )) as { coins?: { id?: string; name?: string; symbol?: string; market_cap_rank?: number | null }[] };
    const results = (raw.coins ?? [])
      .filter((c) => typeof c.id === "string")
      .slice(0, 8)
      .map((c) => ({
        id: c.id as string,
        label: `${c.name ?? c.id} (${(c.symbol ?? "").toUpperCase()})` + (c.market_cap_rank ? ` · #${c.market_cap_rank}` : ""),
      }));
    return json(200, { results });
  } catch (e) {
    return json(200, { results: [], error: String(e instanceof Error ? e.message : e) });
  }
}

// Symbol search proxy for the stocks widget (Yahoo, keyless; may be
// rate-limited - the widget also accepts typed tickers).
export async function editorSymbolSearch(req: Request, _env: Env): Promise<Response> {
  const body = await readBody(req);
  const q = String(body?.q ?? "").trim().slice(0, 40);
  if (!q) return json(400, { error: "q required" });
  const { safeFetchText } = await import("../safefetch");
  try {
    const text = await safeFetchText(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`,
    );
    let raw: { quotes?: { symbol?: string; shortname?: string; longname?: string; exchange?: string; quoteType?: string }[] };
    try {
      raw = JSON.parse(text);
    } catch {
      return json(200, { results: [], error: /too many requests/i.test(text) ? "rate limited by Yahoo - type the ticker directly" : "non-JSON response" });
    }
    const results = (raw.quotes ?? [])
      .filter((x) => typeof x.symbol === "string")
      .slice(0, 8)
      .map((x) => ({
        id: x.symbol as string,
        label: `${x.shortname ?? x.longname ?? x.symbol} (${x.symbol})` + (x.exchange ? ` \u00b7 ${x.exchange}` : ""),
      }));
    return json(200, { results });
  } catch (e) {
    return json(200, { results: [], error: String(e instanceof Error ? e.message : e) });
  }
}

// Channel resolution for the YouTube widget: @handle or channel URL ->
// UC… channel id. Config-time only, keyless: reads the public channel
// page (truncated at the cap - the id lives in the head metadata) and
// extracts the canonical channelId. Ids and playlist ids pass through.
export async function editorYtSearch(req: Request, _env: Env): Promise<Response> {
  const body = await readBody(req);
  const q = String(body?.q ?? "").trim().slice(0, 120);
  if (!q) return json(400, { error: "q required" });
  if (/^(UC|UU|PL)[A-Za-z0-9_-]{10,40}$/.test(q)) {
    // bare id: pull the channel/playlist name from its (small) feed so the
    // editor can show a name instead of the opaque id
    try {
      const { safeFetchText } = await import("../safefetch");
      const { feedUrl } = await import("../widgets/youtube");
      const xml = await safeFetchText(feedUrl(q), { maxBytes: 200_000, allowTruncate: true });
      const name = /<title[^>]*>([^<]{1,80})</.exec(xml)?.[1]?.trim();
      return json(200, { results: [{ id: q, label: name || q }] });
    } catch {
      return json(200, { results: [{ id: q, label: q }] });
    }
  }
  let pageUrl: string;
  try {
    const u = new URL(q);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) throw new Error("x");
    // re-rooted on the canonical host; query/fragment dropped
    pageUrl = "https://www.youtube.com" + u.pathname;
  } catch {
    const handle = (q.startsWith("@") ? q : "@" + q).replace(/\s+/g, "");
    pageUrl = "https://www.youtube.com/" + encodeURIComponent(handle);
  }
  const { safeFetchText } = await import("../safefetch");
  try {
    const html = await safeFetchText(pageUrl, {
      accept: ["text/html"],
      maxBytes: 1_500_000, // id markers sit ~750-950KB into the ~2.7MB page
      allowTruncate: true,
    });
    const id = /<meta itemprop="identifier" content="(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1]
      ?? /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(html)?.[1]
      ?? /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/.exec(html)?.[1];
    if (!id) return json(200, { results: [], error: "no channel found - paste the channel URL or UC… id" });
    const name = /<meta property="og:title" content="([^"]{1,80})"/.exec(html)?.[1];
    return json(200, { results: [{ id, label: name ? `${name}` : id }] });
  } catch (e) {
    return json(200, { results: [], error: String(e instanceof Error ? e.message : e) });
  }
}

// Tool discovery for the MCP widget's tool picker.
export async function editorMcpTools(req: Request, env: Env): Promise<Response> {
  const body = await readBody(req);
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url) return json(400, { error: "url required" });
  const authSecret = typeof body?.auth_secret === "string" && body.auth_secret ? body.auth_secret : undefined;
  const connection = typeof body?.connection === "string" && body.connection ? body.connection : undefined;
  try {
    const { listTools } = await import("../widgets/mcp");
    return json(200, { tools: await listTools(url, { authSecret, connection }, env) });
  } catch (e) {
    return json(200, { error: String(e instanceof Error ? e.message : e) });
  }
}

export async function editorProbe(req: Request, env: Env): Promise<Response> {
  const body = await readBody(req);
  if (!body?.widget || typeof body.widget !== "object") return json(400, { error: "widget required" });
  let cfg;
  try {
    const { parseProbeWidget, getCurrentConfig } = await import("../config");
    // Probes inherit the saved document's timezone so a preview matches
    // what the widget will do once published.
    const docTz = (await getCurrentConfig(env)).runtime.timezone;
    cfg = parseProbeWidget(body.widget as RawWidget, docTz);
  } catch (e) {
    return json(200, { error: String(e instanceof Error ? e.message : e) });
  }
  const { isPullWidget } = await import("../config");
  if (!isPullWidget(cfg)) {
    return json(200, { error: "nothing to fetch for this widget type" });
  }
  try {
    const { getModule } = await import("../widgets");
    const mod = getModule(cfg.type);
    const data = await mod.fetchData(cfg, env);
    return json(200, { html: mod.render(data, cfg).value });
  } catch (e) {
    return json(200, { error: String(e instanceof Error ? e.message : e) });
  }
}
