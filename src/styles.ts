import { WIDGET_CSS } from "./widgets";

// Global stylesheet. Per-widget rules live in sibling .css files next to
// each widget def (src/widgets/*.css) and are appended below; shared
// classes (ul.feed, ul.kv, .meta, .empty, .pending, the mcp text/markdown
// classes also used by note) plus the non-manifest heartbeat rules stay
// here.
export const CSS = /* css */ `
:root {
  --bg-scheme: hsl(220 15% 10%);
  --card-scheme: hsl(220 15% 14%);
  --border-scheme: hsl(220 12% 22%);
  --text-scheme: hsl(220 15% 88%);
  --muted-scheme: hsl(220 10% 62%);
  --accent-fallback: hsl(210 90% 60%);
  --positive-fallback: hsl(140 60% 45%);
  --negative-fallback: hsl(0 70% 55%);
  /* theme overrides arrive as *-hsl vars injected by the renderer;
     absent, the scheme defaults above apply */
  --bg: var(--bg-override, var(--bg-scheme));
  --card-solid: var(--card-override, var(--card-scheme));
  --card: color-mix(in srgb, var(--card-solid) var(--card-opacity, 100%), transparent);
  --border: var(--border-override, var(--border-scheme));
  --text: var(--text-override, var(--text-scheme));
  --muted: var(--muted-override, var(--muted-scheme));
  --accent: var(--accent-override, var(--accent-fallback));
  --positive: var(--positive-override, var(--positive-fallback));
  --negative: var(--negative-override, var(--negative-fallback));
  --radius: 10px;
  --radius-sm: 6px;
  /* One size for every pill-shaped control - nav links, page tabs, the
     kiosk button, buttons proper - so a row of them lines up whatever
     surface it is on. Changing a chip's size means changing it here. */
  --chip-font: 0.8rem;
  --chip-pad: 0.3rem 0.75rem;
  --chip-line: 1.3;
  --font: ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-size: 15px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg-scheme: hsl(220 25% 96%);
    --card-scheme: hsl(0 0% 100%);
    --border-scheme: hsl(220 15% 86%);
    --text-scheme: hsl(220 25% 16%);
    --muted-scheme: hsl(220 10% 42%);
    /* light surfaces need darker brand/status colors to clear 4.5:1
       (accent 60% on white is 2.97) - theme overrides still win */
    --accent-fallback: hsl(210 90% 44%);
    --positive-fallback: hsl(140 60% 32%);
    --negative-fallback: hsl(0 70% 44%);
  }
}
/* Light surfaces only: a white card on a near-white page separates by a
   1px border alone, which reads as a floating block of text rather than
   a card. Dark mode already separates by luminance, and a shadow there
   is invisible anyway. */
@media (prefers-color-scheme: light) {
  section.widget { box-shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 1px 1px rgb(0 0 0 / 0.03); }
}
* { box-sizing: border-box; }
html { font-size: calc(var(--font-size, 15px) * 16 / 15); }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: var(--font-size)/1.45 var(--font);
}
header {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  padding: 1rem 1.25rem 0.25rem;
}
header h1 { font-size: 1.05rem; margin: 0; letter-spacing: 0.02em; display: flex; align-items: center; gap: 0.45rem; }
header h1 a.brand { color: inherit; text-decoration: none; display: flex; align-items: center; gap: 0.45rem; }
header h1 a.brand:hover { color: var(--accent); }
header h1 img.logo { height: 1.5em; width: auto; border-radius: 4px; }
header .updated { color: var(--muted); font-size: 0.8rem; }
nav.pages { display: flex; gap: 0.3rem; }
/* every tab is a same-sized chip - inactive gets a quiet border so the
   active pill doesn't read as misaligned against borderless neighbors */
nav.pages a {
  color: var(--muted); text-decoration: none; font-size: var(--chip-font);
  padding: var(--chip-pad); border-radius: var(--radius-sm); line-height: var(--chip-line);
  border: 1px solid var(--border);
}
nav.pages a:hover { color: var(--text); border-color: var(--muted); }
nav.pages a.active { color: var(--accent); background: var(--card); border-color: var(--accent); }
header .updated a { color: var(--muted); }
/* Kiosk is a rare, deliberate act - once for a wall display, then never
   again - so the glyph never becomes familiar through repetition and
   carries a label wherever there is room for one. The tooltip and
   aria-label stay either way; the icon alone survives on narrow screens
   (see the mobile block), where this row is already tight. */
a.fs-btn {
  display: inline-flex; align-items: center; gap: 0.35rem;
  text-decoration: none; font-size: var(--chip-font); line-height: var(--chip-line);
  color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: var(--chip-pad); margin-left: 0.35rem; vertical-align: middle;
  transition: color 0.12s, border-color 0.12s;
}
/* the glyph reads at its own size without its line box driving the
   chip's height past the page tabs' */
a.fs-btn .fs-icon { font-size: 1.05rem; line-height: 1; }
a.fs-btn:hover { color: var(--accent); border-color: var(--accent); }
/* global row: brand + view links, identical on every surface. Baseline
   alignment keeps the brand text and link text on one optical line
   despite different font sizes; the logo image centers within the h1's
   own flex row, unaffected. */
header.global-nav { align-items: baseline; padding: 0.85rem 1.25rem 0.35rem; }
.global-nav nav.views { margin-left: auto; display: flex; gap: 0.15rem; }
/* pills are <a> except the current view, which renders as an inert
   <span> - same box either way, so the row never shifts */
.global-nav nav.views .view {
  color: var(--muted); text-decoration: none; font-size: var(--chip-font);
  padding: var(--chip-pad); border-radius: var(--radius-sm); line-height: var(--chip-line);
  /* transparent, but present: without it these pills are 2px shorter
     than every bordered chip and the row stops matching */
  border: 1px solid transparent;
  display: inline-flex; align-items: center; gap: 0.35rem;
}
.global-nav nav.views .view svg { width: 12px; height: 12px; flex: none; }
.global-nav nav.views a.view:hover { color: var(--text); }
.global-nav nav.views .view.active { color: var(--accent); background: var(--card); cursor: default; }
/* the one active pill that IS a link (Edit, which toggles back out) */
.global-nav nav.views a.view.active { cursor: pointer; }
/* secondary row: surface-specific tools (dashboard page tabs, kiosk) */
/* tabs are visible chips, so their LEFT EDGE aligns with the brand and
   content line (1.25rem) */
/* the tab row is its own band, not a second line of the title: without
   top padding the chips crowd the brand they sit under */
nav.subnav { display: flex; align-items: center; gap: 0.3rem; padding: 0.5rem 1.1rem 0.55rem 1.25rem; }
/* owner-only public marker inside a page tab */
nav.pages .pub-badge { margin-left: 0.3rem; font-size: 0.8em; vertical-align: 1px; }
nav.subnav .fs-btn { margin-left: auto; }
header .logout { margin-left: auto; }
header .updated:last-child { margin-left: auto; }
/* mobile: controls stay visible on line one; page tabs become a
   full-width swipeable row beneath */
@media (max-width: 760px) {
  header { flex-wrap: wrap; row-gap: 0.35rem; }
  nav.pages {
    overflow-x: auto;
    scrollbar-width: none; -webkit-overflow-scrolling: touch;
  }
  nav.pages::-webkit-scrollbar { display: none; }
  nav.pages a { white-space: nowrap; padding: 0.3rem 0.7rem; min-height: 24px; }
  .global-nav nav.views .view { padding: 0.3rem 0.7rem; }
  /* matches the tabs' touch sizing in this row too */
  nav.subnav .fs-btn { flex: none; padding: 0.3rem 0.7rem; min-height: 24px; }
  /* the tabs already scroll sideways here; the icon carries it alone */
  a.fs-btn .fs-label { display: none; }
  header .updated { margin-left: auto; }
  /* touch targets: stacked feed links (title + comments) need >=24px
     boxes with breathing room between them */
  ul.feed li { padding: 0.5rem 0; }
  ul.feed a { display: inline-block; padding: 0.15rem 0; }
  /* clear daylight between the stacked title and comments targets -
     adjacent tap boxes 1-2px apart fail stricter spacing checks even
     when each is >=24px tall */
  ul.feed .meta { margin-top: 0.45rem; }
  .meta a.quiet { display: inline-block; padding: 0.4rem 0.3rem; margin: 0 -0.3rem -0.15rem; }
}
/* ---- input system: one base for text fields, shared by every page ---- */
/* Everything that is a TEXT-ENTRY control, by exclusion rather than by
   listing types: an allowlist silently drops the next type someone uses
   (url fields shipped unstyled that way), while the handful of controls
   that must keep native chrome - toggles, pickers, buttons - is a closed
   set that does not grow. */
input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="hidden"]):not([type="color"]):not([type="range"]),
select, textarea {
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 0.35rem 0.55rem; font: inherit; font-size: 0.85rem;
  width: 100%; box-sizing: border-box;
  transition: border-color 0.12s;
}
/* Placeholder copy is guidance rather than entered data. Pin its color
   instead of accepting browser-specific opacity and contrast. */
input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }
/* toggles keep native chrome, but not native BLUE: without this a
   checked box is the browser's accent next to the theme's, which reads
   as two different blues on the same form */
input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }
input:hover, select:hover, textarea:hover { border-color: var(--muted); }
input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent);
}
/* keyboard focus is one treatment everywhere: inputs and buttons had
   the accent ring, links fell back to whatever the browser drew */
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
input.invalid { border-color: hsl(0 70% 55%); }
textarea { font-family: ui-monospace, monospace; font-size: 13px; }
label { display: block; margin: 0.55rem 0 0.15rem; font-size: 0.78rem; color: var(--muted); }

/* ---- button system: one base + variants, shared by every page ---- */
button {
  background: var(--card); color: var(--muted);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: var(--chip-pad); cursor: pointer; font: inherit; font-size: var(--chip-font);
  line-height: var(--chip-line); transition: color 0.12s, background 0.12s, border-color 0.12s;
}
button:hover { color: var(--text); border-color: var(--muted); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button:disabled { opacity: 0.45; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
button.primary:hover { filter: brightness(1.12); color: var(--bg); }
button.btn-danger { color: hsl(0 70% 62%); border-color: hsl(0 45% 38%); }
button.btn-danger:hover { background: hsl(0 70% 52%); border-color: hsl(0 70% 52%); color: #fff; }
button.btn-accent { color: var(--accent); border-color: var(--accent); }
button.btn-accent:hover { background: var(--accent); color: var(--bg); }
button.btn-ghost { background: none; border-color: transparent; padding: 0 0.25rem; }
button.btn-ghost:hover { color: var(--accent); border-color: transparent; }
main {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 1.25rem 1.25rem;
  width: 100%;
}
.row { display: grid; grid-template-columns: repeat(12, 1fr); gap: 1rem; }
/* fit-screen applies only while the multi-column grid is active - on
   stacked (mobile) layouts every card would be crushed into one viewport,
   so phones scroll normally instead */
@media (min-width: 761px) {
  /* fit-screen pages: viewport-height layout, rows share space, columns
     scroll internally instead of the page */
  body:has(> main.fit-screen) { height: 100dvh; overflow: hidden; display: flex; flex-direction: column; }
  main.fit-screen { flex: 1; min-height: 0; }
  /* A column's leftover height goes to the cards marked "expand", and to
   nothing else. Every card stretching a little was the old behaviour: it
   inflated three-line clocks to match a feed beside them. Unmarked cards
   now keep their natural height, and a column with nothing marked simply
   ends where its content ends. */
main:not(.fit-screen) .row-fill .col > section.widget.expand { flex: 1 1 auto; }
main.fit-screen .row { flex: 1 1 0; min-height: 0; grid-template-rows: minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); } /* inline flex-grow carries row height weights */
  main.fit-screen .row:has(> .row-title) { grid-template-rows: auto minmax(0, 1fr); }
  main.fit-screen .col { overflow: hidden; min-height: 0; }
  /* Fit pages: a card is its own height and scrolls internally if that
     overflows; the marked one absorbs whatever the viewport leaves. */
  main.fit-screen .col > section.widget {
    flex: 0 1 auto; min-height: 0; overflow-y: auto;
    /* The gutter is RESERVED (no reflow when content grows past the
       card) but not PAINTED: a thumb drawn on every card carved a
       permanent groove down the right edge, most visible on light
       surfaces. It appears when the pointer is over the card. */
    scrollbar-width: thin; scrollbar-color: transparent transparent;
    scrollbar-gutter: stable;
  }
  main.fit-screen .col > section.widget:hover,
  main.fit-screen .col > section.widget:focus-within {
    scrollbar-color: var(--border) transparent;
  }
/* the card scrolls; its content must not be flex-shrunk to fit - that
   crushes pre boxes and lists into slivers */
/* basis AUTO, not 0: the marked card grows into the leftover, but when a
   column is tighter than its content it shrinks from its own size like
   its neighbours. With basis 0 it started from nothing and collapsed to
   a sliver while the unmarked cards kept their full height. */
main.fit-screen .col > section.widget.expand { flex: 1 1 auto; }
main.fit-screen .col > section.widget > * { flex-shrink: 0; }
  /* title stays pinned while the card scrolls; negative margins + padding
     extend its background over the card's padding so content slides under
     it cleanly */
  main.fit-screen .col > section.widget > h2 {
    /* negative top matches the card padding: the title sticks flush with
       the card's border instead of at the content box, so no strip of
       scrolled content peeks above it */
    position: sticky; top: -0.85rem; z-index: 1; background: var(--card);
    margin: -0.85rem -1rem 0.6rem; padding: 0.85rem 1rem 0.35rem;
  }
}
.row-title { grid-column: 1 / -1; margin: 0.4rem 0 -0.4rem; font-size: 0.85rem;
  font-weight: 650; letter-spacing: 0.03em; }
.col-title { margin: 0; font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--muted); }
.col { display: flex; flex-direction: column; gap: 1rem; min-width: 0; grid-column: span 12; }
@media (min-width: 761px) {
  .col.span-2 { grid-column: span 2; }
  .col.span-3 { grid-column: span 3; }
  .col.span-4 { grid-column: span 4; }
  .col.span-6 { grid-column: span 6; }
  .col.span-8 { grid-column: span 8; }
  .col.span-9 { grid-column: span 9; }
  .col.span-10 { grid-column: span 10; }
  .col.span-12 { grid-column: span 12; }
}
section.widget {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
  display: flex;
  flex-direction: column;
}
/* screens whose entire content is one prompt card (sign in, first-run
   setup): centered in the viewport instead of pinned to the top-left */
/* fill the viewport BELOW the header so "centered" means centered in the
   space actually left over, not in the whole page box */
main.center-prompt { justify-content: center; align-items: center; min-height: calc(100vh - 9rem); }
main.center-prompt > section { width: 100%; max-width: 28rem; }
/* empty-page prompt: a dashed card so it reads as a placeholder rather
   than content, centered in the space the widgets would have filled */
main.page-empty { flex: 1; justify-content: center; align-items: center; min-height: calc(100vh - 11rem); }
section.widget.empty-page {
  border-style: dashed; text-align: center;
  align-items: center; justify-content: center;
  width: 100%; max-width: 44rem; min-height: 18rem; padding: 2.5rem 2rem;
}
section.widget.empty-page h2 { margin-bottom: 0.5rem; font-size: 0.95rem; }
section.widget.empty-page p { margin: 0.3rem 0; }
/* without an explicit color this falls through to browser defaults -
   blue, then PURPLE once visited */
section.widget.empty-page p a { color: var(--accent); font-size: 1.05rem; text-underline-offset: 3px; }
/* the trailing "updated N ago" footnote: anchored to the card's bottom
   (margin-top auto), pinned visible while fit-mode cards scroll (sticky),
   and fainter than regular meta text. Scoped to the stamp itself - when
   this matched "any last .meta", a prose note that happened to end a
   card (the heartbeat's sample-data line) got yanked ragged-right. */
section.widget > span.card-stamp {
  align-self: flex-end;
  margin: auto 0 0 auto;
  padding-top: 0.4rem;
  font-size: 0.68rem;
  /* no opacity: it composites text through to the background and sinks
     contrast below 4.5:1 (0.55 over white measured 2.27). The smaller
     size alone carries the "footnote" register. */
}
/* Per-widget force refresh: lives inside the "updated Xm ago" stamp,
   invisible until the card is hovered (or the button focused) so the
   calm glanceable surface stays calm. Server renders it only for owner
   sessions - public pages carry no control at all. */
.w-refresh {
  background: none; border: 0; margin: 0; padding: 0 0.35rem 0 0;
  color: var(--muted); font: inherit; font-size: 0.85rem; line-height: 1;
  cursor: pointer; opacity: 0; transition: opacity 0.15s;
  display: inline-block;
}
section.widget:hover .w-refresh, .w-refresh:focus-visible { opacity: 1; }
.w-refresh:hover { color: var(--accent); }
.w-refresh.spinning { opacity: 1; animation: w-refresh-spin 0.8s linear infinite; }
@keyframes w-refresh-spin { to { transform: rotate(360deg); } }
.page-desc { margin: 0; color: var(--muted); font-size: 0.85rem; }
.widget-desc { margin: -0.35rem 0 0.6rem; color: var(--muted); font-size: 0.78rem; }
section.widget > h2 {
  margin: 0 0 0.6rem;
  font-size: var(--title-size, 0.78rem);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent);
}
ul.feed { list-style: none; margin: 0; padding: 0; }
ul.feed li { padding: 0.35rem 0; border-top: 1px solid var(--border); }
ul.feed li:first-child { border-top: none; }
ul.feed a { color: var(--text); text-decoration: none; }
ul.feed a:hover { color: var(--accent); }
/* settings access sections (passkeys, MCP grants/tokens): roomy rows with
   the action button pinned right */
.access { margin-bottom: 1.2rem; } /* settings main is block flow, not the dashboard's gapped flex */
.access ul.feed { margin-bottom: 0.8rem; }
.access ul.feed li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.7rem; padding: 0.6rem 0; }
.access ul.feed li .meta { display: inline; margin: 0; flex: 1; min-width: 12rem; }
.access ul.feed li form { margin: 0; margin-left: auto; }
.access ul.feed li > button[disabled] { margin-left: auto; }
.access > p.meta { margin: 1.1rem 0 0.3rem; font-weight: 600; letter-spacing: 0.02em; }
.access h2 { margin-bottom: 0.4rem; }
/* settings forms: ONE field/action pattern everywhere. Controls inherit
   the global input sizing and take their width from the field, so no
   form carries inline widths of its own. */
.form-grid { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.9rem; max-width: 26rem; }
.form-grid .field { display: flex; flex-direction: column; gap: 0.2rem; }
/* Size rule: TEXT INPUTS fill the form column, so every form has one
   clean right edge. Only SELECTS shrink, to roughly their longest
   option - a picker reading "7 days" spanning the full column reads as
   a broken text field. */
.form-grid .field-sm { max-width: 14rem; }
.form-grid .field-xs { max-width: 9.5rem; }
/* per-field note: sits under its control, for rules the label cannot
   carry (what gets normalized, what the value must include) */
.form-grid .hint { font-size: 0.75rem; color: var(--muted); line-height: 1.35; }
.form-grid .hint code { font-size: 0.95em; }
.form-grid label, .form-grid .field-label { display: block; margin: 0; font-size: 0.78rem; color: var(--muted); }
.form-grid .checks { display: flex; flex-wrap: wrap; gap: 0.2rem 1.1rem; padding-top: 0.1rem; }
.form-grid .checks label.check {
  display: inline-flex; align-items: center; gap: 0.4rem;
  color: var(--text); font-size: 0.85rem;
}
.form-grid .checks input[type="checkbox"] { width: auto; margin: 0; }
.form-actions { display: flex; gap: 0.5rem; margin-top: 0.1rem; }
/* the freshness stamp doubles as the link into this widget's history:
   styled as body text so it reads as a timestamp, not a call to action */
.w-log { color: inherit; text-decoration: none; }
.w-log:hover { color: var(--accent); text-decoration: underline; }
/* /settings/log: dense per-attempt table */
/* login's second path (enroll with a token) is a <details>: without a
   marker of its own it read as inert muted text beside a real button */
summary.disclosure {
  cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 0.4rem;
  color: var(--muted); font-size: 0.8rem; padding: 0.3rem 0; transition: color 0.12s;
}
summary.disclosure::-webkit-details-marker { display: none; }
summary.disclosure::before {
  content: "\u25B8"; display: inline-block; transition: transform 0.12s; font-size: 0.9em;
}
details[open] > summary.disclosure::before { transform: rotate(90deg); }
summary.disclosure:hover { color: var(--accent); }
.log-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.log-table th {
  text-align: left; padding: 0 0.55rem 0.35rem 0; border-bottom: 1px solid var(--border);
  color: var(--muted); font-size: 0.72rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap;
}
.log-table td { padding: 0.3rem 0.55rem 0.3rem 0; vertical-align: top; border-bottom: 1px solid var(--border); }
/* Detail is a column on wide screens and a nested row underneath on
   narrow ones - a sixth nowrap column would crush the message that is
   the only reason to open the log on a phone. Exactly one copy is in
   the a11y tree at a time (the other is display:none). */
/* At every width the MESSAGE lives on its own nested line: it is the
   longest, least predictable field, so a column either crushes it or
   stretches the table. Wide screens show that line only when there is a
   message; narrow ones show the row always, because trigger and duration
   fold into it there too. */
.log-detail-row { display: none; }
.log-detail-row.has-detail { display: table-row; }
.log-detail-row td {
  padding: 0 0 0.4rem 0; color: var(--muted); font-size: 0.78rem;
  border-bottom: 1px solid var(--border); word-break: break-word;
}
.detail-msg { display: block; }
.fold-only { display: none; } /* trigger + duration have their own columns here */
/* an entry and its detail read as one row: the rule sits on the pair's end */
.log-table tbody tr:has(+ .log-detail-row.has-detail) > td { border-bottom: 0; }
@media (max-width: 640px) {
  .log-table .log-trigger, .log-table .log-dur { display: none; }
  .log-detail-row { display: table-row; }
  .fold-only { display: block; }
  /* every entry now ends in a detail row, so none of the top rows rule */
  .log-table tbody tr:not(.log-detail-row) > td { border-bottom: 0; }
}
.log-nav { display: flex; gap: 1.2rem; margin-top: 0.9rem; font-size: 0.85rem; }
/* settings hub: jump links over a page that has grown to six sections.
   scroll-margin keeps a jumped-to heading clear of the sticky header. */
.settings-nav { display: flex; flex-wrap: wrap; gap: 0.4rem 0.9rem; margin: 0 0 1.2rem; font-size: 0.85rem; }
.settings-nav a { color: var(--muted); text-decoration: none; }
.settings-nav a:hover { color: var(--accent); text-decoration: underline; }
section.access[id] { scroll-margin-top: 1rem; }
/* the instance address, sized to be read and copied rather than skimmed */
.url-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin: 0.2rem 0 0.9rem; }
.url-row code {
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 0.3rem 0.5rem; font-family: ui-monospace, monospace; font-size: 0.85rem;
  overflow-wrap: anywhere; user-select: all;
}
/* label left, steps right - baseline keeps the browser name level with
   the first line of its instructions rather than floating mid-block */
#browser-home .feed li { padding: 0.5rem 0; align-items: baseline; }
#browser-home .feed .meta { display: block; margin-top: 0.15rem; }
/* account action sits at the top of the settings content, out of the way
   of the section flow but reachable without scrolling the whole page */
.logout-top { display: flex; justify-content: flex-end; margin: 0 0 0.35rem; }
.log-stats { margin-top: -0.35rem; font-size: 0.78rem; }
.log-filter { display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0 0.2rem; flex-wrap: wrap; }
.log-filter select { max-width: 22rem; }
/* the label owns the row spacing; the box keeps its own size (the global
   input rule stretches controls to full width) */
.log-failonly { display: inline-flex; align-items: center; gap: 0.35rem; margin: 0; white-space: nowrap; }
.log-failonly input { width: auto; }
.log-table .log-time { white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }
/* the exact stamp answers "which run"; the relative one answers "how long
   ago" without the reader doing UTC arithmetic - so both, stacked */
.log-table .log-ago { display: block; font-size: 0.72rem; opacity: 0.75; }
.log-table .log-status { font-weight: 700; white-space: nowrap; }
.log-ok .log-status { color: var(--positive, #2da44e); }
.log-fail .log-status { color: var(--negative, #e5534b); }
.log-table .log-widget { white-space: nowrap; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; }
.log-table .log-dur { white-space: nowrap; color: var(--muted); font-variant-numeric: tabular-nums; }
.log-table .log-trigger { white-space: nowrap; color: var(--muted); }
/* which page the widget sits on today - the tie-breaker when two cards
   share a title ("Crypto" on Home and on Everything) */
.log-table .log-page { white-space: nowrap; }
.log-table .log-page a { color: var(--muted); text-decoration: none; }
.log-table .log-page a:hover { color: var(--accent); text-decoration: underline; }
.meta { display: block; color: var(--muted); font-size: 0.78rem; margin-top: 0.1rem; }
.meta a.quiet { color: var(--muted); text-decoration: none; }
.meta a.quiet:hover { color: var(--accent); }
.empty, .pending { color: var(--muted); font-size: 0.85rem; margin: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
.pending:not(.error)::before, .btn-spinner {
  content: ""; display: inline-block; width: 0.8em; height: 0.8em;
  margin-right: 0.45em; vertical-align: -0.1em; border-radius: 50%;
  border: 2px solid var(--border); border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
.error { color: var(--negative); font-size: 0.8rem; margin: 0.4rem 0 0; }
/* first-run claim advisory: informative, not alarming - accent rule
   rather than error red, since claiming here is valid either way */
.claim-note {
  margin: 0.6rem 0 0; padding: 0.35rem 0 0.35rem 0.7rem;
  border-left: 3px solid var(--accent);
  color: var(--muted); font-size: 0.78rem; line-height: 1.5;
}
.claim-note strong { color: var(--text); font-weight: 600; }
/* sign-in failure: guidance reads first, the raw error stays available
   underneath for debugging without competing with it */
/* freshness stamp when the data is not current: the number itself is
   what misleads, so it carries the mark. Healthy cards stay unmarked -
   a signal shown on every card is not a signal. */
.card-stamp .stamp-stale { color: var(--negative); }
a.w-log.stamp-stale:hover { color: var(--negative); filter: brightness(1.15); }
#msg p { margin: 0.4rem 0 0; }
.msg-raw { font-size: 0.72rem; opacity: 0.7; overflow-wrap: anywhere; }
.heartbeat .hb-row { display: flex; align-items: baseline; gap: 0.5rem; }
.heartbeat .dot { width: 10px; height: 10px; border-radius: 50%; align-self: center; }
.status-ok .dot { background: var(--positive); }
.status-late .dot, .status-running .dot { background: hsl(40 90% 55%); }
.status-fail .dot, .status-missed .dot { background: var(--negative); }
.status-waiting .dot { background: var(--muted); }
.heartbeat .hb-status { font-weight: 600; }
.heartbeat .hb-row .meta { display: inline; margin: 0; }
.hb-bars { display: flex; gap: 3px; margin-top: 0.55rem; }
.hb-bars .bar { width: 8px; height: 18px; border-radius: 2px; background: var(--border); }
.hb-bars .bar.ok { background: var(--positive); }
.hb-bars .bar.fail { background: var(--negative); }
.hb-bars .bar.timeout { background: hsl(0 40% 38%); }
.hb-bars .bar.open { background: hsl(40 90% 55%); }
/* log widget (the other hand-rolled push type): pushed lines, newest first */
ul.log-list { list-style: none; margin: 0; padding: 0; }
ul.log-list li {
  display: flex; gap: 0.5rem; align-items: baseline;
  padding: 0.35rem 0; border-top: 1px solid var(--border); font-size: 0.88rem;
}
ul.log-list li:first-child { border-top: none; }
.log-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); align-self: center; }
.lvl-warn .log-dot { background: hsl(40 90% 55%); }
.lvl-error .log-dot { background: var(--negative); }
.log-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
ul.log-list .meta { flex: none; font-size: 0.72rem; }
ul.kv { list-style: none; margin: 0.4rem 0 0; padding: 0; }
ul.kv li { display: flex; justify-content: space-between; gap: 1rem; padding: 0.15rem 0; }
ul.kv .k { color: var(--muted); font-size: 0.85rem; }
ul.kv .v { font-variant-numeric: tabular-nums; }
.delta { font-size: 0.78rem; }
.delta.up { color: var(--positive); }
.delta.down { color: var(--negative); }
.mcp-text { margin: 0 0 0.5rem; font-size: 0.85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
body > main:first-child { padding-top: 1rem; } /* kiosk: no header above */
/* Per-page new-tab mode: chrome is absent from flow at rest, then opens
   over the dashboard so revealing it never shifts the widgets. */
.nav-reveal {
  position: absolute; z-index: 70; top: 100%; left: 50%;
  width: 3rem; height: 1.5rem; padding: 0;
  border: 1px solid color-mix(in srgb, var(--border) 65%, transparent); border-top: 0;
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  color: var(--muted); background: var(--bg);
  opacity: 1; visibility: visible; pointer-events: auto; transform: translateX(-50%);
}
.nav-reveal span {
  width: 0.35rem; height: 0.35rem;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg); transition: transform 0.15s ease;
}
.nav-reveal:hover, .nav-reveal:focus-visible {
  opacity: 1; color: var(--text);
  background: color-mix(in srgb, var(--bg) 92%, var(--text) 8%);
  border-color: color-mix(in srgb, var(--border) 65%, transparent); border-top: 0;
}
body.nav-collapsed .dashboard-chrome {
  display: block; position: fixed; z-index: 65; top: 0; left: 0; right: 0;
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  border-bottom: 1px solid var(--border); box-shadow: 0 8px 24px rgb(0 0 0 / 0.22);
  backdrop-filter: blur(12px);
  transform: translateY(-100%); visibility: hidden; pointer-events: none;
  transition: transform 0.2s ease, visibility 0s linear 0.2s;
}
body.nav-collapsed.nav-open .dashboard-chrome {
  transform: translateY(0); visibility: visible; pointer-events: auto;
  transition-delay: 0s;
}
body.nav-collapsed.nav-open .nav-reveal { opacity: 1; }
body.nav-collapsed.nav-open .nav-reveal span { transform: rotate(225deg); }
body.kiosk .nav-reveal { display: none; }
@media (prefers-reduced-motion: reduce) {
  body.nav-collapsed .dashboard-chrome { transition: none; }
}
/* JS fullscreen: hide the chrome but keep the page tabs so you can
   switch pages without leaving fullscreen (clicks soft-navigate) */
body.kiosk header h1, body.kiosk header .updated { display: none; }
body.kiosk header { padding-top: 0.5rem; }
.mcp-h { margin: 0.6rem 0 0.3rem; font-size: 0.9rem; font-weight: 700; }
.ui-tip { position: fixed; z-index: 60; background: var(--card); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 0.25rem 0.55rem; font-size: 0.75rem; pointer-events: none;
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.35); max-width: 320px; overflow-wrap: anywhere; }
.ui-tip[hidden] { display: none; }
.mcp-quote { margin: 0 0 0.5rem; padding: 0.1rem 0 0.1rem 0.7rem; border-left: 3px solid var(--accent);
  color: var(--muted); font-size: 0.9rem; }
.mcp-ul { margin: 0 0 0.5rem; padding-left: 1.2rem; font-size: 0.85rem; }
.mcp-ul li { margin: 0.15rem 0; }
.mcp-pre { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 0.55rem 0.7rem; font-family: ui-monospace, monospace; font-size: 12px;
  line-height: 1.5; overflow-x: auto; margin: 0 0 0.5rem;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.mcp-pre::-webkit-scrollbar { height: 6px; }
.mcp-pre::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.mcp-pre::-webkit-scrollbar-track { background: transparent; }
/* logged-out branding line lives INSIDE the page's bottom padding: main
   gives up its bottom padding so the total bottom band stays consistent
   with the 1rem/1.25rem top and side frame */
main:has(+ footer.site-footer) { padding-bottom: 0; }
.site-footer { padding: 0.25rem 1.25rem 0.5rem; line-height: 1; }
.site-footer a { color: var(--muted); font-size: 0.72rem; text-decoration: none; }
.site-footer a:hover { color: var(--accent); }
/* links inside markdown PROSE stay underlined - color alone isn't a
   sufficient cue among body text (WCAG 1.4.1); list-style links (feed,
   bookmarks) are exempt since everything there is a link */
.mcp-text a, .mcp-ul a, .mcp-h a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent);
  text-underline-offset: 2px;
}
.mcp-text a:hover, .mcp-ul a:hover, .mcp-h a:hover { text-decoration-color: var(--accent); }
.mcp-text code, .mcp-ul code { background: var(--bg); border-radius: 4px; padding: 0 0.25rem;
  font-family: ui-monospace, monospace; font-size: 0.9em; }
` + WIDGET_CSS;
