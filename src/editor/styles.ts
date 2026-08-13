export const EDITOR_CSS = /* css */ `
.editor-body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
/* no gap under the tabs: they are top-rounded chips and should sit ON
   the canvas seam, the way file tabs sit on their content */
/* bottom-aligned: the tabs need to reach the seam to sit on it, while
   the action cluster lifts off it by its own padding */
.editor-top { position: relative; display: flex; align-items: flex-end; gap: 1rem; padding: 0.35rem 1rem 0; border-bottom: 1px solid var(--border); }
/* Back in the top bar, the strip still begins where the canvas column
   begins, so it reads as belonging to the preview rather than to the
   chrome - collapsed, that seam moves in to the rail's edge. */
/* Both indents exist only while there IS a structure panel to align to.
   Mobile has none, and its reset (#page-tabs, one id) could not out-weigh
   the :has() rule below (an id plus three classes) - so a collapsed rail
   left the phone's tab strip indented against a full-width canvas. */
@media (min-width: 901px) {
  #page-tabs {
    margin-left: calc(var(--outline-w) + 6px - 1rem);
    transition: margin-left 0.2s ease;
  }
  .editor-top:has(+ .editor-grid.outline-collapsed) #page-tabs { margin-left: calc(2.3rem + 6px - 1rem); }
}
.editor-actions { margin-left: auto; flex: none; padding-bottom: 0.5rem; }
/* The strip is the SHRINKABLE region: without min-width:0 a long page
   list keeps its content width and shoves the action cluster (Save) off
   the right edge. It scrolls sideways instead; the actions never shrink. */
#page-tabs { display: flex; gap: 0.25rem; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
#page-tabs::-webkit-scrollbar { display: none; }
#page-tabs > * { flex: none; }
/* the tab announces its own draggability the way every other draggable
   thing in the editor does (widgets, row and column handles) */
/* Page chips shaped like the dashboard's, but painted from the BASE
   scheme rather than the theme: this strip is editor chrome sitting
   beside the preview, and a themed dashboard (paper, terminal) would
   otherwise drag the editor's own controls along with it. The *-scheme
   and *-fallback vars are the pre-theme defaults, still light/dark
   aware. Scoped to [aria-selected] so "+ page" stays quiet. */
#page-tabs button[aria-selected] {
  color: var(--muted-scheme); font-size: var(--chip-font);
  /* file tabs: square feet so they sit ON the canvas seam below, which
     is why .editor-top carries no bottom padding. Size comes from the
     shared chip tokens, so these match every other pill on the site. */
  padding: var(--chip-pad); border-radius: 6px 6px 0 0;
  border: 1px solid var(--border-scheme); border-bottom: 0; background: none;
}
#page-tabs button[aria-selected]:hover { color: var(--text-scheme); border-color: var(--muted-scheme); }
/* only the page tabs themselves drag - not "+ page", not the move
   buttons. Every tab carries aria-selected, so it identifies them. */
#page-tabs button[aria-selected] { cursor: grab; }
#page-tabs button[aria-selected="true"] { color: var(--accent-fallback); background: var(--card-scheme); border-color: var(--accent-fallback); }
/* public-page marker: sized down and nudged so it reads as a badge
   rather than a second word in the tab label */
#page-tabs .tab-public { margin-left: 0.35rem; font-size: 0.75em; vertical-align: 1px; }
#page-tabs button.dragging { opacity: 0.4; cursor: grabbing; }
#page-tabs button.drop-hover { outline: 2px dashed var(--accent-fallback); outline-offset: 2px; }
.editor-actions { display: flex; align-items: center; gap: 0.5rem; }
/* button variants come from the shared system in styles.css */
/* the width lives on the BODY, not the grid: the top bar is a sibling of
   the grid and has to read it too, to line the page tabs up with the
   preview column (the resizer's JS writes it here as well) */
.editor-body { --outline-w: 230px; --inspector-w: 320px; }
/* both side panels are variable-width columns, so collapsing either is a
   variable change rather than a second template - and anything anchored
   to a panel's edge (the inspector's own toggle) follows for free */
/* --band-h is the height of BOTH panel header bands and of the rule the
   resize gutter draws between them, so the three land on one line. It was
   implicit before (each band was content-sized, the panels padded by a
   hand-matched 2.1rem) and they missed each other by ~2px. */
.editor-grid {
  --band-h: 2.1rem; position: relative; display: grid;
  grid-template-columns: var(--outline-w) 6px minmax(0, 1fr) 6px var(--inspector-w);
  flex: 1; min-height: 0;
}
@media (min-width: 901px) {
  /* Collapse the rails and grow the preview as one continuous movement.
     The variables still hold the resizable widths; animating the resolved
     grid tracks avoids JS-driven frame updates and preserves drag sizing. */
  .editor-grid { transition: grid-template-columns 0.2s ease; }
}
.editor-grid.outline-collapsed { --outline-w: 2.3rem; }
/* Collapsed, the inspector becomes a RAIL rather than nothing: the
   column keeps its border and background, so the panel still reads as a
   panel, and its toggle stays on it instead of floating on the canvas. */
.editor-grid.inspector-collapsed { --inspector-w: 2.3rem; }
/* Hiding the PANEL hid its border with it, so a collapsed rail had no
   line against the canvas below its header. The contents hide instead;
   the box - border, background - stays. (Scoped away from mobile, where
   the panel is a bottom sheet that must show its contents.) */
.editor-grid.inspector-collapsed #inspector { padding: 0; overflow: hidden; }
@media (min-width: 901px) {
  /* Each panel is a clipping viewport around a full-width surface. The
     surface slides with the animated outer edge instead of reflowing at
     every intermediate width, so its controls retain their real shape. */
  .editor-grid #outline, .editor-grid #inspector { overflow-x: hidden; padding: 0; }
  .outline-content {
    box-sizing: border-box;
    width: calc(var(--outline-expanded-w, 230px) - var(--outline-chrome, 1px));
    /* The scrollbar gutter already creates space on the right. Subtract
       it from the content inset so the visible edge matches the 0.75rem
       left inset instead of looking like two paddings side by side. */
    min-height: 100%;
    padding: calc(var(--band-h) + 0.55rem) max(0px, calc(0.75rem - var(--outline-chrome, 1px))) 0.75rem 0.75rem;
    transform: translateX(0);
    transition: transform 0.2s ease;
  }
  .inspector-content {
    /* The panel's left border and stable scrollbar gutter live inside its
       grid track. Subtract that measured chrome from the pre-rendered
       surface so its trailing padding and narrow compound fields remain
       visible instead of being clipped by overflow-x:hidden. */
    box-sizing: border-box;
    width: calc(var(--inspector-expanded-w, 320px) - var(--insp-sb, 1px));
    min-height: 100%; padding: calc(var(--band-h) + 0.55rem) 0.75rem 0.75rem;
    transform: translateX(0);
    transition: transform 0.2s ease;
  }
  .editor-grid.outline-collapsed .outline-content {
    transform: translateX(-100%);
  }
  .editor-grid.inspector-collapsed .inspector-content {
    transform: translateX(100%);
  }
}
/* Sits at the top-right of the panel in BOTH states - the rail is wide
   enough to hold it, so one anchor serves expanded and collapsed alike
   and the control never leaves the panel it belongs to. (The panel's own
   contents are visibility:hidden when collapsed; the toggle is a grid
   child, not an inspector child, so it survives that and the inspector's
   re-renders.) */
/* The inspector's header band - the mirror of the structure one: full
   panel width, opaque (the panel scrolls under it), whole row clickable.
   Its right padding clears the scrollbar gutter (--insp-sb, measured at
   load and held constant by scrollbar-gutter: stable) so the label never
   sits under the scrollbar. */
.inspector-toggle {
  position: absolute; z-index: 3; top: 0; right: 0;
  width: var(--inspector-w); text-align: left;
  font-size: 0.72rem; line-height: 1;
  padding: 0.7rem calc(0.75rem + var(--insp-sb, 0px)) 0.5rem 0.75rem;
  letter-spacing: 0.04em; text-transform: uppercase;
  background: var(--bg); color: var(--muted);
  /* The band is opaque and spans the panel's full width, so it painted
     over the panel's own left border for its height - the border looked
     like it started below the header. It carries that border itself. */
  border: 0; border-bottom: 1px solid var(--border);
  border-left: 1px solid var(--border); border-radius: 0;
}
.inspector-toggle:hover { color: var(--accent); border-color: var(--border); }
/* Collapsed, the rail is NARROWER than this button's own padding (0.75rem
   + the scrollbar gutter), and a border-box floors at its padding - so the
   button rendered wider than its column and hung over the canvas. The
   collapsed panel has no scrollbar to clear, so the gutter goes with it
   and the icon centres in the rail. */
.editor-grid.inspector-collapsed .inspector-toggle,
.editor-grid.outline-collapsed .outline-toggle {
  top: 0; bottom: 0; height: auto;
  display: block; position: absolute;
  padding: 0; text-align: center;
  line-height: 1;
  border-bottom: 0;
}
.editor-grid .rail-icon {
  position: absolute; top: 0; left: 0; right: 0;
  height: var(--band-h); display: flex; align-items: center; justify-content: center;
  font-size: 0.72rem; border-bottom: 1px solid var(--border);
}
.editor-grid .rail-arrow {
  position: absolute; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  font-size: 1.35rem;
}
.editor-grid.outline-collapsed .outline-toggle { cursor: e-resize; }
.editor-grid.inspector-collapsed .inspector-toggle { cursor: w-resize; }
/* the sheet header belongs to the mobile bottom sheet alone - on desktop
   the inspector is a column with its own toggle above it */
.sheet-handle { display: none; }
.editor-grid.outline-collapsed #outline { padding: 0; overflow: hidden; }
.outline-resizer { position: relative; cursor: col-resize; background: transparent; border-right: 1px solid var(--border); }
.outline-resizer:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); }
/* Mirror of the inspector's: each panel carries its own toggle at its
   top outer corner, in both states. It used to sit in the top bar beside
   the page tabs, where it read as a fourth tab. */
/* The panel's header band. It spans the panel and is OPAQUE because the
   panel scrolls underneath it - a transparent chip let rows slide
   visibly through the label. The rule marks where that scroll begins. */
.outline-toggle {
  position: absolute; z-index: 3; top: 0; left: 0;
  width: var(--outline-w); text-align: left;
  font-size: 0.72rem; line-height: 1; padding: 0.7rem 0.75rem 0.5rem;
  letter-spacing: 0.04em; text-transform: uppercase;
  background: var(--bg); color: var(--muted);
  /* mirror of the inspector's: carries the panel's right border, which
     it would otherwise paint over */
  border: 0; border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border); border-radius: 0;
}
/* content starts below each panel's header band rather than under it */
/* Desktop only: these clear the panels' header bands, which exist only
   where there are side panels. On mobile they out-specified the sheet's
   own reset (one id against an id plus a class) and left a band-high gap
   above its sticky header. */
/* both bands are exactly --band-h, so their rules and the gutter's meet */
.outline-toggle, .inspector-toggle {
  height: var(--band-h);
  white-space: nowrap; overflow: hidden;
  transition: width 0.2s ease, color 0.12s ease;
}
/* a collapsed rail is not resizable: dragging it used to silently expand
   the panel, so the handle now says so by dropping the resize cursor.
   Double-click still toggles it back open. */
.editor-grid.outline-collapsed .outline-resizer { visibility: hidden; cursor: default; }
.inspector-resizer {
  position: relative; cursor: col-resize; background: transparent;
  border-left: 1px solid var(--border);
}
.inspector-resizer:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); }
.editor-grid.inspector-collapsed .inspector-resizer { visibility: hidden; cursor: default; }
.outline-toggle:hover { color: var(--accent); border-color: var(--border); }
#outline, #inspector { overflow-y: auto; padding: 0.75rem; border-right: 1px solid var(--border); }
/* Reserve the gutter whether or not it is in use. Besides keeping the
   inspector header stable, this gives the full-width sliding surfaces a
   fixed content box and preserves their trailing padding. */
#outline, #inspector { scrollbar-gutter: stable; }
#inspector { border-right: 0; border-left: 1px solid var(--border); }
/* even padding all round: the canvas gets the same breathing room above
   it as it has at its sides and foot */
#center { overflow-y: auto; padding: 0.75rem 1rem; background: var(--bg); }
#preview { container: dashboard-preview / inline-size; }
#preview main { padding: 0; max-width: none; }
/* Fit-screen rows get a representative viewport independently rather than
   sharing one short editor viewport. Editor handles take explicit auto
   tracks, columns receive the remainder, and cards never shrink below
   their natural height. This makes expand mean “fill the column” here too
   without letting a busy draft collapse every card in the preview. */
@media (min-width: 901px) {
  #preview main.fit-screen .row {
    flex: none !important; min-height: 30rem;
    grid-template-rows: auto minmax(0, 1fr); grid-auto-rows: auto;
  }
  #preview main.fit-screen .row:has(> .row-title) {
    grid-template-rows: auto auto minmax(0, 1fr);
  }
  #preview main.fit-screen .col { overflow-y: auto; min-height: 0; }
  #preview main.fit-screen .col > section.widget {
    flex: 0 0 auto; min-height: auto; overflow: visible;
  }
  #preview main.fit-screen .col > section.widget.expand { flex: 1 0 auto; }
  #preview main.fit-screen .col > section.widget > h2 {
    position: static; margin: 0 0 0.6rem; padding: 0;
  }
}
/* The rendered dashboard normally stacks at the viewport's 760px
   breakpoint. In the editor the canvas is only the centre pane, so use
   that pane's width instead: collapsing or resizing either side panel can
   now produce the same layout the dashboard will have at that width. */
@container dashboard-preview (max-width: 760px) {
  #preview .row { grid-template-columns: 1fr; }
  #preview .col { grid-column: 1 / -1; }
  #preview .col-resize { display: none; }
  #preview main.fit-screen .row {
    flex: none !important; min-height: 0;
    grid-template-rows: auto; grid-auto-rows: auto;
  }
  #preview main.fit-screen .col { overflow: visible; min-height: 0; }
  #preview main.fit-screen .col > section.widget {
    flex: 0 0 auto; min-height: auto; overflow: visible;
  }
  #preview main.fit-screen .col > section.widget.expand { flex: 0 0 auto; }
}
/* visible containers: the page, its rows, and their columns all read as
   structure in the editor - one nesting level per border weight */
#preview main.page-frame {
  border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 12px; padding: 0.5rem; row-gap: 0.5rem;
}
#preview main.page-frame:has(> .page-handle.selected) { border-color: var(--accent); border-style: solid; }
.page-handle {
  font-size: 0.68rem; color: var(--muted); cursor: pointer;
  border-left: 3px solid var(--border); padding: 0 0.4rem; line-height: 1.3;
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.5rem;
}
.page-handle:hover { color: var(--accent); }
.page-handle.selected { color: var(--accent); border-left-color: var(--accent); }
.page-handle .tab-public { margin-left: 0.35rem; font-size: 0.9em; }
#preview .row {
  border: 1px dashed var(--border); border-radius: 10px;
  padding: 0.5rem; row-gap: 0.5rem;
}
#preview .row:has(> .row-handle.selected) { border-color: var(--accent); border-style: solid; }
#preview .col {
  border: 1px dashed color-mix(in srgb, var(--border) 60%, transparent);
  border-radius: 8px; padding: 0.4rem; min-height: 3.2rem;
  position: relative;
}
.col-resize { position: absolute; top: 0; bottom: 0; right: -0.7rem; width: 1rem; cursor: col-resize; z-index: 2; }
.col-resize::after { content: ""; position: absolute; left: 50%; top: 15%; bottom: 15%; width: 3px; border-radius: 2px; background: transparent; transition: background 0.12s; }
.col-resize:hover::after { background: var(--accent); }
#preview .col:has(> .col-handle.selected) { border-color: var(--accent); border-style: solid; }
.ol-row { margin-bottom: 0.6rem; border: 1px solid var(--border); border-radius: 8px; padding: 0.35rem 0.4rem; }
#preview section.widget { cursor: grab; position: relative; }
#preview section.widget .qd {
  /* Cards are position:relative with no z-index, so they all paint in the
     same layer and the LATER card in the column wins - covering the button
     of the card above it. A stacking order of its own lifts the button out
     of that fight; the card keeps z-index auto so it never becomes a
     stacking context that would trap the button again. */
  position: absolute; z-index: 4; top: 0.35rem; right: 0.45rem; opacity: 0;
  pointer-events: auto; padding: 0 0.35rem; font-size: 0.72rem; line-height: 1.5;
  /* Destructive preview chrome stays red in every dashboard theme. The
     shadow and explicit border keep it distinct over light cards. */
  background: hsl(0 70% 52%); color: #fff;
  border: 1px solid hsl(0 70% 44%);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.25);
}
/* The button floats over the card, so nothing in normal flow knows it is
   there: a title long enough to reach the right edge ran straight under
   it. The heading (and a description, which wraps to the same corner)
   keeps a lane clear for it - only in the preview, since the live
   dashboard has no delete button to avoid. */
#preview section.widget > h2,
#preview section.widget > .widget-desc { padding-right: 1.7rem; }
#preview section.widget:hover .qd { opacity: 1; }
.qd:hover { background: hsl(0 75% 44%); border-color: hsl(0 75% 38%); color: #fff; }
.row-handle, .col-handle { position: relative; cursor: grab; }
.row-handle.dragging, .col-handle.dragging { opacity: 0.4; cursor: grabbing; }
.h-actions {
  position: absolute; right: 0.25rem; top: 50%; transform: translateY(-50%);
  display: flex; gap: 1px; opacity: 0;
}
.row-handle:hover .h-actions, .col-handle:hover .h-actions,
.row-handle:focus-within .h-actions, .col-handle:focus-within .h-actions,
.row-handle:focus .h-actions, .col-handle:focus .h-actions { opacity: 1; }
.mv-inline, .qd-inline {
  border: 0; background: none; padding: 0 0.2rem;
  font-size: 0.7rem; color: var(--muted); pointer-events: auto; line-height: 1.2;
}
.mv-inline:hover { color: var(--accent); background: none; border: 0; }
.mv-inline:disabled, .ol-mini:disabled { opacity: 0.3; cursor: default; }
.mv-inline:disabled:hover { color: var(--muted); }
.mv-split { text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.6rem; font-weight: 700; }
.qd-inline:hover { color: hsl(0 70% 58%); background: none; border: 0; }
#preview section.widget.dragging { opacity: 0.4; cursor: grabbing; }
#preview .drop-hover { outline: 2px dashed var(--accent); outline-offset: 2px; }
/* add-placeholders: visually distinct from real (grey-dashed) containers -
   accent-tinted dashed chips so "add here" never reads as existing structure */
.ph-row, .ph-widget, .ph-col {
  border: 1.5px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  color: color-mix(in srgb, var(--accent) 80%, var(--muted));
  border-radius: 8px; text-align: center; font-size: 0.8rem; font-weight: 600;
  padding: 0.5rem; cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.ph-row:hover, .ph-widget:hover, .ph-col:hover,
.ph-row.drop-hover, .ph-widget.drop-hover, .ph-col.drop-hover {
  border-color: var(--accent); color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.ph-widget { margin-top: 0.25rem; padding: 0.35rem; }
.ph-col { display: flex; align-items: center; justify-content: center; min-height: 3.2rem; }
.row-handle {
  grid-column: 1 / -1; font-size: 0.68rem; color: var(--muted); cursor: pointer;
  border-left: 3px solid var(--border); padding: 0 0.4rem; line-height: 1.3;
  text-transform: uppercase; letter-spacing: 0.06em;
}
.col-handle {
  font-size: 0.68rem; color: var(--muted); cursor: pointer; text-align: center;
  border: 1px dashed transparent; border-radius: 5px; padding: 0.05rem 0;
}
.row-handle:hover, .col-handle:hover { color: var(--accent); }
.row-handle.selected { color: var(--accent); border-left-color: var(--accent); }
.col-handle.selected { color: var(--accent); border-color: var(--accent); }
#preview section.widget.selected { outline: 2px solid var(--accent); outline-offset: 2px; }
#preview section.widget * { pointer-events: none; }

.ol-page { margin-bottom: 0.5rem; }
.ol-col { margin: 0.35rem 0 0.35rem 0; padding-left: 0.5rem; border-left: 2px solid var(--border); }
.ol-col-head, .ol-widget { display: flex; align-items: center; gap: 0.3rem; padding: 0.15rem 0.2rem; border-radius: 5px; cursor: grab; }
.ol-col-head.dragging, .ol-widget.dragging { opacity: 0.4; cursor: grabbing; }
.outline-content .drop-hover { outline: 2px dashed var(--accent); outline-offset: 1px; }
.ol-widget.drop-before, .ol-widget.drop-after,
#preview section.widget.drop-before, #preview section.widget.drop-after { position: relative; }
.ol-widget.drop-before::before, .ol-widget.drop-after::after,
#preview section.widget.drop-before::before, #preview section.widget.drop-after::after {
  content: ""; position: absolute; z-index: 20; left: 0; right: 0;
  height: 3px; border-radius: 999px; background: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent);
}
.ol-widget.drop-before::before, #preview section.widget.drop-before::before { top: -3px; }
.ol-widget.drop-after::after, #preview section.widget.drop-after::after { bottom: -3px; }
/* widgets in a column are separate items, not a paragraph: a rule and a
   little air between them so the eye can count them at a glance */
.ol-widget { padding-top: 0.3rem; padding-bottom: 0.3rem; }
/* The old narrow-panel layout wrapped five movement buttons onto another
   line. With movement delegated to drag/keyboard/Inspector, each widget
   has only Delete: keep it pinned right and ellipsize the name instead of
   shrinking all of the hierarchy's type. */
.ol-widget { flex-wrap: nowrap; }
.ol-widget > .ol-del { flex: none; align-self: flex-start; white-space: nowrap; }
.ol-widget + .ol-widget { border-top: 1px solid var(--border); border-top-left-radius: 0; border-top-right-radius: 0; }
.ol-widget.selected { border-radius: 5px; }
.ol-col-head .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ol-widget { cursor: grab; }
.ol-widget.selected, .ol-col-head.selected { background: var(--card); outline: 1px solid var(--accent); }
.ol-w-icon { flex: none; align-self: flex-start; line-height: 1.25; }
.ol-w-text { display: flex; flex-direction: column; flex: 1; min-width: 0; line-height: 1.25; }
.ol-widget .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ol-widget .ty { color: var(--muted); font-size: 0.65rem; }
.ol-mini { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0 0.15rem; font-size: 0.85rem; }
.ol-mini:hover { color: var(--accent); }
.ol-mini.ol-del:hover { color: hsl(0 70% 58%); }
/* "+ widget" closes the list with the SAME rule that divides the widgets
   above it. It has to be full width to do that: the class is on the
   BUTTON, so a shrink-wrapped one drew its rule only as wide as its own
   label - a stub line floating mid-column. */
.ol-add {
  display: block; width: 100%; text-align: center;
  margin-top: 0; border-top: 1px solid var(--border); padding-top: 0.3rem;
  /* square: the button's inherited radius bent the ends of that rule */
  border-radius: 0;
}

#inspector h2 { margin: 0 0 0.6rem; font-size: 0.85rem; color: var(--accent); }
/* Text-field structure comes from the shared input system. The inspector
   alone needs a surface override: unlike card-based forms, it sits on
   --bg, so --bg fields otherwise disappear into the panel. */
#inspector input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="color"]):not([type="range"]),
#inspector select, #inspector textarea, #inspector .str-chip { background: var(--card); }
/* checkbox fields: box and label on one line, the label doing the
   labelling rather than a heading above an orphaned box */
#inspector .check-line { display: flex; align-items: center; gap: 0.1rem; margin: 0.55rem 0 0; font-size: 0.82rem; color: var(--text); font-weight: normal; }
#inspector .check-line input { width: auto; margin: 0 0.15rem 0 0; }
#inspector .field-help { font-size: 0.72rem; color: var(--muted); margin: 0.1rem 0 0; }
/* description textareas are prose, not code: UI font, vertical resize only */
#f-description, textarea.desc-input { font-family: inherit; font-size: 0.85rem; resize: vertical; }
#inspector details { margin-top: 0.7rem; }
#inspector details summary { color: var(--muted); font-size: 0.78rem; cursor: pointer; }
.move-widget {
  margin: 1rem 0 0; padding: 0.65rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  display: grid; gap: 0.55rem;
}
.move-widget legend { padding: 0 0.25rem; color: var(--muted); font-size: 0.75rem; }
.move-widget label { margin: 0; }
.move-widget button { justify-self: end; }
.theme-actions { margin: 0.9rem 0 0.35rem; display: flex; gap: 0.4rem; flex-wrap: wrap; }
#inspector .danger-zone { margin-top: 1rem; padding-top: 0.6rem; border-top: 1px solid var(--border); display: flex; gap: 0.4rem; flex-wrap: wrap; }
.sensitive-badge { font-size: 0.68rem; color: hsl(40 90% 55%); border: 1px solid hsl(40 90% 35%); border-radius: 4px; padding: 0 0.3rem; margin-left: 0.3rem; }

/* Keep enough room for the native select arrow and the full unit label,
   even at the Inspector's minimum width. */
.interval-row { display: flex; gap: 0.3rem; align-items: center; }
.interval-row .interval-qty { width: 4.5rem; flex: 0 0 4.5rem; }
.interval-row .interval-unit { flex: 1 1 7rem; min-width: 7rem; }
.clock-rows { display: grid; gap: 0.3rem; margin-bottom: 0.35rem; }
.clock-row { display: flex; gap: 0.3rem; align-items: flex-start; }
.clock-row > input { width: 38%; flex: none; }
/* the share link is one long URL - it takes the full row */
.share-row > input { width: auto; flex: 1; min-width: 0; }
.clock-row .ol-del { margin-top: 0.35rem; }
.field-path { font-family: ui-monospace, monospace; }
.color-swatch { flex: none; width: 2.2rem; height: 2rem; padding: 0.15rem; cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--radius-sm, 6px); background: var(--bg); }
.str-chip { flex: 1; font-size: 0.8rem; padding: 0.3rem 0.55rem; background: var(--bg);
  border: 1px solid var(--border); border-radius: 6px; }
.clock-row .field-path { flex: 1.4; }
.tz-box { flex: 1; min-width: 0; }
.tz-box input { width: 100%; }
.pick-btn { margin-top: 0.35rem; font-size: 0.75rem; }
.pick-list { display: grid; gap: 2px; margin-top: 0.35rem; max-height: 14rem;
  overflow-y: auto; overflow-x: hidden; }
.pick-item { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 0.4rem;
  text-align: left; font-size: 0.74rem; padding: 0.2rem 0.4rem; min-width: 0; }
.pick-item:hover { border-color: var(--accent); }
.pick-mark { color: var(--accent); font-weight: 700; }
.pick-path { font-family: ui-monospace, monospace; overflow-wrap: anywhere; min-width: 0; }
/* the actual response value, stacked full-width under the path */
.pick-val { grid-column: 2; color: var(--muted); overflow-wrap: anywhere; min-width: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.geo-results { display: grid; gap: 3px; margin-top: 0.35rem; }
.geo-item { text-align: left; font-size: 0.8rem; }
.geo-item:hover { color: var(--accent); border-color: var(--accent); }

#yaml-pane textarea { width: 100%; height: 70vh; font-family: ui-monospace, monospace; font-size: 13px;
  background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem; }

#history-dialog { max-width: 560px; }
#history-list { display: grid; gap: 0.6rem; max-height: 60vh; overflow-y: auto; margin-top: 0.4rem; }
.hist-item { border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.7rem; }
.hist-head { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.82rem; }
.hist-changes { margin: 0.3rem 0 0; padding-left: 1.1rem; color: var(--muted); font-size: 0.78rem; }

@keyframes widget-in { from { opacity: 0; transform: scale(0.96) translateY(4px); } to { opacity: 1; transform: none; } }
#preview .enter { animation: widget-in 0.18s ease; }
#preview .probe-body { animation: widget-in 0.18s ease; }
#preview .vanish { transition: opacity 0.14s ease, transform 0.14s ease; opacity: 0 !important; transform: scale(0.96); pointer-events: none; }
#preview section.widget.optimistic { border-style: dashed; }

#toast {
  position: fixed; bottom: 1.2rem; left: 50%; transform: translate(-50%, 8px);
  display: flex; align-items: center; gap: 0.7rem;
  background: var(--card); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; padding: 0.5rem 0.9rem; font-size: 0.85rem;
  opacity: 0; pointer-events: none; transition: opacity 0.15s, transform 0.15s;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.35); z-index: 50;
}
#toast.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }

dialog { background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 10px;
  max-width: 480px; width: 90vw; padding: 1rem 1.2rem; }
dialog::backdrop { background: rgb(0 0 0 / 0.55); }
dialog h2 { margin: 0 0 0.6rem; font-size: 0.95rem; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.8rem; }
#gallery-list { display: grid; gap: 0.5rem; margin-top: 0.6rem; max-height: 50vh; overflow-y: auto; }
.gal-item { text-align: left; padding: 0.5rem 0.7rem; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--text); cursor: pointer; font: inherit; }
.gal-item:hover { border-color: var(--accent); }
.gal-item .gt { font-weight: 600; }
.gal-item .gc { color: var(--accent); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }
.gal-item .gd, .gal-item .gr { display: block; color: var(--muted); font-size: 0.78rem; }
.gal-item .gr { color: hsl(40 90% 55%); }

@media (max-width: 900px) {
  /* mobile is preview-first: no structure panel (the preview's own add
     placeholders cover structure edits), and the desktop collapsed-state
     selector is out-specified so it can't force the 4-column grid */
  .editor-grid, .editor-grid.outline-collapsed { grid-template-columns: 1fr; grid-template-rows: 1fr; }
  /* the inspector is a bottom sheet here, opened by selection - there is
     no side column to collapse, so the desktop rail toggles go */
  .editor-grid .outline-resizer,
  .editor-grid .inspector-resizer,
  .editor-grid .outline-toggle,
  .editor-grid.outline-collapsed .outline-toggle,
  .editor-grid .inspector-toggle,
  .editor-grid.inspector-collapsed .inspector-toggle { display: none; }
  /* The sheet header is also its collapsed bottom handle. Sticky keeps it
     at the sheet's top while its fields scroll; opening the sheet carries
     the whole header upward in the conventional bottom-sheet pattern. */
  #inspector { padding-top: 0; }
  .sheet-handle {
    display: flex; align-items: center; justify-content: center; gap: 0.4rem;
    position: sticky; z-index: 2; top: 0;
    height: 44px; min-height: 44px;
    width: 100%; margin: 0;
    padding: 0 0.75rem; background: var(--bg);
    border: 0; border-bottom: 1px solid var(--border); border-radius: 0;
    color: var(--muted); font-size: 0.78rem;
    letter-spacing: 0.06em; text-transform: uppercase;
  }
  .sheet-handle .sh-title { display: inline-flex; align-items: center; line-height: 1; }
  /* Keep a text-height alignment box beside the title, then draw a much
     smaller chevron at its centre. The box rotates between states; the
     mark never changes size or baseline. */
  .sheet-handle .sh-chev {
    display: inline-block; position: relative;
    width: 0.65rem; height: 1em; flex: none;
    transform-origin: 50% 50%;
    transition: transform 0.18s ease;
  }
  .sheet-handle .sh-chev::before {
    content: ""; position: absolute; left: 50%; top: 50%;
    width: 0.32rem; height: 0.32rem;
    border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
    transform: translate(-50%, -65%) rotate(45deg);
  }
  .sheet-handle:hover { color: var(--text); border-color: var(--border); }
  #outline, .editor-grid.outline-collapsed #outline { display: none; }
  .editor-top { flex-wrap: wrap; row-gap: 0.35rem; gap: 0.5rem; }
  /* no structure panel here, so no seam to align to: the strip takes a
     full row of its own BELOW the actions - it sits directly on the
     canvas that way, as tabs should - and scrolls sideways when the tabs
     outgrow a phone */
  #page-tabs { order: 1; flex-basis: 100%; margin-left: 0; overflow-x: auto; scrollbar-width: none; }
  /* one content edge down the whole phone screen: the global header uses
     1.25rem, so the tab strip and the canvas below it match the brand
     above them rather than sitting 4px inside it */
  .editor-top, #center { padding-left: 1.25rem; padding-right: 1.25rem; }
  /* Keep the preview's own top and bottom inset identical. The inspector
     reservation is a separate spacer below the content, not extra bottom
     padding that makes the pane itself look lopsided. */
  #center { padding-top: 1.25rem; padding-bottom: 1.25rem; }
  #center::after {
    content: ""; display: block;
    height: calc(44px + env(safe-area-inset-bottom, 0px));
  }
  #page-tabs::-webkit-scrollbar { display: none; }
  /* actions wrap to their own row, anchored right - under the thumb that
     reaches for Save. They also wrap INTERNALLY: five buttons plus the
     dirty marker overflow a phone row, and an overflowing flex line has
     no free space for margin-left:auto to push into. */
  /* The cluster takes a full row here and MAY shrink: desktop pins it
     with flex:none so a long page list can't shove Save off the edge,
     but on a phone that same rule left it at max-content and clipped
     Save instead of wrapping. Its own row, free to wrap inside. */
  .editor-actions { flex: 1 1 100%; flex-wrap: wrap; justify-content: flex-end; }
  #preview .row { grid-template-columns: 1fr; }
  /* The inspector is a bottom sheet here. It never hides completely: it
     rests as a handle along the bottom edge and slides up on selection
     or tap. A desktop
     collapse (persisted in localStorage) must not carry over: there is
     no desktop rail at this width, so the sheet owns the collapsed state. */
  #inspector, .editor-grid.inspector-collapsed #inspector {
    --sheet-peek: calc(44px + env(safe-area-inset-bottom, 0px));
    position: fixed; left: 0; right: 0; bottom: 0; max-height: 55vh;
    visibility: visible; overflow: hidden; scrollbar-gutter: auto;
    padding: 0 0 env(safe-area-inset-bottom, 0px);
    /* the same surface the inspector is on desktop - the sheet is that
       panel, not a dialog on top of it */
    background: var(--bg); border-top: 1px solid var(--border); border-left: 0;
    box-shadow: 0 -8px 24px rgb(0 0 0 / 0.35); border-radius: 12px 12px 0 0;
    transform: translateY(calc(100% - var(--sheet-peek)));
    transition: transform 0.18s ease; cursor: pointer;
  }
  #inspector.open, .editor-grid.inspector-collapsed #inspector.open { transform: translateY(0); cursor: auto; }
  /* Scroll only the fields below the fixed title handle. If the sheet
     itself scrolls, the browser paints its scrollbar beside the title. */
  #inspector.open .inspector-content {
    max-height: calc(55vh - 44px - env(safe-area-inset-bottom, 0px));
    box-sizing: border-box; overflow-y: auto; scrollbar-gutter: stable;
    padding: 0.5rem 0.75rem 0.75rem;
  }
  /* Closed, only the handle and safe area remain visible. Suppress the
     stable desktop scrollbar gutter too, so no scrollbar track peeks out
     beside the minimized handle. */
  #inspector:not(.open) { scrollbar-width: none; }
  #inspector:not(.open)::-webkit-scrollbar { display: none; }
  #inspector:not(.open) .sheet-handle {
    height: var(--sheet-peek); padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  #inspector:not(.open) > :not(.sheet-handle) { opacity: 0; }
  /* Open points down to dismiss; collapsed rotates the same centred box
     upward without changing its dimensions or baseline. */
  .sheet-handle[aria-expanded="false"] .sh-chev { transform: rotate(180deg); }
  #preview main { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .editor-grid, #page-tabs, .outline-toggle, .inspector-toggle,
  .outline-content, .inspector-content { transition: none; }
}
`;
