import m1 from "../migrations/0001_init.sql";
import m2 from "../migrations/0002_backoff.sql";

// One-click-deploy schema bootstrap: the Deploy to Cloudflare flow
// provisions an EMPTY D1 database and never runs `wrangler d1 migrations
// apply`, so the Worker replays the migration files itself on first
// contact. Idempotency is EXPLICIT in the SQL (CREATE ... IF NOT EXISTS,
// INSERT OR IGNORE) plus a pragma pre-check for ALTER TABLE ADD COLUMN,
// which SQLite cannot express. No error is swallowed: a failing statement
// aborts the run without recording the migration, and completion is only
// recorded after the migration's tables/indexes/columns are verified to
// exist - so a partial apply retries on the next request instead of
// silently leaving a half-migrated schema behind.
const MIGRATIONS: [string, string][] = [["0001_init.sql", m1], ["0002_backoff.sql", m2]];

function statementsOf(sql: string): string[] {
  const noComments = sql
    .split("\n")
    .filter((ln) => !ln.trim().startsWith("--"))
    .join("\n");
  return noComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// What a migration must have produced once it has run.
interface Expectations {
  objects: string[]; // tables/indexes by name in sqlite_master
  columns: [string, string][]; // [table, column]
}

const ADD_COLUMN = /^ALTER\s+TABLE\s+([A-Za-z0-9_]+)\s+ADD\s+COLUMN\s+([A-Za-z0-9_]+)/i;
const CREATE_OBJECT = /^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i;

function expectationsOf(statements: string[]): Expectations {
  const objects: string[] = [];
  const columns: [string, string][] = [];
  for (const stmt of statements) {
    const add = ADD_COLUMN.exec(stmt);
    if (add?.[1] && add[2]) {
      columns.push([add[1], add[2]]);
      continue;
    }
    const obj = CREATE_OBJECT.exec(stmt);
    if (obj?.[2]) objects.push(obj[2]);
  }
  return { objects, columns };
}

async function columnExists(env: Env, table: string, column: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info(?1) WHERE name = ?2")
    .bind(table, column)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

async function objectExists(env: Env, name: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?1")
    .bind(name)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0;
}

let booted: Promise<void> | undefined;

export function ensureSchema(env: Env): Promise<void> {
  booted ??= run(env).catch((e) => {
    booted = undefined; // allow retry on the next request
    throw e;
  });
  return booted;
}

async function run(env: Env): Promise<void> {
  await env.DB
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT UNIQUE,
         applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp
       )`,
    )
    .run();
  const { results } = await env.DB.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const done = new Set(results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    const statements = statementsOf(sql);
    for (const stmt of statements) {
      // SQLite has no ADD COLUMN IF NOT EXISTS: skip when already present
      // rather than relying on the error text of a failure.
      const add = ADD_COLUMN.exec(stmt);
      if (add?.[1] && add[2] && (await columnExists(env, add[1], add[2]))) continue;
      await env.DB.prepare(stmt).run(); // any error aborts; nothing recorded
    }
    // Postconditions: only record completion once the schema really has
    // what this migration promised.
    const { objects, columns } = expectationsOf(statements);
    for (const obj of objects) {
      if (!(await objectExists(env, obj))) {
        throw new Error(`bootstrap: ${name} did not create "${obj}"`);
      }
    }
    for (const [table, column] of columns) {
      if (!(await columnExists(env, table, column))) {
        throw new Error(`bootstrap: ${name} did not add ${table}.${column}`);
      }
    }
    await env.DB.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?1)").bind(name).run();
    console.log(JSON.stringify({ evt: "bootstrap_migration_applied", name }));
  }
}
