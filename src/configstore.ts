import {
  classifyDiff,
  docWidgets,
  enforceIdDiscipline,
  seedRaw,
  validateDoc,
  type RawDoc,
} from "./config";

// The single validated mutation path (plan: "Config & MCP"). Every writer -
// settings editor, MCP tools, seed import - funnels through publishConfig:
// id discipline, structural validation, semantic-diff authorization,
// reconciliation effects, and a compare-and-set version publish that also
// carries the owner-epoch precondition.

export interface PublishInput {
  baseVersion: number;
  candidate: unknown; // raw doc; widgets may omit id (new) but never invent one
  actor: string;
  hasSources: boolean; // caller's authority for source-bearing mutations
  epoch: number; // captured at auth time, re-verified at commit
  // Trusted restore (rollback only): ids from historical versions may be
  // reintroduced; matching tombstoned instances reactivate with fresh
  // source/schedule revisions (plan: "Widget identity & reconciliation").
  allowHistoricalIds?: boolean;
}

export type PublishResult =
  | { ok: true; version: number; doc: RawDoc; createdIds: string[]; sourceChangedIds: string[] }
  | { ok: false; conflict: true; currentVersion: number }
  | { ok: false; conflict?: false; error: string };

export async function publishConfig(env: Env, input: PublishInput): Promise<PublishResult> {
  const now = Date.now();
  const ptr = await env.DB
    .prepare("SELECT version FROM config_pointer WHERE id = 1")
    .first<{ version: number }>();
  const currentVersion = ptr?.version ?? 0;
  if (input.baseVersion !== currentVersion) {
    return { ok: false, conflict: true, currentVersion };
  }
  const baseRow = ptr
    ? await env.DB
        .prepare("SELECT doc FROM config_versions WHERE version = ?1")
        .bind(currentVersion)
        .first<{ doc: string }>()
    : null;
  // Stored docs may predate schema evolutions (e.g. the legacy
  // pages→columns shape) - always re-validate to the normalized form.
  const baseDoc: RawDoc | null = baseRow ? validateDoc(JSON.parse(baseRow.doc)).doc : null;
  const baseIds = new Set(baseDoc ? docWidgets(baseDoc).map((w) => String(w.id)) : []);

  let doc: RawDoc;
  let created: string[];
  try {
    const candidate = JSON.parse(JSON.stringify(input.candidate ?? {})) as unknown;
    let historicalIds: Set<string> | undefined;
    if (input.allowHistoricalIds) {
      const { results } = await env.DB
        .prepare("SELECT instance_id FROM instances")
        .all<{ instance_id: string }>();
      historicalIds = new Set(results.map((r) => r.instance_id));
    }
    created = enforceIdDiscipline(candidate, baseIds, historicalIds);
    // Names are server-owned like ids: auto-generated for new widgets,
    // immutable afterwards (heartbeat push URLs and logs key on them; the
    // human-facing field is `title`).
    const baseNameById = new Map(
      baseDoc ? docWidgets(baseDoc).map((w) => [String(w.id), String(w.name ?? "")]) : [],
    );
    const usedNames = new Set(baseNameById.values());
    const candWidgets = ((candidate as RawDoc).pages ?? []).flatMap((p) =>
      (p.rows ?? []).flatMap((r) => (r.columns ?? []).flatMap((c) => c.widgets ?? [])),
    );
    for (const w of candWidgets) {
      const id = String(w.id ?? "");
      const baseName = baseNameById.get(id);
      if (baseName !== undefined) {
        if (typeof w.name === "string" && w.name !== baseName) {
          return {
            ok: false,
            error: `widget name "${baseName}" is auto-generated and immutable - edit the title instead`,
          };
        }
        w.name = baseName;
      } else if (typeof w.name !== "string" || w.name.length === 0) {
        let candidateName: string;
        do {
          candidateName = `${String(w.type ?? "widget")}-${crypto
            .getRandomValues(new Uint8Array(2))
            .reduce((a, b) => a + b.toString(16).padStart(2, "0"), "")}`;
        } while (usedNames.has(candidateName));
        usedNames.add(candidateName);
        w.name = candidateName;
      }
    }
    doc = validateDoc(candidate).doc;
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }

  const diff = baseDoc
    ? classifyDiff(baseDoc, doc)
    : {
        createdIds: created,
        removedIds: [],
        sourceChangedIds: [],
        scheduleChangedIds: [],
        needsSources: [],
      };
  if (baseDoc && diff.needsSources.length > 0 && !input.hasSources) {
    return {
      ok: false,
      error: `config:sources scope required for: ${diff.needsSources.join("; ")}`,
    };
  }

  // Version numbers only need to be increasing, not contiguous: allocate
  // above MAX(version) rather than pointer+1 so an orphan row parked above
  // the pointer (crash mid-batch, manual surgery) can never wedge saves
  // with a UNIQUE collision. The CAS below still guards on the pointer.
  const maxRow = await env.DB
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM config_versions")
    .first<{ v: number }>();
  const newVersion = Math.max(currentVersion, maxRow?.v ?? 0) + 1;
  const LANDED = "EXISTS (SELECT 1 FROM config_versions WHERE version = ?1)";
  const widgetsById = new Map(docWidgets(doc).map((w) => [String(w.id), w]));

  const stmts: D1PreparedStatement[] = [
    // Version insert carries pointer + epoch preconditions.
    env.DB
      .prepare(
        `INSERT INTO config_versions (version, doc, source_version, parent_version, created_at, created_by)
         SELECT ?1, ?2, ?3, ?8, ?4, ?5
         WHERE COALESCE((SELECT version FROM config_pointer WHERE id = 1), 0) = ?6
           AND (SELECT epoch FROM owner_state WHERE id = 1) = ?7`,
      )
      .bind(newVersion, JSON.stringify(doc), null, now, input.actor, currentVersion, input.epoch, currentVersion),
    ptr
      ? env.DB
          .prepare(
            `UPDATE config_pointer SET version = ?1 WHERE id = 1 AND version = ?2 AND ${LANDED}`,
          )
          .bind(newVersion, currentVersion)
      : env.DB
          .prepare(`INSERT INTO config_pointer (id, version) SELECT 1, ?1 WHERE ${LANDED}`)
          .bind(newVersion),
  ];

  for (const id of diff.createdIds) {
    const w = widgetsById.get(id);
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO instances (instance_id, name, type, created_at)
           SELECT ?2, ?3, ?4, ?5 WHERE ${LANDED}
           ON CONFLICT (instance_id) DO NOTHING`,
        )
        .bind(newVersion, id, String(w?.name ?? id), String(w?.type ?? "?"), now),
      // Reactivate a tombstoned instance (restore path); no-op otherwise.
      env.DB
        .prepare(
          `UPDATE instances SET tombstoned_at = NULL
           WHERE instance_id = ?2 AND tombstoned_at IS NOT NULL AND ${LANDED}`,
        )
        .bind(newVersion, id),
      // Fresh revisions for reactivated state rows; brand-new widgets have
      // no rows yet, so these are no-ops for them.
      env.DB
        .prepare(
          `UPDATE refresh_state SET source_rev = source_rev + 1,
             lease_owner = NULL, lease_expires_at = NULL, fetched_at = NULL,
             payload = NULL, current_gen = NULL, current_key = NULL, prev_gen = NULL, prev_key = NULL,
             updated_at = ?3
           WHERE instance_id = ?2 AND ${LANDED}`,
        )
        .bind(newVersion, id, now),
      env.DB
        .prepare(
          `UPDATE push_widget_state SET schedule_rev = schedule_rev + 1,
             activated_at = ?3, cursor_at = ?3, updated_at = ?3
           WHERE instance_id = ?2 AND ${LANDED}`,
        )
        .bind(newVersion, id, now),
    );
  }
  for (const id of diff.removedIds) {
    stmts.push(
      env.DB
        .prepare(
          `UPDATE instances SET tombstoned_at = ?2
           WHERE instance_id = ?3 AND tombstoned_at IS NULL AND ${LANDED}`,
        )
        .bind(newVersion, now, id),
    );
  }
  // Source changed: advance source revision and drop leases + pointers so a
  // mid-flight refresher of the old source can never publish (fencing), and
  // stale data is never re-shown across a revision.
  for (const id of [...diff.sourceChangedIds, ...diff.removedIds]) {
    stmts.push(
      env.DB
        .prepare(
          `UPDATE refresh_state SET source_rev = source_rev + 1,
             lease_owner = NULL, lease_expires_at = NULL, fetched_at = NULL,
             payload = NULL, current_gen = NULL, current_key = NULL, prev_gen = NULL, prev_key = NULL,
             updated_at = ?2
           WHERE instance_id = ?3 AND ${LANDED}`,
        )
        .bind(newVersion, now, id),
    );
  }
  // Schedule changed: new schedule revision, fresh activation + cursor.
  for (const id of diff.scheduleChangedIds) {
    stmts.push(
      env.DB
        .prepare(
          `UPDATE push_widget_state SET schedule_rev = schedule_rev + 1,
             activated_at = ?2, cursor_at = ?2, updated_at = ?2
           WHERE instance_id = ?3 AND ${LANDED}`,
        )
        .bind(newVersion, now, id),
    );
  }

  try {
    const results = await env.DB.batch(stmts);
    if (!results[0]?.meta.changed_db) {
      const nowPtr = await env.DB
        .prepare("SELECT version FROM config_pointer WHERE id = 1")
        .first<{ version: number }>();
      return { ok: false, conflict: true, currentVersion: nowPtr?.version ?? 0 };
    }
  } catch (e) {
    // Concurrent publisher won the version PK; report a conflict.
    if (String(e).includes("UNIQUE")) {
      const nowPtr = await env.DB
        .prepare("SELECT version FROM config_pointer WHERE id = 1")
        .first<{ version: number }>();
      return { ok: false, conflict: true, currentVersion: nowPtr?.version ?? 0 };
    }
    throw e;
  }
  return { ok: true, version: newVersion, doc, createdIds: diff.createdIds, sourceChangedIds: diff.sourceChangedIds };
}

// Rollback is copy-forward: republish the selected historical document as a
// new version, recording where it came from; reconciliation re-runs.
export async function rollbackConfig(
  env: Env,
  baseVersion: number,
  toVersion: number,
  actor: string,
  hasSources: boolean,
  epoch: number,
): Promise<PublishResult> {
  const row = await env.DB
    .prepare("SELECT doc FROM config_versions WHERE version = ?1")
    .bind(toVersion)
    .first<{ doc: string }>();
  if (!row) return { ok: false, error: `version ${toVersion} does not exist` };
  const res = await publishConfig(env, {
    baseVersion,
    candidate: JSON.parse(row.doc),
    actor,
    hasSources,
    epoch,
    allowHistoricalIds: true,
  });
  if (res.ok) {
    await env.DB
      .prepare("UPDATE config_versions SET source_version = ?1 WHERE version = ?2")
      .bind(toVersion, res.version)
      .run();
  }
  return res;
}

// First-boot config import (race-safe; the loser of a concurrent import
// simply reads the winner's version).
//
// An UNCLAIMED instance gets a placeholder, not the examples: the example
// dashboard is one of the two choices /setup offers, so importing it here
// would decide for the owner before they arrive - and would publish a
// full dashboard from whatever anonymous request happened to land first.
// Once an owner exists (any later empty-config state) the examples are
// still the sane default.
export async function ensureSeed(env: Env): Promise<void> {
  const ptr = await env.DB
    .prepare("SELECT version FROM config_pointer WHERE id = 1")
    .first<{ version: number }>();
  if (ptr) return;
  const epoch =
    (await env.DB.prepare("SELECT epoch FROM owner_state WHERE id = 1").first<{ epoch: number }>())
      ?.epoch ?? 1;
  const { setupMode } = await import("./auth/webauthn");
  const { placeholderDoc } = await import("./setup");
  const unclaimed = await setupMode(env);
  const res = await publishConfig(env, {
    baseVersion: 0,
    candidate: unclaimed ? placeholderDoc() : seedRaw(),
    actor: "seed",
    hasSources: true,
    epoch,
  });
  if (!res.ok && !("conflict" in res && res.conflict)) {
    throw new Error(`seed import failed: ${"error" in res ? res.error : "conflict"}`);
  }
}
