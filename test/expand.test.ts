import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDoc } from "../src/config";
import { renderMain } from "../src/render";
import { CSS } from "../src/styles";
import { COMMON_FIELDS } from "../src/widgets/def";
import { EDITOR_JS } from "../src/editor/client";

const fakeEnv = () =>
  ({
    DB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: {} }) }),
      }),
    },
  }) as never;

const docWith = (widgets: object[]) => ({
  pages: [{ name: "Home", rows: [{ columns: [{ width: "full", widgets }] }] }],
});

test("expand: stored only when set, from YAML true or the editor's 'yes'", () => {
  const { runtime } = validateDoc(
    docWith([
      { id: "w_1", name: "a", type: "note", title: "A", text: "x", expand: true },
      { id: "w_2", name: "b", type: "note", title: "B", text: "x", expand: "yes" },
      { id: "w_3", name: "c", type: "note", title: "C", text: "x" },
      { id: "w_4", name: "d", type: "note", title: "D", text: "x", expand: false },
    ]),
  );
  assert.deepEqual(runtime.widgets.map((w) => w.expand), [true, true, undefined, undefined]);
});

test("expand: marked cards carry the class, unmarked ones do not", async () => {
  const { runtime } = validateDoc(
    docWith([
      { id: "w_1", name: "grows", type: "note", title: "Grows", text: "x", expand: true },
      { id: "w_2", name: "stays", type: "note", title: "Stays", text: "x" },
    ]),
  );
  const out = (await renderMain(fakeEnv(), runtime, 0)).value;
  assert.match(out, /class="widget note expand" data-widget="grows"/);
  assert.match(out, /class="widget note" data-widget="stays"/);
});

// The rule the layout hangs on: leftover height goes ONLY to marked cards,
// on scrolling pages and fit-to-screen pages alike.
test("expand: only the marked card takes leftover height, in both layouts", () => {
  assert.match(CSS, /main:not\(\.fit-screen\) \.row-fill \.col > section\.widget\.expand \{ flex: 1 1 auto; \}/);
  assert.ok(
    !/main:not\(\.fit-screen\) \.row-fill \.col > section\.widget \{ flex: 1 1 auto; \}/.test(CSS),
    "the old rule stretched every card in a filling row",
  );
  assert.match(CSS, /main\.fit-screen \.col > section\.widget\.expand \{ flex: 1 1 auto; \}/);
  assert.match(CSS, /main\.fit-screen \.col > section\.widget \{\s*flex: 0 1 auto;/);
});

test("expand: offered on every widget type, in the main form", () => {
  const field = COMMON_FIELDS.find((f) => f.key === "expand");
  assert.ok(field, "expand is a shared field, not a per-type one");
  assert.equal(field!.kind, "checkbox");
  // layout is a normal thing to reach for - not buried under Advanced
  assert.notEqual(field!.advanced, true);
  // On for newly added cards. Existing cards are unaffected: the prefill
  // is applied by the gallery when it CONSTRUCTS a widget, and validation
  // still stores expand only when the document says so.
  assert.equal(field!.prefill, "yes");
});

// The gallery's prefill loop writes booleans for checkboxes, because the
// inspector's box renders from `=== true`. A raw "yes" string would read
// as expanded in config while showing an unchecked box in the editor.
test("expand: the checkbox prefill lands as a boolean, not a string", () => {
  assert.match(EDITOR_JS, /fd\.kind === "checkbox" && fd\.prefill\) w\[fd\.key\] = true;/);
  assert.match(EDITOR_JS, /box\.checked = w\[desc\.key\] === true;/);
});

// Four card shells render sections - pull, static, log, heartbeat - and
// the pull one built its class string separately, so it silently dropped
// the flag while the other three carried it. Cover every shell.
test("expand: reaches pull, static, and push cards alike", async () => {
  const { runtime } = validateDoc({
    pages: [{ name: "Home", rows: [{ columns: [{ width: "full", widgets: [
      { id: "w_1", name: "feed", type: "rss", title: "Feed", urls: ["https://example.com/f.xml"], refresh_interval: "1h", expand: true },
      { id: "w_2", name: "noted", type: "note", title: "Note", text: "x", expand: true },
      { id: "w_3", name: "lines", type: "log", title: "Log", expand: true },
      { id: "w_4", name: "beat", type: "heartbeat", title: "Beat", expect_every: "1h", grace: "10m", expand: true },
    ] }] }] }],
  });
  const out = (await renderMain(fakeEnv(), runtime, 0)).value;
  for (const name of ["feed", "noted", "lines", "beat"]) {
    assert.match(out, new RegExp(`class="widget[^"]*expand[^"]*" data-widget="${name}"`), `${name} lost the flag`);
  }
});
