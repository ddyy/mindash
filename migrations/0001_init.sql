-- mindash schema (squashed baseline). The Worker bootstraps this
-- automatically on first request against an empty database; running
-- `wrangler d1 migrations apply` first is equivalent. Every statement is
-- idempotent (CREATE ... IF NOT EXISTS / INSERT OR IGNORE), and
-- src/bootstrap.ts verifies the resulting tables, indexes, and columns
-- before recording the migration as applied.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('enroll', 'recover')),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS challenges (
  challenge_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('enroll', 'recover', 'login')),
  challenge TEXT NOT NULL,
  token_hash TEXT,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
, session_hash TEXT);

CREATE TABLE IF NOT EXISTS config_pointer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config_versions (
  version INTEGER PRIMARY KEY,
  doc TEXT NOT NULL,
  source_version INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
, parent_version INTEGER);

CREATE TABLE IF NOT EXISTS credentials (
  credential_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS dcr_admissions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS instances (
  instance_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tombstoned_at INTEGER
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash TEXT PRIMARY KEY,
  scopes TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  grant_db_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT,
  scopes TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  pending_id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  req_json TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  stepup_challenge TEXT,
  stepup_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS owner_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS push_runs (
  run_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  schedule_rev INTEGER,
  expected_at INTEGER,
  started_at INTEGER,
  deadline_at INTEGER,
  timed_out_at INTEGER,
  completed_at INTEGER,
  completion_outcome TEXT CHECK (completion_outcome IN ('success', 'fail')),
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_widget_state (
  instance_id TEXT PRIMARY KEY,
  schedule_rev INTEGER NOT NULL DEFAULT 1,
  activated_at INTEGER NOT NULL,
  cursor_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS refresh_state (
  instance_id TEXT PRIMARY KEY,
  source_rev INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fetched_at INTEGER,
  current_gen INTEGER,
  current_key TEXT,
  prev_gen INTEGER,
  prev_key TEXT,
  last_error TEXT,
  updated_at INTEGER
, payload TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  session_hash TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_runs_occurrence
  ON push_runs (instance_id, schedule_rev, expected_at)
  WHERE expected_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_push_runs_recent
  ON push_runs (instance_id, created_at DESC);

INSERT OR IGNORE INTO owner_state (id, epoch) VALUES (1, 1);

-- ---- from 0002_dcr_slots.sql ----
-- DCR admissions as per-client rows with expiry, replacing the lifetime
-- counter (which never decremented: 20 registrations ever = permanently
-- locked). Capacity counts only unexpired rows; reservation is atomic
-- (conditional INSERT) and released when registration fails. The old
-- dcr_admissions row remains for the rate-limit window only.
CREATE TABLE IF NOT EXISTS dcr_slots (
  slot_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The rate-limit window row was never seeded anywhere: on a fresh
-- database every UPDATE matched zero rows and the guard failed closed,
-- 429ing ALL registrations. Seed it idempotently.
INSERT OR IGNORE INTO dcr_admissions (id, active, window_start, window_count) VALUES (1, 0, 0, 0);

-- ---- from 0003_vault.sql ----
-- Encrypted API-credential vault. Values are AES-GCM ciphertext under a
-- master key held OUTSIDE this database (env.MASTER_KEY or OAUTH_KV) so a
-- D1 export alone reveals nothing. The credential's binding - name,
-- allowed widget types, destination origin, header - is the AEAD
-- associated data: editing a row to retarget a credential makes it
-- undecryptable instead of exfiltratable.
CREATE TABLE IF NOT EXISTS api_credentials (
  name TEXT PRIMARY KEY,
  widget_types TEXT NOT NULL,
  origin TEXT NOT NULL,
  header TEXT NOT NULL DEFAULT 'authorization',
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ---- from 0004_push_tokens.sql ----
-- Push tokens move from PUSH_TOKEN_* Worker secrets to hashed D1 rows
-- (same shape as mcp_tokens): created under Settings, value shown once,
-- only the SHA-256 stored. Each token authenticates exactly one heartbeat
-- widget, addressed by its stable config name.
CREATE TABLE IF NOT EXISTS push_tokens (
  token_hash TEXT PRIMARY KEY,
  widget_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- ---- from 0005_mcp_connections.sql ----
-- OAuth CLIENT state for upstream MCP servers. Token sets are sealed
-- under the vault master key with the connection name + server origin as
-- AEAD associated data (see src/mcpclient.ts). Pending rows carry an
-- in-flight authorization (state -> PKCE verifier) and expire in minutes.
CREATE TABLE IF NOT EXISTS mcp_connections (
  name TEXT PRIMARY KEY,
  server_url TEXT NOT NULL,
  origin TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 0,
  refresh_lease_until INTEGER,
  binding_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
  state TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  client_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  scopes TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ---- from 0006_mcp_refresh_lease.sql ----
-- Refresh serialization for shared MCP connections: concurrent widget
-- fetches must not race a single-use rotating refresh token. A claim is a
-- conditional UPDATE on (token_version, expired lease); publication is
-- conditional on the claimed version, so a stale exchange can never
-- overwrite a newer token set.

-- ---- from 0007_push_messages.sql ----
-- Log widget: lines pushed in over HTTP (cron output, CI results, agent
-- updates). Append-only per widget instance, pruned to the newest 100 on
-- insert. Auth reuses push_tokens (one token = one widget name).
CREATE TABLE IF NOT EXISTS push_messages (
  msg_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_messages_by_widget ON push_messages (instance_id, created_at DESC);

-- ---- from 0008_conn_binding_version.sql ----
-- Explicit binding format version for MCP connection ciphertext. Legacy
-- decryption is permitted ONLY when this trusted column says the row has
-- not migrated (version 1 = name|origin AAD; 2 = complete binding of
-- name|resource|token endpoint|client id). Inferring "legacy" from a
-- complete-binding decryption failure would let a tampered token_endpoint
-- fall back to the legacy AAD it still satisfies.

-- ---- from 0009_refresh_log.sql ----
-- Per-attempt refresh history behind /settings/log: every pull-widget
-- fetch records its outcome (refresh_state keeps only the LATEST result).
-- Pruned to a 7-day window by the sweep.
CREATE TABLE IF NOT EXISTS refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER,
  error TEXT,
  trigger_kind TEXT NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS idx_refresh_log_at ON refresh_log (at DESC);

-- ---- from 0010_refresh_log_trigger.sql ----
-- What caused a refresh attempt: the cron sweep, or someone forcing it
-- (the card's ↻, the editor, or an MCP refresh_widget call). Existing
-- rows predate forcing being distinguishable, so they default to cron.
-- Column name avoids SQLite's reserved TRIGGER keyword.

-- ---- from 0011_app_settings.sql ----
-- Instance preferences that are NOT part of the dashboard document:
-- operational knobs the owner sets in Settings, never exported, shared,
-- or writable over MCP. One row per key, values stored as text.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
