// Shared boot for the real-workerd integration suites: a dynamically
// allocated port (so parallel or interrupted runs cannot collide), an
// isolated state directory outside the repo, fail-fast startup that
// surfaces the child's own output, and a `sql` helper bound to that state.
//
// The local flag list deliberately drops global_fetch_strictly_public,
// which wrangler.jsonc ships for production (it is required by the CIMD
// auth lane) but which breaks ALL outbound fetch in local workerd.
//
// `--local` disables REMOTE bindings: wrangler.jsonc marks the Browser
// binding `remote: true` on purpose (dev renders hit Cloudflare's real
// fleet), but that needs a Cloudflare login, and a credential-free CI
// runner would hang at "Establishing remote connection" forever. These
// suites never exercise the scrape widget, so they must not depend on
// external account state.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export async function startWorker(prefix, extraArgs = []) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const state = mkdtempSync(join(tmpdir(), prefix));

  // Belt-and-braces: a stray listener on the chosen port would answer the
  // readiness probe while our fresh, schema-less state dir sits unused.
  try {
    await fetch(`${base}/login`);
    console.log(`FAIL: port ${port} is already in use - stop the stale server first`);
    rmSync(state, { recursive: true, force: true });
    process.exit(1);
  } catch {}

  const dev = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--port", String(port), "--persist-to", state, "--compatibility-flags", "nodejs_compat", ...extraArgs],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const capture = (chunk) => {
    output += String(chunk);
    if (output.length > 20000) output = output.slice(-20000);
  };
  dev.stdout.on("data", capture);
  dev.stderr.on("data", capture);
  let exited = null;
  dev.on("exit", (code, signal) => {
    exited = signal ? `signal ${signal}` : `code ${code}`;
  });

  const cleanup = () => {
    dev.kill();
    rmSync(state, { recursive: true, force: true });
  };
  process.on("exit", cleanup);

  const die = (why) => {
    console.log(`FAIL: ${why}`);
    if (output.trim()) console.log("--- wrangler output ---\n" + output.trim());
    process.exit(1);
  };

  for (let i = 0; ; i++) {
    // A child that died before serving is a hard failure, not a timeout.
    if (exited !== null) die(`wrangler dev exited before becoming ready (${exited})`);
    try {
      if ((await fetch(`${base}/login`)).ok) break;
    } catch {}
    if (i > 60) die("server never became ready within 60s");
    await new Promise((r) => setTimeout(r, 1000));
  }

  const sql = (command) =>
    execFileSync("npx", ["wrangler", "d1", "execute", "mindash", "--local", "--persist-to", state, "--command", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });

  // Query helper: returns the parsed rows of a single SELECT.
  const sqlJson = (command) =>
    JSON.parse(
      execFileSync(
        "npx",
        ["wrangler", "d1", "execute", "mindash", "--local", "--persist-to", state, "--json", "--command", command],
        { stdio: ["ignore", "pipe", "pipe"] },
      ).toString(),
    )[0].results;

  // Seeding runs `wrangler d1 execute` against the SAME state directory
  // the dev server holds open, and a bulk write occasionally makes
  // miniflare drop in-flight connections (ECONNRESET) while it recovers.
  // That is a rig artifact - two wrangler processes on one SQLite state -
  // not a Worker fault, so transient connection failures retry briefly.
  const fetchRetry = async (url, init, attempts = 5) => {
    for (let i = 1; ; i++) {
      try {
        return await fetch(url, init);
      } catch (e) {
        if (i >= attempts) throw e;
        await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
  };

  return { base, port, state, sql, sqlJson, fetchRetry, output: () => output, cleanup };
}
