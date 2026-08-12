import { getConfig, isPullWidget, type PullWidgetConfig } from "./config";
import { getModule } from "./widgets";
import { logRetentionDays, logMaxPerWidget } from "./appsettings";

// Bounded refresh sweep: small concurrency
// pool, per-widget failure isolation, and D1-held leases fenced by
// generation + source revision. The rendered payload is published in the
// SAME conditional UPDATE that checks the fence, so a zombie refresher can
// never make stale data current - and being D1-atomic, no versioned keys
// or current/prev pointers are needed (they existed to paper over KV's
// eventual consistency; KV is now legacy-read-only during the transition).

const LEASE_MS = 60_000;
const CONCURRENCY = 3;

// What asked for this refresh: the scheduled sweep, or someone forcing it
// (card ↻, editor, MCP refresh_widget).
export type Trigger = "cron" | "manual";

// Every terminal outcome of a claimed refresh lands one refresh_log row
// (the /settings/log page). Logging must never break the refresh itself.
async function logAttempt(
  env: Env,
  instanceId: string,
  startedAt: number,
  ok: boolean,
  trigger: Trigger,
  error?: string,
): Promise<void> {
  try {
    await env.DB
      .prepare("INSERT INTO refresh_log (instance_id, at, ok, duration_ms, error, trigger_kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .bind(instanceId, Date.now(), ok ? 1 : 0, Date.now() - startedAt, error ? error.slice(0, 500) : null, trigger)
      .run();
  } catch (e) {
    console.log(JSON.stringify({ evt: "refresh_log_write_failed", error: String(e) }));
  }
}

interface Claim {
  generation: number;
  source_rev: number;
}

export async function sweep(env: Env): Promise<void> {
  const pullWidgets = (await getConfig(env)).widgets.filter(isPullWidget);
  if (pullWidgets.length === 0) return;

  await env.DB.batch(
    pullWidgets.map((w) =>
      env.DB
        .prepare("INSERT INTO refresh_state (instance_id) VALUES (?1) ON CONFLICT(instance_id) DO NOTHING")
        .bind(w.id),
    ),
  );

  // History retention: the window is an instance setting (Settings ->
  // the log page). Cheap single DELETE; the at-index makes it a range scan.
  const retentionMs = (await logRetentionDays(env)) * 24 * 3600 * 1000;
  await env.DB
    .prepare("DELETE FROM refresh_log WHERE at < ?1")
    .bind(Date.now() - retentionMs)
    .run()
    .catch(() => undefined);

  // Optional second bound: keep at most N entries PER WIDGET inside that
  // window, so one chatty card can't crowd the table. Per-widget rather
  // than a global row cap - a global one would evict a six-hourly
  // widget's whole history to make room for a 2-minute one. Unbounded (0)
  // is the default and skips the query entirely.
  const cap = await logMaxPerWidget(env);
  if (cap > 0) {
    await env.DB
      .prepare(
        `DELETE FROM refresh_log WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY instance_id ORDER BY at DESC, id DESC) AS rn
             FROM refresh_log
           ) WHERE rn > ?1
         )`,
      )
      .bind(cap)
      .run()
      .catch(() => undefined);
  }

  const queue = [...pullWidgets];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const w = queue.shift();
      if (!w) return;
      try {
        await refreshOne(env, w, "cron");
      } catch (e) {
        console.log(JSON.stringify({ evt: "refresh_error", widget: w.name, error: String(e) }));
      }
    }
  });
  await Promise.all(workers);
}

type RefreshOutcome = "refreshed" | "not_claimed" | "failed";

