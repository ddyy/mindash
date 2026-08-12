// Instance preferences (app_settings): operational knobs that belong to
// THIS deployment rather than to the dashboard document - so they are not
// exported with the config, not shared, and not writable over MCP. Owner
// session only, via Settings.

export const LOG_RETENTION_CHOICES = [1, 2, 3, 7, 14, 30, 60, 90] as const;
export const LOG_RETENTION_DEFAULT = 7;

// Per-widget entry cap, applied ON TOP of the time window: the newest N
// entries per widget survive, everything older within the window is
// pruned. It bounds what a chatty dashboard can accumulate (thirty
// widgets on a 2-minute sweep write ~21k rows a day) without starving a
// six-hourly widget the way a global row cap would.
//
// 0 means unbounded, and is the default: the time window alone decides,
// exactly as before this setting existed.
export const LOG_CAP_CHOICES = [0, 50, 100, 250, 500, 1000] as const;
export const LOG_CAP_DEFAULT = 0;

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT value FROM app_settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, Date.now())
    .run();
}

// How long the activity log keeps refresh history. Reads fail SOFT: a
// missing table or unreadable row must never break the sweep, so the
// default applies instead.
export async function logRetentionDays(env: Env): Promise<number> {
  try {
    const raw = await getSetting(env, "log_retention_days");
    const n = Number(raw);
    return (LOG_RETENTION_CHOICES as readonly number[]).includes(n) ? n : LOG_RETENTION_DEFAULT;
  } catch {
    return LOG_RETENTION_DEFAULT;
  }
}

export async function setLogRetentionDays(env: Env, days: number): Promise<boolean> {
  if (!(LOG_RETENTION_CHOICES as readonly number[]).includes(days)) return false;
  await setSetting(env, "log_retention_days", String(days));
  return true;
}

// Reads fail SOFT for the same reason as the window above: the sweep must
// survive a missing table or a junk row.
export async function logMaxPerWidget(env: Env): Promise<number> {
  try {
    const raw = await getSetting(env, "log_max_per_widget");
    const n = Number(raw);
    return (LOG_CAP_CHOICES as readonly number[]).includes(n) ? n : LOG_CAP_DEFAULT;
  } catch {
    return LOG_CAP_DEFAULT;
  }
}

export async function setLogMaxPerWidget(env: Env, n: number): Promise<boolean> {
  if (!(LOG_CAP_CHOICES as readonly number[]).includes(n)) return false;
  await setSetting(env, "log_max_per_widget", String(n));
  return true;
}
