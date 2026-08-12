import { getConfig, type HeartbeatWidget } from "../config";
import { sha256Hex } from "../auth/util";
import { claimableOccurrence } from "./schedule";
import { LOG_LEVELS } from "./log";

// Push ingest: Bearer-token auth only - tokens
// never in URLs - bounded payloads, per-widget rate cap. Tokens are D1
// rows (hash only, created in Settings, bound to one widget name); a
// config-referenced PUSH_TOKEN_* Worker secret still works as a legacy
// fallback lane. `/push/:id/start` opens a run and returns its id;
// completions target that run so retries/overlaps attach to the right
// record. A plain one-shot ping creates an already-completed run,
// claiming its scheduled occurrence when one is in window (expected_at
// NULL for manual runs).

const MAX_PAYLOAD_BYTES = 16 * 1024;
const RATE_LIMIT_PER_MIN = 30;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const a = await crypto.subtle.digest("SHA-256", enc.encode(presented));
  const b = await crypto.subtle.digest("SHA-256", enc.encode(expected));
  return crypto.subtle.timingSafeEqual(a, b);
}

async function readBoundedBody(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAYLOAD_BYTES) {
      await reader.cancel();
      return null;
    }
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

async function ensureState(env: Env, w: HeartbeatWidget, now: number): Promise<{
  schedule_rev: number;
  activated_at: number;
}> {
  await env.DB
    .prepare(
      `INSERT INTO push_widget_state (instance_id, activated_at, cursor_at, updated_at)
       VALUES (?1, ?2, ?2, ?2) ON CONFLICT(instance_id) DO NOTHING`,
    )
    .bind(w.id, now)
    .run();
  const row = await env.DB
    .prepare("SELECT schedule_rev, activated_at FROM push_widget_state WHERE instance_id = ?1")
    .bind(w.id)
    .first<{ schedule_rev: number; activated_at: number }>();
  if (!row) throw new Error("push state row missing after insert");
  return row;
}