async function refreshOne(env: Env, w: PullWidgetConfig, trigger: Trigger): Promise<RefreshOutcome> {
  const now = Date.now();
  const owner = crypto.randomUUID();
  // Claim: only if due and no live lease. Incrementing generation fences
  // competing refreshers; capturing source_rev fences config changes.
  const claim = await env.DB
    .prepare(
      `UPDATE refresh_state
         SET lease_owner = ?1, lease_expires_at = ?2, generation = generation + 1
       WHERE instance_id = ?3
         AND (lease_owner IS NULL OR lease_expires_at < ?4)
         AND (fetched_at IS NULL OR fetched_at <= ?5)
       RETURNING generation, source_rev`,
    )
    .bind(owner, now + LEASE_MS, w.id, now, now - w.refreshSeconds * 1000)
    .first<Claim>();
  if (!claim) return "not_claimed"; // not due, or another refresher holds the lease

  const mod = getModule(w.type);
  let data: unknown;
  try {
    data = await mod.fetchData(w, env);
  } catch (e) {
    await env.DB
      .prepare(
        `UPDATE refresh_state
           SET lease_owner = NULL, lease_expires_at = NULL, last_error = ?1, updated_at = ?2
         WHERE instance_id = ?3 AND lease_owner = ?4 AND generation = ?5`,
      )
      .bind(String(e), Date.now(), w.id, owner, claim.generation)
      .run();
    console.log(JSON.stringify({ evt: "widget_fetch_failed", widget: w.name, error: String(e) }));
    await logAttempt(env, w.id, now, false, trigger, String(e));
    return "failed";
  }

  const payloadStr = JSON.stringify({ fetchedAt: Date.now(), data });
  if (payloadStr.length > 100_000) {
    await env.DB
      .prepare(
        `UPDATE refresh_state
           SET lease_owner = NULL, lease_expires_at = NULL, last_error = ?1, updated_at = ?2
         WHERE instance_id = ?3 AND lease_owner = ?4 AND generation = ?5`,
      )
      .bind(`payload too large (${payloadStr.length} bytes; cap 100000)`, Date.now(), w.id, owner, claim.generation)
      .run();
    await logAttempt(env, w.id, now, false, trigger, `payload too large (${payloadStr.length} bytes; cap 100000)`);
    return "failed";
  }

  // Conditional publish: still our lease, our generation, same source_rev.
  // Payload rides in the fenced UPDATE itself, so publish is atomic.
  const published = await env.DB
    .prepare(
      `UPDATE refresh_state
         SET payload = ?2, current_key = NULL, prev_key = NULL,
             fetched_at = ?3, updated_at = ?3,
             lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
       WHERE instance_id = ?4 AND lease_owner = ?5
         AND generation = ?1 AND source_rev = ?6`,
    )
    .bind(claim.generation, payloadStr, Date.now(), w.id, owner, claim.source_rev)
    .run();
  if (!published.meta.changed_db) {
    console.log(JSON.stringify({ evt: "publish_superseded", widget: w.name, generation: claim.generation }));
  }
  await logAttempt(env, w.id, now, true, trigger, published.meta.changed_db ? undefined : "fetched, but publish was superseded by a config change");
  return "refreshed";
}

// "Refresh now": make the widget immediately due, then run the ordinary
// refresh path inline - same lease claim, generation/source_rev fencing,
// and outbound-fetch contract as the cron, so forcing can't bypass or race
// anything. An active lease simply wins ("try again shortly").
export async function forceRefresh(env: Env, instanceId: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getConfig(env);
  const w = cfg.widgets.find((x) => x.id === instanceId);
  if (!w) return { ok: false, error: "unknown widget id" };
  if (!isPullWidget(w)) return { ok: false, error: `${w.type} widgets have nothing to fetch` };
  await env.DB
    .prepare("INSERT INTO refresh_state (instance_id) VALUES (?1) ON CONFLICT(instance_id) DO NOTHING")
    .bind(w.id)
    .run();
  await env.DB.prepare("UPDATE refresh_state SET fetched_at = NULL WHERE instance_id = ?1").bind(w.id).run();
  const outcome = await refreshOne(env, w, "manual");
  if (outcome === "refreshed") return { ok: true };
  if (outcome === "not_claimed") return { ok: false, error: "another refresh holds the lease - try again shortly" };
  const row = await env.DB
    .prepare("SELECT last_error FROM refresh_state WHERE instance_id = ?1")
    .bind(w.id)
    .first<{ last_error: string | null }>();
  return { ok: false, error: row?.last_error ?? "fetch failed" };
}
