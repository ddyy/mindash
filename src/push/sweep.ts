import { getConfig } from "../config";
import { nextOccurrenceAfter } from "./schedule";

// Timeout materialization: immutable history rows come
// from pings and this sweep - render-time staleness only colors the tile.
// The per-widget cursor bounds every sweep: the first has activation as a
// lower bound, and one resuming after downtime advances without unbounded
// catch-up rows (older missed occurrences are skipped, capped per sweep).

const MAX_CATCHUP_ROWS = 25;

export async function pushSweep(env: Env): Promise<void> {
  const now = Date.now();
  for (const w of (await getConfig(env)).widgets) {
    if (w.type !== "heartbeat") continue;
    try {
      const state = await env.DB
        .prepare(
          "SELECT schedule_rev, activated_at, cursor_at FROM push_widget_state WHERE instance_id = ?1",
        )
        .bind(w.id)
        .first<{ schedule_rev: number; activated_at: number; cursor_at: number }>();
      if (!state) continue; // never pinged and never swept before activation

      const s = w.schedule;
      let cursor = Math.max(state.cursor_at, state.activated_at);
      let next = nextOccurrenceAfter(s, cursor - 1);

      // Bound catch-up after downtime: skip older missed occurrences.
      const missed = Math.floor((now - s.graceMs - next) / s.intervalMs);
      if (missed > MAX_CATCHUP_ROWS) {
        const skipTo = next + (missed - MAX_CATCHUP_ROWS) * s.intervalMs;
        console.log(
          JSON.stringify({ evt: "push_sweep_skip", widget: w.name, skipped: missed - MAX_CATCHUP_ROWS }),
        );
        next = skipTo;
      }

      const stmts: D1PreparedStatement[] = [];
      let materialized = 0;
      while (next + s.graceMs < now && materialized < MAX_CATCHUP_ROWS) {
        // Conflict-safe: if a ping/start already claimed this occurrence the
        // insert is a no-op; open started runs are timed out separately below.
        stmts.push(
          env.DB
            .prepare(
              `INSERT INTO push_runs
                 (run_id, instance_id, schedule_rev, expected_at, timed_out_at, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?5)
               ON CONFLICT (instance_id, schedule_rev, expected_at) WHERE expected_at IS NOT NULL
               DO NOTHING`,
            )
            .bind(crypto.randomUUID(), w.id, state.schedule_rev, next, now),
        );
        materialized++;
        cursor = next;
        next += s.intervalMs;
      }

      // Started runs past their deadline: guarded - a racing late completion
      // keeps completed_at; this only stamps timed_out_at on open runs.
      stmts.push(
        env.DB
          .prepare(
            `UPDATE push_runs SET timed_out_at = ?1
             WHERE instance_id = ?2 AND completed_at IS NULL AND timed_out_at IS NULL
               AND deadline_at IS NOT NULL AND deadline_at < ?1`,
          )
          .bind(now, w.id),
      );
      stmts.push(
        env.DB
          .prepare(
            "UPDATE push_widget_state SET cursor_at = ?1, updated_at = ?2 WHERE instance_id = ?3",
          )
          .bind(cursor, now, w.id),
      );
      await env.DB.batch(stmts);
    } catch (e) {
      console.log(JSON.stringify({ evt: "push_sweep_error", widget: w.name, error: String(e) }));
    }
  }
}
