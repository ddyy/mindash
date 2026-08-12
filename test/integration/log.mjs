// Integration test for /settings/log against a real wrangler dev instance
// with isolated state: column headers, the widget filter, the failures
// filter, and keyset pagination (older/newest) over seeded rows.
// The owner session is seeded by DIRECT database access (the same
// operator-only mechanism auth.mjs uses); no production surface does this.
import { createHash, randomBytes } from "node:crypto";
import { startWorker } from "./harness.mjs";

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log(`ok: ${label}`);
  else {
    failures++;
    console.log(`FAIL: ${label}${extra ? ` - ${extra}` : ""}`);
  }
};

const { base: BASE, sql, sqlJson, fetchRetry } = await startWorker("mindash-log-");

for (let i = 0; ; i++) {
  try {
    const r = await fetchRetry(`${BASE}/login`);
    if (r.ok) break;
  } catch {}
  if (i > 60) {
    console.log("FAIL: server never became ready");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

const sessionToken = randomBytes(24).toString("hex");
const now = Date.now();
sql(
  `INSERT INTO credentials (credential_id, public_key, counter, created_at) VALUES ('test-cred','dGVzdA',0,${now});` +
    `INSERT INTO sessions (session_hash, credential_id, epoch, created_at, expires_at) VALUES ('${sha256hex(sessionToken)}','test-cred',1,${now},${now + 3600_000});`,
);
const cookie = `session=${sessionToken}`;

// Anonymous access is redirected to login before anything else.
const anon = await fetchRetry(`${BASE}/settings/log`, { redirect: "manual" });
ok(anon.status === 303, "anonymous /settings/log redirects to login", `got ${anon.status}`);

// The seed config is imported on the first dashboard request; do that
// before reading widget ids out of it.
const seeded = await fetchRetry(`${BASE}/`, { headers: { cookie }, redirect: "manual" });
ok(seeded.status === 200, "seeded session authenticates the dashboard", `got ${seeded.status}`);

// Two widgets from the seed config, so entries carry real titles. The
// config document is the source of ids - refresh_state only fills in
// once a sweep has run.
const doc = sqlJson("SELECT doc FROM config_versions ORDER BY version DESC LIMIT 1")[0].doc;
const ids = [...doc.matchAll(/"id":\s*"(w_[0-9a-f]+)"/g)].map((m) => m[1]).slice(0, 2);
ok(ids.length === 2, "seed config produced widgets to log against", `got ${ids.length}`);

// 150 rows for widget A (crosses the 100-row page), 3 failures for widget B.
const rows = [];
for (let i = 0; i < 150; i++) rows.push(`('${ids[0]}', ${now - i * 60_000}, 1, ${100 + i}, NULL)`);
for (let i = 0; i < 3; i++) rows.push(`('${ids[1]}', ${now - i * 3_600_000}, 0, 250, 'upstream 503 from example.test')`);
sql(`INSERT INTO refresh_log (instance_id, at, ok, duration_ms, error) VALUES ${rows.join(",")};`);

const get = async (path) => (await fetchRetry(`${BASE}${path}`, { headers: { cookie } })).text();
const countRows = (html) => (html.match(/<tr class="log-(?:ok|fail)"/g) ?? []).length;

// A forced refresh must be distinguishable from the cron sweep.
sql(
  `INSERT INTO refresh_log (instance_id, at, ok, duration_ms, error, trigger_kind) VALUES ('${ids[0]}', ${now + 1000}, 1, 42, NULL, 'manual');`,
);

sql(
  `INSERT INTO push_messages (msg_id, instance_id, level, text, created_at) VALUES ('m1','${ids[1]}','info','deploy finished',${now + 2000}),('m2','${ids[1]}','error','disk almost full',${now + 3000});`,
);

const page1 = await get("/settings/log");
ok(/<th class="log-trigger">Trigger<\/th>/.test(page1), "trigger column is labeled");
// the forced row is identifiable by its distinctive 42ms duration
const manualRow = [...page1.matchAll(/<tr class="log-(?:ok|fail)">[\s\S]*?<\/tr>/g)]
  .map((m) => m[0])
  .find((r) => /<td class="log-dur">42ms<\/td>/.test(r)) ?? "";
ok(/<td class="log-trigger">manual<\/td>/.test(manualRow), "forced refresh is labeled manual", manualRow.slice(0, 200));
ok(/<td class="log-trigger">cron<\/td>/.test(page1), "sweep refreshes are labeled cron");
// Every entry also emits a narrow-screen detail row (hidden by CSS on
// wide screens) carrying trigger, duration and the message.
const detailRows = (page1.match(/<tr class="log-detail-row/g) ?? []).length;
ok(detailRows === countRows(page1), "one detail row per entry", `${detailRows} details vs ${countRows(page1)} entries`);
ok(/<tr class="log-detail-row[^"]*"><td colspan="5">.*?<span class="fold-only">manual/.test(page1), "detail row folds the trigger for narrow screens");
ok(/<span class="detail-msg">upstream 503 from example.test<\/span><\/td><\/tr>/.test(page1), "detail row carries the error message");
// storage stats: 153 seeded refresh rows (150 + 3), spanning ~2.5h
ok(/154 refresh entries stored,/.test(page1), "stats report how much history is stored", /(\d[\d,]*) refresh entr[^<]*/.exec(page1)?.[0]);
ok(/spanning under a day/.test(page1), "stats report the span in days");
ok(/kept 7 days/.test(page1), "stats name the retention window");
ok(/<th class="log-time">Time \(UTC\)<\/th>/.test(page1), "table has labeled column headers");
ok(
  ["log-time", "log-status", "log-widget", "log-trigger", "log-dur"].every((c) =>
    new RegExp(`<th class="${c}">`).test(page1),
  ),
  "all five column headers present (message folds into its own row, not a column)",
);
ok(countRows(page1) === 100, "first page holds one page of entries", `got ${countRows(page1)}`);
ok(/<th class="log-time">Time \(UTC\)<\/th>/.test(page1), "headers survive the extra column");
ok(/older →|older →/.test(page1), "first page offers an older link");
ok(!/← newest|← newest/.test(page1), "first page has no newest link");

const olderMatch = /href="([^"]*before=\d+[^"]*)"/.exec(page1);
ok(Boolean(olderMatch), "older link carries a before cursor");
const page2 = await get(olderMatch[1].replace(/&amp;/g, "&"));
ok(countRows(page1) + countRows(page2) === 156, "both pages together hold every entry", `got ${countRows(page1) + countRows(page2)}`);
ok(/← newest|← newest/.test(page2), "older page offers a way back to newest");
// Keyset correctness: no entry repeats across the two pages.
const times = (html) => (html.match(/<td class="log-time">([^<]+)</g) ?? []).map((s) => s.slice(24));
const overlap = times(page1).filter((t) => times(page2).includes(t));
ok(overlap.length === 0, "pages do not overlap", `${overlap.length} repeated`);

const fails = await get("/settings/log?fail=1");
ok(countRows(fails) === 4, "failures filter shows only failures (3 fetches + 1 error message)", `got ${countRows(fails)}`);
ok(/upstream 503 from example.test/.test(fails), "failure rows carry the error text");

const oneWidget = await get(`/settings/log?widget=${ids[1]}`);
ok(countRows(oneWidget) === 5, "widget filter narrows to that widget (3 fetches + 2 messages)", `got ${countRows(oneWidget)}`);
ok(/<option value="">All widgets<\/option>/.test(oneWidget), "filter offers an all-widgets option");
// the picker lists only widgets that can log (static cards never do),
// so drive the preselect check from an id the picker actually offers
const pickable = /<option value="(w_[0-9a-f]+)"/.exec(page1)?.[1] ?? "";
ok(Boolean(pickable), "picker lists loggable widgets");
const picked = await get(`/settings/log?widget=${pickable}`);
ok(new RegExp(`<option value="${pickable}" selected>`).test(picked), "the active widget is preselected in the picker");
ok(!/back to settings/.test(oneWidget), "no redundant back-to-settings link");
ok(!/action="\/auth\/logout"/.test(oneWidget), "no logout button on the read-only log");

const combined = await get(`/settings/log?widget=${ids[0]}&fail=1`);
ok(countRows(combined) === 0, "widget + failures filters compose", `got ${countRows(combined)}`);

// Pushed messages ride the same timeline, labeled as pushes.
const msgs = await get(`/settings/log?widget=${ids[1]}`);
ok(/disk almost full/.test(msgs), "pushed messages appear in the log");
ok(/<td class="log-trigger">push<\/td>/.test(msgs), "pushed entries are labeled push");
ok(/error: disk almost full/.test(msgs), "error-level messages carry their level");

// Stats describe the same slice the table shows.
const statsAll = /([\d,]+) refresh entries stored,/.exec(page1)?.[1];
const filteredPage = await get(`/settings/log?widget=${ids[1]}`);
const statsOne = /([\d,]+) refresh entries stored for this widget,/.exec(filteredPage)?.[1];
ok(statsAll === "154", "unfiltered stats count every entry", String(statsAll));
ok(statsOne === "3", "filtered stats count only that widget's entries", String(statsOne));

// Retention is an instance setting that survives a round trip.
ok(/kept 7 days/.test(page1), "default retention is reported");
const settingsForCsrf = await get("/settings");
ok(/action="\/settings\/log\/retention"/.test(settingsForCsrf), "retention control lives on the settings page");
ok(!/action="\/settings\/log\/retention"/.test(page1), "the log page carries no retention form");
const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(settingsForCsrf)?.[1] ?? "";
const setRes = await fetchRetry(`${BASE}/settings/log/retention`, {
  method: "POST",
  headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf, days: "30" }).toString(),
  redirect: "manual",
});
ok(setRes.status === 303, "saving retention redirects back", `got ${setRes.status}`);
ok(/kept 30 days/.test(await get("/settings/log")), "the new retention window is shown");
const badCsrf = await fetchRetry(`${BASE}/settings/log/retention`, {
  method: "POST",
  headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf: "nope", days: "1" }).toString(),
  redirect: "manual",
});
ok(badCsrf.status === 403, "retention save is CSRF-guarded", `got ${badCsrf.status}`);
ok(/kept 30 days/.test(await get("/settings/log")), "a rejected save changes nothing");

