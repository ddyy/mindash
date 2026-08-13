import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scriptConnectFor } from "../src/render";

// frame-ancestors is the one CSP directive that does NOT fall back to
// default-src, so `default-src 'none'` reads as airtight while leaving
// every page framable - the exact trap this app fell into. The policies
// are static strings spread across the modules that serve HTML, so the
// check that matters is structural: find them all, and let a new page
// that forgets the directive fail here rather than in someone's
// clickjacking PoC.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

test("every content-security-policy served with HTML sets frame-ancestors", () => {
  const offenders: string[] = [];
  let found = 0;
  for (const file of sourceFiles("src")) {
    const src = readFileSync(file, "utf8");
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) continue; // prose about CSP, not a policy
      if (!line.includes("default-src 'none'")) continue;
      found++;
      if (!line.includes("frame-ancestors")) offenders.push(`${file}: ${line.trim().slice(0, 60)}`);
    }
  }
  assert.equal(offenders.join("\n"), "", "CSP without frame-ancestors");
  // guards the guard: if the policies move or are refactored into a
  // builder, this count changes and the test demands a fresh look
  // instead of silently passing over zero policies.
  assert.equal(found, 7, "expected 7 CSP policies; update this test if pages were added or unified");
});

// The analytics opt-in is the ONLY thing that may widen script-src, and
// it must widen exactly two directives on exactly one surface. The risk
// it guards is silent scope creep: a future edit that applies the same
// relaxation to settings/editor/login would put a third-party script on
// an auth page, which is where it does the most damage.
test("cloudflare analytics opt-in widens script-src and connect-src together", () => {
  const off = scriptConnectFor(false);
  assert.equal(off, "; script-src 'self'; connect-src 'self'");

  const on = scriptConnectFor(true);
  // both hosts, or the script loads and its report is blocked instead
  assert.match(on, /script-src 'self' https:\/\/static\.cloudflareinsights\.com/);
  assert.match(on, /connect-src 'self' https:\/\/cloudflareinsights\.com/);
});

test("only the dashboard CSP can be widened by the analytics setting", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    if (file.endsWith("render.ts")) continue; // the one surface allowed to opt in
    const src = readFileSync(file, "utf8");
    if (src.includes("cloudflareinsights.com")) offenders.push(file);
  }
  assert.equal(offenders.join("\n"), "", "analytics hosts leaked into a non-dashboard CSP");
});
