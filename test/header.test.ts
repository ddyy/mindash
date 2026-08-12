import { test } from "node:test";
import assert from "node:assert/strict";
import { globalHeader } from "../src/header";

const SURFACES = ["dashboard", "edit", "settings"] as const;

// <a class="view"> / <span class="view active"> in document order
function pills(html: string): { tag: string; label: string; href?: string; active: boolean }[] {
  return [...html.matchAll(/<(a|span)([^>]*class="view[^"]*"[^>]*)>(?:<svg[\s\S]*?<\/svg>)?([A-Za-z]+)<\/\1>/g)].map(
    (m) => ({
      tag: m[1]!,
      label: m[3]!,
      href: /href="([^"]*)"/.exec(m[2]!)?.[1],
      active: /class="view active"/.test(m[2]!),
    }),
  );
}

test("header: the same three views, same order, on every surface", () => {
  for (const surface of SURFACES) {
    const labels = pills(globalHeader(surface).value).map((p) => p.label);
    assert.deepEqual(labels, ["Dashboard", "Edit", "Settings"], `wrong nav on ${surface}`);
  }
});

test("header: exactly one pill is active, and it is the current surface", () => {
  const expected = { dashboard: "Dashboard", edit: "Edit", settings: "Settings" };
  for (const surface of SURFACES) {
    const active = pills(globalHeader(surface).value).filter((p) => p.active);
    assert.equal(active.length, 1, `${surface} should mark exactly one view`);
    assert.equal(active[0]!.label, expected[surface]);
  }
});

// Re-entering the view you are already in would just reload it, so the
// active pill is a marker - EXCEPT in the editor, where Edit toggles back
// out to the dashboard (an unsaved draft is guarded by beforeunload).
test("header: the active pill is inert; the others are real links", () => {
  for (const surface of SURFACES) {
    for (const p of pills(globalHeader(surface).value)) {
      if (p.active && surface === "edit") continue; // covered below
      if (p.active) {
        assert.equal(p.tag, "span", `${surface}: active pill must not be a link`);
        assert.equal(p.href, undefined);
      } else {
        assert.equal(p.tag, "a", `${surface}: inactive pill must be a link`);
        assert.ok(p.href, `${surface}: ${p.label} needs an href`);
      }
    }
  }
});

test("header: Edit toggles out of the editor, to the same place Dashboard goes", () => {
  const inEditor = pills(globalHeader("edit", { dashHref: "/p/ops" }).value);
  const edit = inEditor.find((p) => p.label === "Edit")!;
  const dash = inEditor.find((p) => p.label === "Dashboard")!;
  assert.equal(edit.active, true, "Edit still marks where you are");
  assert.equal(edit.tag, "a", "…but it is a link out");
  assert.equal(edit.href, dash.href, "both exits lead to the page being edited");
  assert.equal(edit.href, "/p/ops");
  // elsewhere Edit still leads INTO the editor
  const fromDash = pills(globalHeader("dashboard").value).find((p) => p.label === "Edit")!;
  assert.equal(fromDash.href, "/settings/editor");
});

test("header: hrefs follow the surface; the editor keeps its dashboard hook", () => {
  const dash = pills(globalHeader("dashboard", { editHref: "/settings/editor#p=2" }).value);
  assert.equal(dash.find((p) => p.label === "Edit")!.href, "/settings/editor#p=2");

  const settings = pills(globalHeader("settings").value);
  assert.equal(settings.find((p) => p.label === "Dashboard")!.href, "/");

  // the editor client retargets this link at the page being edited
  assert.match(globalHeader("edit").value, /id="nav-dashboard"/);
});

test("header: public dashboard views show the brand alone", () => {
  const out = globalHeader("dashboard", { authed: false }).value;
  assert.equal(pills(out).length, 0);
  assert.ok(!out.includes("/settings"));
});