// The settings hub offers jump links to its sections.
const settings = await get("/settings");
ok(/class="settings-nav"/.test(settings), "settings has a subnav");
// logout leads the content area, above the first section
const logoutAt = settings.indexOf('action="/auth/logout"');
const navAt = settings.indexOf('class="settings-nav"');
const firstSection = settings.indexOf('id="passkeys"');
ok(logoutAt > -1 && logoutAt < navAt && navAt < firstSection, "logout sits at the top of the settings content", `${logoutAt}/${navAt}/${firstSection}`);
ok(/href="#push-tokens"/.test(settings) && /id="push-tokens"/.test(settings), "subnav links resolve to real sections");

// The dashboard's freshness stamp links into this widget's history. The
// stamp only exists once a widget HAS data, so seed cached payloads for
// every widget in the document (static ones simply never read theirs).
const allIds = [...doc.matchAll(/"id":\s*"(w_[0-9a-f]+)"/g)].map((m) => m[1]);
sql(
  allIds
    .map(
      (id) =>
        `INSERT INTO refresh_state (instance_id, payload, fetched_at, updated_at) VALUES ('${id}', '{"fetchedAt":${now},"data":{}}', ${now}, ${now}) ON CONFLICT(instance_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at;`,
    )
    .join(""),
);
const dash = await (await fetchRetry(`${BASE}/`, { headers: { cookie } })).text();
ok(/class="w-log" href="\/settings\/log\?widget=w_/.test(dash), "authed dashboard links its stamps to the log");
const anonDash = await (await fetchRetry(`${BASE}/p/showcase`)).text().catch(() => "");
ok(!/w-log/.test(anonDash), "anonymous pages carry no log links");

console.log(failures === 0 ? "\nall log checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
