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
  // consecutive failures BEFORE this attempt - the exponent for the wait
  // that follows if this one fails too
  fail_count: number;
}

// How long a failing widget waits before the sweep may claim it again.
//
// The first failure waits one of the widget's own intervals, and each
// consecutive one doubles that, up to an hour. Doubling from the interval
// rather than from a fixed floor keeps a fast card responsive (a 2-minute
// widget retries in 2 minutes) while a slow one does not get retried
// faster than it would ever have refreshed anyway.
//
// The floor matters as much as the cap: a widget with no interval of its
// own would otherwise compute a zero-length wait and go straight back to
// retrying on every sweep, which is the behaviour this exists to stop.
export const BACKOFF_CAP_MS = 3_600_000;
const BACKOFF_FLOOR_MS = 60_000;

export function backoffDelayMs(refreshSeconds: number, failCount: number): number {
  const base = Math.max(refreshSeconds * 1000, BACKOFF_FLOOR_MS);
  // 2^30 ms is already far past the cap; clamping the exponent keeps the
  // shift away from the range where doubling loses precision.
  const doublings = Math.min(Math.max(failCount, 0), 30);
  return Math.min(base * 2 ** doublings, BACKOFF_CAP_MS);
}

interface ClaimedRefresh {
  widget: PullWidgetConfig;
  trigger: Trigger;
  owner: string;
  startedAt: number;
  claim: Claim;
}

interface RefreshJob {
  widgets: PullWidgetConfig[];
  trigger: Trigger;
  batch: boolean;
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

  // Plan compatible groups first; each worker claims its group immediately
  // before fetching so queued work cannot age through the lease window.
  const queue = batchJobs(pullWidgets, "cron");
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      try {
        await runJob(env, job);
      } catch (e) {
        console.log(JSON.stringify({ evt: "refresh_error", widgets: job.widgets.map((x) => x.name), error: String(e) }));
      }
    }
  });
  await Promise.all(workers);
}

type RefreshOutcome = "refreshed" | "not_claimed" | "failed";

export function batchJobs(widgets: PullWidgetConfig[], trigger: Trigger): RefreshJob[] {
  const jobs: RefreshJob[] = [];
  const groups = new Map<string, { widgets: PullWidgetConfig[]; max: number }>();
  for (const widget of widgets) {
    const mod = getModule(widget.type);
    if (!mod.batch) {
      jobs.push({ widgets: [widget], trigger, batch: false });
      continue;
    }
    const key = `${widget.type}\0${mod.batch.groupKey(widget)}`;
    const group = groups.get(key) ?? { widgets: [], max: Math.max(1, mod.batch.maxBatchSize ?? 25) };
    group.widgets.push(widget);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.widgets.length; i += group.max) {
      jobs.push({ widgets: group.widgets.slice(i, i + group.max), trigger, batch: true });
    }
  }
  return jobs;
}

async function claimRefresh(env: Env, w: PullWidgetConfig, trigger: Trigger): Promise<ClaimedRefresh | null> {
  const startedAt = Date.now();
  const owner = crypto.randomUUID();
  const claim = await env.DB
    .prepare(
      `UPDATE refresh_state
         SET lease_owner = ?1, lease_expires_at = ?2, generation = generation + 1
       WHERE instance_id = ?3
         AND (lease_owner IS NULL OR lease_expires_at < ?4)
         AND (fetched_at IS NULL OR fetched_at <= ?5)
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?4)
       RETURNING generation, source_rev, fail_count`,
    )
    .bind(owner, startedAt + LEASE_MS, w.id, startedAt, startedAt - w.refreshSeconds * 1000)
    .first<Claim>();
  return claim ? { widget: w, trigger, owner, startedAt, claim } : null;
}

async function failClaim(env: Env, claimed: ClaimedRefresh, error: unknown): Promise<void> {
  const message = String(error);
  const now = Date.now();
  // fetched_at still points at the last SUCCESS (the card keeps showing
  // that data), so it cannot also serve as "when may we try again" - that
  // is what next_attempt_at is for.
  const delay = backoffDelayMs(claimed.widget.refreshSeconds, claimed.claim.fail_count);
  await env.DB
    .prepare(
      `UPDATE refresh_state
         SET lease_owner = NULL, lease_expires_at = NULL, last_error = ?1, updated_at = ?2,
             fail_count = fail_count + 1, next_attempt_at = ?6
       WHERE instance_id = ?3 AND lease_owner = ?4 AND generation = ?5`,
    )
    .bind(message, now, claimed.widget.id, claimed.owner, claimed.claim.generation, now + delay)
    .run();
  console.log(JSON.stringify({
    evt: "widget_fetch_failed",
    widget: claimed.widget.name,
    error: message,
    failures: claimed.claim.fail_count + 1,
    retry_in_ms: delay,
  }));
  await logAttempt(env, claimed.widget.id, claimed.startedAt, false, claimed.trigger, message);
}

