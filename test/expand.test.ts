import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDoc } from "../src/config";
import { renderMain } from "../src/render";
import { CSS } from "../src/styles";
import { COMMON_FIELDS } from "../src/widgets/def";

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
  assert.match(CSS, /main\.fit-screen \.col > section\.widget\.expand \{ flex: 1 1 0; \}/);
  assert.match(CSS, /main\.fit-screen \.col > section\.widget \{\s*flex: 0 1 auto;/);
});

test("expand: offered on every widget type, as an advanced checkbox", () => {
  const field = COMMON_FIELDS.find((f) => f.key === "expand");
  assert.ok(field, "expand is a shared field, not a per-type one");
  assert.equal(field!.kind, "checkbox");
  assert.equal(field!.advanced, true);
});