export async function handlePush(req: Request, env: Env, url: URL): Promise<Response> {
  const m = /^\/push\/([a-z0-9][a-z0-9-]*)(\/start)?$/.exec(url.pathname);
  if (!m) return json(404, { error: "not found" });
  const name = m[1] ?? "";
  const isStart = Boolean(m[2]);

  const w = (await getConfig(env)).widgets.find((x) => x.name === name);
  if (!w || (w.type !== "heartbeat" && w.type !== "log")) return json(404, { error: "unknown push widget" });
  if (w.type === "log" && isStart) return json(404, { error: "log widgets have no runs to start" });

  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!presented) return json(401, { error: "unauthorized" });
  // Primary lane: a D1 push token bound to this widget's name.
  const row = await env.DB
    .prepare("SELECT 1 AS ok FROM push_tokens WHERE token_hash = ?1 AND widget_name = ?2 AND revoked_at IS NULL")
    .bind(await sha256Hex(presented), w.name)
    .first<{ ok: number }>();
  let authed = Boolean(row);
  if (!authed && w.type === "heartbeat" && w.tokenSecret) {
    // Legacy lane: config-referenced Worker secret (pre-vault deploys).
    const expected = (env as unknown as Record<string, string | undefined>)[w.tokenSecret];
    authed = Boolean(expected) && (await tokenMatches(presented, expected as string));
  }
  if (!authed) return json(401, { error: "unauthorized" });

  const now = Date.now();
  const rateTable = w.type === "log" ? "push_messages" : "push_runs";
  const recent = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM ${rateTable} WHERE instance_id = ?1 AND created_at > ?2`)
    .bind(w.id, now - 60_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= RATE_LIMIT_PER_MIN) return json(429, { error: "rate limited" });

  const body = await readBoundedBody(req);
  if (body === null) return json(413, { error: "payload too large" });
  const payload = body.length > 0 ? body : null;

  if (w.type === "log") {
    // Body is either JSON {text, level} or the message itself as plain
    // text; ?level= works for the plain form. Text is stored as data and
    // escaped at render.
    let text = body.trim();
    let level = url.searchParams.get("level") ?? "";
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.text === "string") {
          text = parsed.text.trim();
          if (typeof parsed.level === "string") level = parsed.level;
        }
      } catch {
        // not JSON after all - keep the raw text
      }
    }
    if (!text) return json(400, { error: "empty message" });
    text = text.slice(0, 500);
    if (!LOG_LEVELS.has(level)) level = "info";
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO push_messages (msg_id, instance_id, level, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(crypto.randomUUID(), w.id, level, text, now),
      // retention: newest 100 per widget
      env.DB
        .prepare(
          `DELETE FROM push_messages WHERE instance_id = ?1 AND msg_id NOT IN
             (SELECT msg_id FROM push_messages WHERE instance_id = ?1 ORDER BY created_at DESC LIMIT 100)`,
        )
        .bind(w.id),
    ]);
    return json(200, { ok: true });
  }

  const state = await ensureState(env, w, now);
  const schedule = w.schedule;
  const expectedAt = claimableOccurrence(schedule, now, state.activated_at);

  if (isStart) {
    const runId = crypto.randomUUID();
    await env.DB
      .prepare(
        `INSERT INTO push_runs
           (run_id, instance_id, schedule_rev, expected_at, started_at, deadline_at, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?5)
         ON CONFLICT (instance_id, schedule_rev, expected_at) WHERE expected_at IS NOT NULL
         DO UPDATE SET started_at = excluded.started_at, deadline_at = excluded.deadline_at
           WHERE push_runs.completed_at IS NULL AND push_runs.started_at IS NULL`,
      )
      .bind(runId, w.id, state.schedule_rev, expectedAt, now, now + schedule.graceMs, payload)
      .run();
    // The occurrence row may pre-exist (materialized timeout or duplicate
    // start); return whichever run now owns the occurrence.
    const owner = expectedAt
      ? await env.DB
          .prepare(
            `SELECT run_id FROM push_runs
             WHERE instance_id = ?1 AND schedule_rev = ?2 AND expected_at = ?3`,
          )
          .bind(w.id, state.schedule_rev, expectedAt)
          .first<{ run_id: string }>()
      : { run_id: runId };
    return json(200, { ok: true, run_id: owner?.run_id ?? runId });
  }

  const status = url.searchParams.get("status") === "fail" ? "fail" : "success";
  const rid = url.searchParams.get("rid");

  if (rid) {
    // Completion targeting a started run. Guarded: never clears timed_out_at,
    // never double-completes - both facts survive regardless of arrival order.
    const res = await env.DB
      .prepare(
        `UPDATE push_runs
           SET completed_at = ?1, completion_outcome = ?2,
               payload = COALESCE(?3, payload)
         WHERE run_id = ?4 AND instance_id = ?5 AND completed_at IS NULL`,
      )
      .bind(now, status, payload, rid, w.id)
      .run();
    if (!res.meta.changed_db) return json(409, { error: "unknown run or already completed" });
    return json(200, { ok: true, run_id: rid });
  }

  // One-shot ping: an already-completed run, claiming its occurrence if one
  // is in window. If the occurrence row exists (timeout already materialized,
  // or an open /start run), amend it guardedly instead of duplicating.
  const runId = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO push_runs
         (run_id, instance_id, schedule_rev, expected_at, completed_at, completion_outcome, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?5)
       ON CONFLICT (instance_id, schedule_rev, expected_at) WHERE expected_at IS NOT NULL
       DO UPDATE SET completed_at = excluded.completed_at,
                     completion_outcome = excluded.completion_outcome,
                     payload = COALESCE(excluded.payload, push_runs.payload)
         WHERE push_runs.completed_at IS NULL`,
    )
    .bind(runId, w.id, state.schedule_rev, expectedAt, now, status, payload)
    .run();
  return json(200, { ok: true, run_id: runId });
}
