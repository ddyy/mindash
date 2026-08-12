import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchData, def as calDef } from "../src/widgets/calendar";
import { parseHelpers } from "../src/widgets/def";

function withIcs<T>(ics: string, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(ics, { status: 200, headers: { "content-type": "text/calendar" } })) as any;
  return fn().finally(() => { globalThis.fetch = orig; });
}
const parse = (raw: object) => (calDef as any).parse({ url: "https://x.example/c.ics", refresh_interval: "30m", ...raw }, "t", { id: "w_1", name: "c-1", title: "C" }, parseHelpers);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

test("ics: folding, TZID conversion, escapes, weekly BYDAY recurrence", async () => {
  const tomorrow = new Date(Date.now() + 86400000);
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", `DTSTART;VALUE=DATE:${ymd(tomorrow)}`, "SUMMARY:All day", " continues", "END:VEVENT",
    "BEGIN:VEVENT", `DTSTART;TZID=America/New_York:${ymd(tomorrow)}T090000`, "SUMMARY:NY\\, meeting", "LOCATION:Room 4", "END:VEVENT",
    "BEGIN:VEVENT", "DTSTART:20200106T120000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TH", "SUMMARY:Standup", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const data = await withIcs(ics, () => fetchData(parse({})));
  assert.ok(data.events.some((e) => e.allDay && e.summary.startsWith("All day")));
  const ny = data.events.find((e) => e.summary === "NY, meeting");
  assert.ok(ny && ny.location === "Room 4");
  // season-proof: assert the LOCAL hour in the event's zone is 09:00
  const nyHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(ny!.start);
  assert.equal(Number(nyHour), 9);
  assert.ok(data.events.filter((e) => e.summary === "Standup").length >= 2);
});

test("ics: EXDATE removes an occurrence", async () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART:20200106T120000Z",
    "RRULE:FREQ=DAILY",
    `EXDATE:${ymd(new Date(Date.now() + 86400000))}T120000Z`,
    "SUMMARY:Daily",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const data = await withIcs(ics, () => fetchData(parse({ days: 3 })));
  const tomorrowNoon = Date.parse(new Date(Date.now() + 86400000).toISOString().slice(0, 10) + "T12:00:00Z");
  assert.ok(!data.events.some((e) => e.start === tomorrowNoon));
  assert.ok(data.events.length >= 2);
});

test("ics: webcal normalizes, non-calendar body rejected", async () => {
  const cfg = parse({ url: "webcal://x.example/c.ics" });
  assert.equal(cfg.url, "https://x.example/c.ics");
  await assert.rejects(withIcs("<html>not ics</html>", () => fetchData(parse({}))), /iCalendar/);
});

test("ics: old DAILY rule with large finite COUNT reaches the window", async () => {
  // started ~3 years ago, daily, COUNT big enough to still be running
  const start = new Date(Date.now() - 1100 * 86400000);
  const stamp = start.toISOString().slice(0, 10).replace(/-/g, "") + "T090000Z";
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", `DTSTART:${stamp}`, "RRULE:FREQ=DAILY;COUNT=2000", "SUMMARY:Old daily", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const data = await withIcs(ics, () => fetchData(parse({})));
  assert.ok(data.events.filter((e) => e.summary === "Old daily").length >= 2);
});

test("ics: old DAILY rule whose COUNT exhausted before the window yields nothing", async () => {
  const start = new Date(Date.now() - 1100 * 86400000);
  const stamp = start.toISOString().slice(0, 10).replace(/-/g, "") + "T090000Z";
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", `DTSTART:${stamp}`, "RRULE:FREQ=DAILY;COUNT=30", "SUMMARY:Done daily", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const data = await withIcs(ics, () => fetchData(parse({})));
  assert.equal(data.events.filter((e) => e.summary === "Done daily").length, 0);
});

test("ics: unbounded MONTHLY rule older than five years still appears", async () => {
  const start = new Date(Date.now() - 6 * 365 * 86400000);
  const stamp = start.toISOString().slice(0, 10).replace(/-/g, "") + "T100000Z";
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", `DTSTART:${stamp}`, "RRULE:FREQ=MONTHLY", "SUMMARY:Old monthly", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const data = await withIcs(ics, () => fetchData(parse({ days: 45 })));
  assert.ok(data.events.some((e) => e.summary === "Old monthly"));
});

test("ics: unordered BYDAY consumes COUNT chronologically", async () => {
  // DTSTART is a Monday; BYDAY listed FR,MO. COUNT=1 must yield Monday.
  const monday = new Date(Date.now() + 86400000 * 14);
  while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
  const stamp = monday.toISOString().slice(0, 10).replace(/-/g, "") + "T120000Z";
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", `DTSTART:${stamp}`, "RRULE:FREQ=WEEKLY;BYDAY=FR,MO;COUNT=1", "SUMMARY:One shot", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const data = await withIcs(ics, () => fetchData(parse({ days: 30 })));
  const hits = data.events.filter((e) => e.summary === "One shot");
  assert.equal(hits.length, 1);
  assert.equal(new Date(hits[0]!.start).getUTCDay(), 1); // Monday, not Friday
});

test("ics: duplicate BYDAY entries do not double-count", async () => {
  const monday = new Date(Date.now() + 86400000 * 14);
  while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
  const stamp = monday.toISOString().slice(0, 10).replace(/-/g, "") + "T120000Z";
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", `DTSTART:${stamp}`, "RRULE:FREQ=WEEKLY;BYDAY=MO,MO,WE;COUNT=2", "SUMMARY:Deduped", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const data = await withIcs(ics, () => fetchData(parse({ days: 30 })));
  const days = data.events.filter((e) => e.summary === "Deduped").map((e) => new Date(e.start).getUTCDay()).sort();
  assert.deepEqual(days, [1, 3]); // Monday + Wednesday exactly
});
