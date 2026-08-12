import { test } from "node:test";
import assert from "node:assert/strict";
import { placeholderDoc, isPlaceholderDoc, setupDoc } from "../src/setup";
import { validateDoc, enforceIdDiscipline } from "../src/config";

// Instance ids are server-owned: publishConfig assigns them before
// validation, so tests take the same route rather than hand-writing ids.
function published(candidate: unknown) {
  enforceIdDiscipline(candidate, new Set<string>());
  return validateDoc(candidate);
}

test("placeholder is a valid document and recognizes itself", () => {
  const { doc } = published(placeholderDoc());
  assert.equal(isPlaceholderDoc(doc), true);
  assert.equal(doc.pages.length, 1);
});

test("placeholder guard rejects anything a user could have edited", () => {
  const { doc: seeded } = published(setupDoc("Europe/Berlin", true));
  assert.equal(isPlaceholderDoc(seeded), false);
  const { doc: empty } = published(setupDoc("Europe/Berlin", false));
  assert.equal(isPlaceholderDoc(empty), false);
  // placeholder plus one added widget is no longer the placeholder
  const extended = JSON.parse(JSON.stringify(placeholderDoc())) as any;
  extended.pages[0].rows[0].columns[0].widgets.push({ name: "mine", type: "note", text: "hi" });
  assert.equal(isPlaceholderDoc(published(extended).doc), false);
});

test("setupDoc(empty) is one blank page carrying the timezone", () => {
  const { doc, runtime } = published(setupDoc("Asia/Tokyo", false));
  assert.equal(doc.timezone, "Asia/Tokyo");
  assert.equal(runtime.widgets.length, 0);
  assert.equal(runtime.pages.length, 1);
});

test("setupDoc(examples) stamps the zone and leads the world clock with it", () => {
  const { doc, runtime } = published(setupDoc("Europe/Berlin", true));
  assert.equal(doc.timezone, "Europe/Berlin");
  assert.ok(runtime.widgets.length > 5, "example dashboard has widgets");
  const clock = runtime.widgets.find((w) => w.type === "clock") as { clocks: { label: string; tz: string }[] };
  assert.equal(clock.clocks[0]!.tz, "Europe/Berlin");
  assert.equal(clock.clocks[0]!.label, "Berlin");
  assert.ok(clock.clocks.length <= 8);
  // the seed's own zones survive behind it
  assert.ok(clock.clocks.some((c) => c.tz === "America/New_York"));
});

test("setupDoc(examples) without a zone leaves the seed exactly as shipped", () => {
  const { doc } = published(setupDoc(undefined, true));
  assert.equal(doc.timezone, undefined);
  const seedClock = published(setupDoc(undefined, true)).runtime.widgets.find((w) => w.type === "clock") as {
    clocks: { tz: string }[];
  };
  assert.equal(seedClock.clocks[0]!.tz, "America/New_York");
});

test("a zone already in the seed's clock is not duplicated", () => {
  const { runtime } = published(setupDoc("America/New_York", true));
  const clock = runtime.widgets.find((w) => w.type === "clock") as { clocks: { tz: string }[] };
  assert.equal(clock.clocks.filter((c) => c.tz === "America/New_York").length, 1);
});

test("setupDoc(examples) with a place moves the weather card and sets units", () => {
  const { runtime } = published(
    setupDoc("Europe/Amsterdam", true, { latitude: 52.37, longitude: 4.89, label: "Amsterdam", unit: "C" }),
  );
  const w = runtime.widgets.find((x) => x.type === "weather") as {
    latitude: number; longitude: number; location?: string; unit: string;
  };
  assert.equal(w.latitude, 52.37);
  assert.equal(w.longitude, 4.89);
  assert.equal(w.location, "Amsterdam");
  assert.equal(w.unit, "C");
});

test("a place with no label drops the seed's location rather than mislabeling", () => {
  const { runtime } = published(setupDoc(undefined, true, { latitude: 52.37, longitude: 4.89, unit: "F" }));
  const w = runtime.widgets.find((x) => x.type === "weather") as { location?: string; unit: string };
  assert.equal(w.location, undefined);
  assert.equal(w.unit, "F");
});

test("no place leaves the seed's weather exactly as shipped", () => {
  const { runtime } = published(setupDoc("Europe/Berlin", true));
  const w = runtime.widgets.find((x) => x.type === "weather") as {
    latitude: number; location?: string; unit: string;
  };
  assert.equal(w.latitude, 37.77);
  assert.equal(w.location, "San Francisco");
  assert.equal(w.unit, "F"); // the widget's own default, untouched
});