async function publishClaim(env: Env, claimed: ClaimedRefresh, data: unknown): Promise<RefreshOutcome> {
  const fetchedAt = Date.now();
  const payloadStr = JSON.stringify({ fetchedAt, data });
  if (payloadStr.length > 100_000) {
    await failClaim(env, claimed, `payload too large (${payloadStr.length} bytes; cap 100000)`);
    return "failed";
  }
  const published = await env.DB
    .prepare(
      `UPDATE refresh_state
         SET payload = ?2, current_key = NULL, prev_key = NULL,
             fetched_at = ?3, updated_at = ?3,
             lease_owner = NULL, lease_expires_at = NULL, last_error = NULL,
             fail_count = 0, next_attempt_at = NULL
       WHERE instance_id = ?4 AND lease_owner = ?5
         AND generation = ?1 AND source_rev = ?6`,
    )
    .bind(claimed.claim.generation, payloadStr, fetchedAt, claimed.widget.id, claimed.owner, claimed.claim.source_rev)
    .run();
  if (!published.meta.changed_db) {
    console.log(JSON.stringify({ evt: "publish_superseded", widget: claimed.widget.name, generation: claimed.claim.generation }));
  }
  await logAttempt(env, claimed.widget.id, claimed.startedAt, true, claimed.trigger, published.meta.changed_db ? undefined : "fetched, but publish was superseded by a config change");
  return "refreshed";
}

async function runJob(env: Env, job: RefreshJob): Promise<RefreshOutcome[]> {
  const claims: ClaimedRefresh[] = [];
  for (const widget of job.widgets) {
    const claim = await claimRefresh(env, widget, job.trigger);
    if (claim) claims.push(claim);
  }
  const first = claims[0];
  if (!first) return [];
  const mod = getModule(first.widget.type);
  if (job.batch && mod.batch) {
    let results: Map<string, unknown>;
    try {
      results = await mod.batch.fetch(claims.map((x) => x.widget), env);
    } catch (e) {
      await Promise.all(claims.map((claimed) => failClaim(env, claimed, e)));
      return claims.map(() => "failed" as const);
    }
    // A mapping or publication problem belongs to that widget alone. One
    // bad result must not turn already-valid siblings into batch failures.
    return Promise.all(claims.map(async (claimed) => {
      if (!results.has(claimed.widget.id)) {
        await failClaim(env, claimed, "batch provider returned no result for widget");
        return "failed" as const;
      }
      try {
        return await publishClaim(env, claimed, results.get(claimed.widget.id));
      } catch (e) {
        await failClaim(env, claimed, e);
        return "failed" as const;
      }
    }));
  }
  try {
    return [await publishClaim(env, first, await mod.fetchData(first.widget, env))];
  } catch (e) {
    await failClaim(env, first, e);
    return ["failed"];
  }
}

async function refreshOne(env: Env, w: PullWidgetConfig, trigger: Trigger): Promise<RefreshOutcome> {
  const outcomes = await runJob(env, { widgets: [w], trigger, batch: getModule(w.type).batch !== undefined });
  return outcomes[0] ?? "not_claimed";
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
  // Forcing clears the backoff as well as the due-time: asking for a
  // refresh IS the decision to try again now, and a widget waiting out an
  // hour-long backoff is exactly the one someone reaches for the button on.
  // The failure run is left intact, so if this attempt fails too the next
  // automatic wait continues from where it was rather than restarting.
  await env.DB
    .prepare("UPDATE refresh_state SET fetched_at = NULL, next_attempt_at = NULL WHERE instance_id = ?1")
    .bind(w.id)
    .run();
  const outcome = await refreshOne(env, w, "manual");
  if (outcome === "refreshed") return { ok: true };
  if (outcome === "not_claimed") return { ok: false, error: "another refresh holds the lease - try again shortly" };
  const row = await env.DB
    .prepare("SELECT last_error FROM refresh_state WHERE instance_id = ?1")
    .bind(w.id)
    .first<{ last_error: string | null }>();
  return { ok: false, error: row?.last_error ?? "fetch failed" };
}
