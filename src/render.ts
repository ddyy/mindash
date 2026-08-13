import { BUILTIN_THEMES, COLUMN_SPANS, getConfig, isPullWidget, type DashConfig, type PullWidgetConfig, type StaticWidgetConfig, type ThemeConfig } from "./config";
import { av } from "./assetversion";

// ---------- theme application ----------
const FONT_STACKS: Record<string, string> = {
  system: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  serif: "Iowan Old Style, Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  rounded: "ui-rounded, 'SF Pro Rounded', system-ui, sans-serif",
};

// colors are hex (canonical) or legacy HSL triplets
export function cssColor(v: string): string {
  return v.startsWith("#") ? v : `hsl(${v})`;
}

// A page's effective theme: its preset (if any) overlaid on the global.
export function effectiveTheme(cfg: DashConfig, pageIndex: number): ThemeConfig {
  const preset = cfg.pages[pageIndex]?.theme;
  const overlay = preset ? (cfg.themes[preset] ?? BUILTIN_THEMES[preset]) : undefined;
  return overlay ? { ...cfg.theme, ...overlay } : cfg.theme;
}

export function themeCssVars(t: ThemeConfig): string {
  // Only explicitly-set colors override; absent ones fall back to the
  // scheme-aware defaults in styles.css (light and dark differ to keep
  // WCAG contrast - a single baked value can't satisfy both schemes).
  const parts: string[] = [];
  if (t.accent) parts.push(`--accent-override: ${cssColor(t.accent)}`);
  if (t.positive) parts.push(`--positive-override: ${cssColor(t.positive)}`);
  if (t.negative) parts.push(`--negative-override: ${cssColor(t.negative)}`);
  if (t.background) parts.push(`--bg-override: ${cssColor(t.background)}`);
  if (t.text) parts.push(`--text-override: ${cssColor(t.text)}`);
  if (t.muted) parts.push(`--muted-override: ${cssColor(t.muted)}`);
  if (t.card) parts.push(`--card-override: ${cssColor(t.card)}`);
  if (t.border) parts.push(`--border-override: ${cssColor(t.border)}`);
  if (t.card_opacity !== undefined) parts.push(`--card-opacity: ${t.card_opacity}%`);
  if (t.radius !== undefined) {
    parts.push(`--radius: ${t.radius}px`, `--radius-sm: ${Math.max(0, Math.round(t.radius * 0.6))}px`);
  }
  if (t.font && FONT_STACKS[t.font]) parts.push(`--font: ${FONT_STACKS[t.font]}`);
  if (t.font_size !== undefined) parts.push(`--font-size: ${t.font_size}px`);
  const TITLE_SIZES: Record<string, string> = { small: "0.7rem", large: "0.95rem", "x-large": "1.15rem" };
  if (t.title_size && TITLE_SIZES[t.title_size]) parts.push(`--title-size: ${TITLE_SIZES[t.title_size]}`);
  return parts.join("; ");
}

// CSS string-context escaper: hex-escapes everything that could close the
// string, the url(), or the surrounding <style> element. Validation already
// rejects these characters in stored refs; this is the render-time
// guarantee that no runtime string can produce CSS/HTML syntax.
function cssString(v: string): string {
  return v.replace(/[\\"'<>()\s]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
}

// body background rule for an uploaded/external wallpaper (refs are
// validated at parse: /asset/ path shape or https URL)
export function themeBodyCss(t: ThemeConfig): string {
  if (!t.background_image) return "";
  return `body { background-image: url("${cssString(t.background_image)}"); background-size: cover; background-position: center; background-attachment: fixed; }`;
}

// Every theme image origin the browser may load. Internal /asset/ paths
// are same-origin; external https URLs contribute their origin.
export function imgSrcFor(cfg: DashConfig, theme: ThemeConfig = cfg.theme): string {
  const refs = [theme.background_image, theme.logo, theme.favicon].filter((x): x is string => !!x);
  const origins = new Set<string>();
  let self = false;
  for (const r of refs) {
    if (r.startsWith("/asset/")) self = true;
    else {
      try {
        origins.add(new URL(r).origin);
      } catch {
        // validated upstream; ignore
      }
    }
  }
  if (cfg.widgets.some((w) => w.type === "bookmarks" && w.favicons)) {
    origins.add("https://icons.duckduckgo.com");
  }
  if (cfg.widgets.some((w) => w.type === "youtube" && w.thumbnails)) {
    origins.add("https://i.ytimg.com");
  }
  for (const w of cfg.widgets) {
    if (w.type !== "image") continue;
    if (w.imageOrigin) origins.add(w.imageOrigin);
    else if (w.url?.startsWith("/asset/")) self = true;
    else if (w.url) {
      try {
        origins.add(new URL(w.url).origin);
      } catch {
        // validated upstream
      }
    }
  }
  // 'self' is unconditional: every page links its own /favicon.svg, and
  // uploads are served from /asset/. Emitting only third-party origins
  // (or omitting img-src entirely, falling back to default-src 'none')
  // had the page blocking its own favicon.
  void self;
  return `; img-src 'self'${origins.size ? ` ${[...origins].join(" ")}` : ""}`;
}
import { html, SafeHtml } from "./html";
import { getModule, WIDGETS } from "./widgets";
import { relativeTime } from "./widgets/shared";
import { renderHeartbeat, type RunRow } from "./push/heartbeat";
import { renderLog, type MessageRow } from "./push/log";
import { globalHeader } from "./header";

interface StateRow {
  instance_id: string;
  source_rev: number;
  payload: string | null;
  current_key: string | null;
  prev_key: string | null;
  fetched_at: number | null;
  last_error: string | null;
  // written on every attempt, success or failure; since a success also
  // clears last_error, this is the FAILING attempt's time whenever
  // last_error is set
  updated_at: number | null;
}

interface CachedPayload {
  fetchedAt: number;
  data: unknown;
}

async function loadWidgetData(env: Env, w: PullWidgetConfig, row: StateRow | undefined): Promise<
  { payload: CachedPayload | null; error: string | null }
> {
  const error = row?.last_error ?? null;
  if (!row) return { payload: null, error };
  // Payload lives in the row itself, written atomically with the publish
  // fence - always the current source revision or NULL.
  if (row.payload !== null) {
    try {
      return { payload: JSON.parse(row.payload) as CachedPayload, error };
    } catch {
      // fall through to the legacy KV path
    }
  }
  const revPrefix = `data:${w.id}:${row.source_rev}:`;
  // Legacy fallback for rows that predate the D1-payload migration: KV
  // pointers, current first, previous only within the same source revision.
  for (const key of [row.current_key, row.prev_key]) {
    if (!key || !key.startsWith(revPrefix)) continue;
    const raw = await env.CACHE.get(key);
    if (raw !== null) {
      try {
        return { payload: JSON.parse(raw) as CachedPayload, error };
      } catch {
        continue;
      }
    }
  }
  return { payload: null, error };
}

// A card's classes: "widget", its type (so per-widget CSS can scope), and
// the opt-in expand flag that lets it take a column's leftover height.
function cardClass(w: { type: string; expand?: boolean }, extra?: string): string {
  const type = extra ?? WIDGETS[w.type]?.sectionClass ?? w.type;
  return ["widget", type, w.expand ? "expand" : ""].filter(Boolean).join(" ");
}

function accentStyle(w: { accent?: string }): string {
  return w.accent ? `--accent:${cssColor(w.accent)}` : "";
}

// How far past its own interval a card's data must be before the stamp
// calls itself overdue. Generous: one missed sweep is normal (a source
// blips, the lease is held), three in a row is a stopped pipeline.
const OVERDUE_FACTOR = 3;

// The freshness stamp, in the three states a pull card can be in. A
// failed attempt writes only last_error - payload and fetched_at survive
// untouched - so the stamp is ALWAYS the last success. Saying so matters
// only when a failure is on screen with it: a bare "updated 3h ago" under
// a red line reads as if the failure were 3h old.
//
// The failure's DETAIL rides in the stamp's tooltip rather than in the
// card body. A fetch error is diagnostics about the card, not content of
// it, and a stack-trace-ish line pushed the real content down (or out of
// a fit-screen column) every time a source blipped. The stamp still turns
// red on its own, so the card announces the trouble without spending
// space on it; the text is one hover - or one click through to the
// activity log - away.
function stamp(
  w: PullWidgetConfig,
  fetchedAt: number,
  error: string | null,
  errorAt: number | null,
  now: number,
): { text: string; cls: string; title: string } {
  if (error !== null) {
    return {
      text: `showing data from ${relativeTime(fetchedAt)}`,
      cls: "stamp-stale",
      title: `last fetch failed${errorAt ? ` ${relativeTime(errorAt)}` : ""}: ${error}`,
    };
  }
  // No error recorded and yet far past due: the silent failure - a sweep
  // that stopped running records nothing, so nothing else surfaces it.
  if (w.refreshSeconds > 0 && now - fetchedAt > w.refreshSeconds * 1000 * OVERDUE_FACTOR) {
    return {
      text: `updated ${relativeTime(fetchedAt)} · overdue`,
      cls: "stamp-stale",
      title: `last successful refresh ${relativeTime(fetchedAt)} - well past the ${
        w.refreshSeconds >= 3600 ? `${Math.round(w.refreshSeconds / 3600)}h` : `${Math.round(w.refreshSeconds / 60)}m`
      } refresh interval, and nothing was recorded as failing`,
    };
  }
  return { text: `updated ${relativeTime(fetchedAt)}`, cls: "", title: "" };
}

// A card that has NEVER fetched successfully has no freshness to stamp,
// so the failure would have nowhere to live once it left the body. It
// gets a stamp of its own - the one case where the stamp reports the
// failing attempt's time rather than a success.
function failedStamp(error: string, errorAt: number | null): { text: string; cls: string; title: string } {
  return {
    text: `fetch failed${errorAt ? ` ${relativeTime(errorAt)}` : ""}`,
    cls: "stamp-stale",
    title: error,
  };
}

function widgetSection(
  w: PullWidgetConfig,
  payload: CachedPayload | null,
  error: string | null,
  refresh = false,
  errorAt: number | null = null,
): SafeHtml {
  let body: SafeHtml;
  if (payload) {
    try {
      body = getModule(w.type).render(payload.data, w);
    } catch (e) {
      body = html`<p class="error">render failed: ${String(e)}</p>`;
    }
  } else {
    body = html`<p class="pending">refresh pending…</p>`;
  }
  const mark = payload
    ? stamp(w, payload.fetchedAt, error, errorAt, Date.now())
    : error !== null
      ? failedStamp(error, errorAt)
      : null;
  return html`<section class="${cardClass(w)}" data-widget="${w.name}" data-wid="${w.id}" style="${accentStyle(w)}">
    <h2>${w.title}</h2>
    ${w.description ? html`<p class="widget-desc">${w.description}</p>` : null}
    ${body}
    ${
      mark || refresh
        ? html`<span class="meta card-stamp">${
            refresh
              ? html`<button class="w-refresh" data-refresh="${w.id}" title="Refresh now" aria-label="Refresh this widget now">↻</button>`
              : null
          }${
            mark
              ? refresh
                ? // owner: the freshness stamp is the way into this
                  // widget's own activity history, and the tooltip says
                  // what went wrong before they spend a click on it
                  html`<a class="${mark.cls ? `w-log ${mark.cls}` : "w-log"}" href="/settings/log?widget=${w.id}" title="${mark.title || "Activity log for this widget"}">${mark.text}</a>`
                : // a healthy stamp needs no wrapper - only a marked one does
                  mark.cls
                  ? html`<span class="${mark.cls}" title="${mark.title}">${mark.text}</span>`
                  : html`${mark.text}`
              : null
          }</span>`
        : null
    }
  </section>`;
}

// The standard card shell around a static widget's body. The def's
// renderStatic returns only the body; the extra section class defaults to
// the type id (iframe opts out via sectionClass: "").
function staticSection(w: StaticWidgetConfig): SafeHtml {
  const def = WIDGETS[w.type];
  return html`<section class="${cardClass(w, def?.sectionClass)}" data-widget="${w.name}" data-wid="${w.id}" style="${accentStyle(w)}">
    <h2>${w.title}</h2>
    ${w.description ? html`<p class="widget-desc">${w.description}</p>` : null}
    ${def?.renderStatic?.(w) ?? null}
  </section>`;
}

// Search forms GET to their engine's origin; the CSP must name each one.
export function formActionFor(cfg: DashConfig): string {
  const origins = [
    ...new Set(cfg.widgets.flatMap((w) => WIDGETS[w.type]?.cspOrigins?.(w)?.form ?? [])),
  ];
  return origins.length > 0 ? ` ${origins.join(" ")}` : "";
}

export function hasLiveWidgets(cfg: DashConfig): boolean {
  return cfg.widgets.some((w) => WIDGETS[w.type]?.liveScript === true);
}

// Renders one page's <main> content for a given (possibly draft) runtime
// config. Widgets whose instance ids have no state yet - e.g. editor drafts
// with temporary ids - naturally render the "refresh pending" placeholder.
// refreshButtons: owner sessions get a per-card force-refresh control;
// anonymous/public renders (and the editor preview, which has its own
// refresh affordance) stay inert.
export async function renderMain(env: Env, cfg: DashConfig, pageIndex: number, refreshButtons = false): Promise<SafeHtml> {
  const page = cfg.pages[pageIndex] ?? cfg.pages[0];
  if (!page) return html`<main><p class="empty">no pages configured</p></main>`;

  // Only this page's pull-widget rows - payloads are fat, and loading the
  // whole table would buffer every dashboard's data for any one page.
  const pageWidgets = page.rows.flatMap((r) => r.columns.flatMap((c) => c.widgets));
  const pullIds = pageWidgets.filter(isPullWidget).map((w) => w.id);
  const rows = new Map<string, StateRow>();
  for (let i = 0; i < pullIds.length; i += 50) {
    const chunk = pullIds.slice(i, i + 50);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
    const { results } = await env.DB
      .prepare(
        `SELECT instance_id, source_rev, payload, current_key, prev_key, fetched_at, last_error, updated_at
         FROM refresh_state WHERE instance_id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<StateRow>();
    for (const r of results) rows.set(r.instance_id, r);
  }

  const now = Date.now();
  const sections = new Map<string, SafeHtml>();
  await Promise.all(
    pageWidgets.map(async (w) => {
      if (isPullWidget(w)) {
        const row = rows.get(w.id);
        const { payload, error } = await loadWidgetData(env, w, row);
        // updated_at is the failing attempt's time whenever last_error is set
        sections.set(w.id, widgetSection(w, payload, error, refreshButtons, row?.updated_at ?? null));
        return;
      }
      if (w.type === "log") {
        const { results } = await env.DB
          .prepare(
            `SELECT msg_id, level, text, created_at FROM push_messages
             WHERE instance_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
          )
          .bind(w.id, w.limit)
          .all<MessageRow>();
        // Same freshness stamp as every other card: "updated" here is the
        // newest message that arrived.
        const lastMsg = results[0]?.created_at ?? 0;
        sections.set(
          w.id,
          html`<section class="${cardClass(w, "log")}" data-widget="${w.name}" data-wid="${w.id}" style="${accentStyle(w)}">
          <h2>${w.title}</h2>
    ${w.description ? html`<p class="widget-desc">${w.description}</p> ` : null}
          ${renderLog(w, results)}
          ${
            lastMsg
              ? html`<span class="meta card-stamp">${
                  refreshButtons
                    ? html`<a class="w-log" href="/settings/log?widget=${w.id}" title="Activity log for this widget">updated ${relativeTime(lastMsg)}</a>`
                    : html`updated ${relativeTime(lastMsg)}`
                }</span>`
              : null
          }
        </section>`,
        );
        return;
      }
      if (w.type !== "heartbeat") {
        sections.set(w.id, staticSection(w));
        return;
      }
      const { results } = await env.DB
        .prepare(
          `SELECT run_id, expected_at, started_at, timed_out_at, completed_at, completion_outcome, payload
           FROM push_runs WHERE instance_id = ?1
           ORDER BY COALESCE(expected_at, created_at) DESC LIMIT ?2`,
        )
        .bind(w.id, w.history)
        .all<RunRow>();
      // No run history yet (unsaved draft, or saved but never pinged):
      // simulate a plausible one, clearly labeled, so the card shows its
      // real shape instead of an empty waiting state.
      const simulated = results.length === 0;
      const runRows =
        simulated
          ? Array.from({ length: Math.min(w.history, 10) }, (_, i): RunRow => {
              const at = now - (i + 1) * w.schedule.intervalMs;
              const fail = i === 3;
              return {
                run_id: `sample-${i}`,
                expected_at: at,
                started_at: at,
                timed_out_at: null,
                completed_at: at + 2000,
                completion_outcome: fail ? "fail" : "success",
                payload: null,
              };
            })
          : results;
      // Heartbeats appear in the activity log too, so their cards carry
      // the same freshness stamp (linked to the log for owners) as pull
      // widgets - "updated" here means the last run that reported in.
      const lastRun = simulated ? 0 : (runRows[0]?.completed_at ?? runRows[0]?.timed_out_at ?? 0);
      sections.set(
        w.id,
        html`<section class="${cardClass(w, "")}" data-widget="${w.name}" data-wid="${w.id}" style="${accentStyle(w)}">
          <h2>${w.title}</h2>
    ${w.description ? html`<p class="widget-desc">${w.description}</p>` : null}
          ${renderHeartbeat(w, runRows, now)}
          ${simulated ? html`<span class="meta">sample data - real runs appear once your job reports in</span>` : null}
          ${
            lastRun
              ? html`<span class="meta card-stamp">${
                  refreshButtons
                    ? html`<a class="w-log" href="/settings/log?widget=${w.id}" title="Activity log for this widget">updated ${relativeTime(lastRun)}</a>`
                    : html`updated ${relativeTime(lastRun)}`
                }</span>`
              : null
          }
        </section>`,
      );
    }),
  );

  const mainTheme = effectiveTheme(cfg, pageIndex);
  const widthStyle = mainTheme.max_width
    ? `max-width:${mainTheme.max_width}px;margin-inline:auto`
    : "";
  // Fit pages: height fractions become flex-grow weights on the same
  // 12-part scale as column widths; unset rows share the leftover space.
  const setSpans = page.rows.map((r) => (r.height ? COLUMN_SPANS[r.height] : 0));
  const sumSet = setSpans.reduce((a, b) => a + b, 0);
  const unset = setSpans.filter((n) => n === 0).length;
  const defaultGrow = unset > 0 ? Math.max((12 - sumSet) / unset, 1) : 1;
  const rowStyle = (ri: number): string =>
    page.fit ? `flex-grow:${(setSpans[ri] ?? 0) > 0 ? setSpans[ri] : Number(defaultGrow.toFixed(3))}` : "";
  // A page with no widgets renders as blank space - its rows and columns
  // are invisible outside the editor. For the owner that reads as broken
  // rather than empty, so point at the way out. Anonymous visitors still
  // get the blank page: they have nothing to do about it. The editor
  // preview passes refreshButtons=false and keeps its own "+ widget"
  // affordances, so this never doubles up there.
  const emptyPage =
    refreshButtons && pageWidgets.length === 0
      ? html`<section class="widget empty-page">
      <h2>${page.name}</h2>
      <p class="empty">No widgets on this page yet.</p>
      <p><a href="/settings/editor#p=${pageIndex}">Add your first widget &rarr;</a></p>
    </section>`
      : null;

  return html`<main class="${`${page.fit ? "fit-screen" : ""}${emptyPage ? " page-empty" : ""}`.trim()}" data-page-index="${pageIndex}" style="${widthStyle}">
  ${page.description ? html`<p class="page-desc">${page.description}</p>` : null}
  ${emptyPage}
  ${emptyPage ? null : page.rows.map(
    (row, ri) => html`<div class="row${row.fill ? " row-fill" : ""}" data-row="${ri}" style="${rowStyle(ri)}">
      ${row.title ? html`<h2 class="row-title">${row.title}</h2>` : null}
      ${row.columns.map(
        (col, ci) =>
          html`<div class="col span-${COLUMN_SPANS[col.width]}" data-col="${ci}">${
            col.title ? html`<h3 class="col-title">${col.title}</h3>` : null
          }${col.widgets.map((w) => sections.get(w.id))}</div>`,
      )}
    </div>`,
  )}
</main>`;
}

export function frameSrcFor(cfg: DashConfig): string {
  const frameOrigins = [
    ...new Set(cfg.widgets.flatMap((w) => WIDGETS[w.type]?.cspOrigins?.(w)?.frame ?? [])),
  ];
  return frameOrigins.length > 0 ? `; frame-src ${frameOrigins.join(" ")}` : "";
}

// URL slugs are derived from page names (kebab-cased, deduped by position)
// so links stay clean: first page at "/", others at "/p/<slug>".
export function pageSlugs(cfg: DashConfig): string[] {
  const seen = new Set<string>();
  return cfg.pages.map((p, i) => {
    let slug =
      p.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `page-${i + 1}`;
    if (seen.has(slug)) slug = `${slug}-${i + 1}`;
    seen.add(slug);
    return slug;
  });
}

export async function renderPage(env: Env, url: URL, slug?: string, authed = true): Promise<Response> {
  const cfg = await getConfig(env);
  const slugs = pageSlugs(cfg);
  let pageIndex = 0;
  if (slug !== undefined) {
    const bySlug = slugs.indexOf(slug);
    if (bySlug === -1) return new Response("no such page", { status: 404 });
    pageIndex = bySlug;
  } else {
    const requested = Number(url.searchParams.get("page") ?? 0);
    if (Number.isInteger(requested) && requested >= 0 && requested < cfg.pages.length) pageIndex = requested;
  }
  const page = cfg.pages[pageIndex];
  const pageTheme = effectiveTheme(cfg, pageIndex);
  if (!page) return new Response("no pages configured", { status: 500 });
  if (!authed && !page.publicView) return Response.redirect(`${url.origin}/login`, 303);
  const main = await renderMain(env, cfg, pageIndex, authed);
  const navPages = cfg.pages
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => (authed || p.publicView) && (!p.hidden || i === pageIndex));
  // Public pages are marked for the OWNER only. An anonymous visitor is
  // shown nothing but public pages (see the filter above), so marking
  // every tab they can see would carry no information - and would mark
  // the rule rather than the exception.
  const pubTitle = (p: (typeof cfg.pages)[number]) =>
    p.indexable
      ? "Public - anyone with the URL can view it, and search engines may list it"
      : "Public - anyone with the URL can view it";
  // Every page gets a tab, including a lone one: "Hide from page menu" is
  // the control for a tab strip you don't want, so suppressing it by
  // count as well left single-page dashboards inconsistent (and gave the
  // public marker nowhere to live).
  const tabs = navPages.map(({ p, i }) => {
    const href = i === 0 ? "/" : `/p/${slugs[i]}`;
    const cls = i === pageIndex ? "active" : "";
    if (!authed || !p.publicView) return html`<a href="${href}" class="${cls}">${p.name}</a>`;
    const badge = html`<span class="pub-badge" aria-hidden="true" title="${pubTitle(p)}">&#127760;</span>`;
    return html`<a href="${href}" class="${cls}" aria-label="${`${p.name}, public`}">${p.name}${badge}</a>`;
  });

  const kiosk = url.searchParams.get("kiosk") === "1";
  const kioskHref = `${slug !== undefined ? `/p/${slug}` : "/"}?kiosk=1`;
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageIndex === 0 ? (pageTheme.title ?? "mindash") : `${pageTheme.title ?? "mindash"} - ${page.name}`}</title>
${page.description ? html`<meta name="description" content="${page.description}">
<meta property="og:title" content="${pageIndex === 0 ? (pageTheme.title ?? "mindash") : page.name}">
<meta property="og:description" content="${page.description}">` : null}
${pageTheme.favicon ? html`<link rel="icon" href="${pageTheme.favicon}">` : html`<link rel="icon" href="/favicon.svg" type="image/svg+xml">`}
<link rel="stylesheet" href="${av("/styles.css")}">
<link rel="stylesheet" href="${av("/custom.css")}">
<style>:root { ${new SafeHtml(themeCssVars(pageTheme))} } ${new SafeHtml(themeBodyCss(pageTheme))}</style>
${hasLiveWidgets(cfg) ? html`<script src="${av("/clock.js")}" defer></script>` : null}
<script src="${av("/ui.js")}" defer></script>
</head>
<body>
${
    kiosk
      ? null
      : html`${globalHeader("dashboard", {
          title: pageTheme.title,
          logo: pageTheme.logo,
          editHref: `/settings/editor#p=${pageIndex}`,
          authed,
        })}${
          tabs || authed
            ? html`<nav class="pages subnav">${tabs}${
                authed
                  ? html`<a href="${kioskHref}" class="fs-btn" title="Full screen (Esc exits)" aria-label="Full screen"><span
                      class="fs-icon" aria-hidden="true">⛶</span><span class="fs-label">Full screen</span></a>`
                  : null
              }</nav>`
            : null
        }`
  }
${main}
${authed ? null : html`<footer class="site-footer"><a href="https://github.com/ddyy/mindash" rel="noreferrer">made with mindash</a></footer>`}
</body>
</html>`;

  return new Response(doc.value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        `default-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'${formActionFor(cfg)}${
          "; script-src 'self'; connect-src 'self'"
        }${imgSrcFor(cfg, pageTheme)}${frameSrcFor(cfg)}`,
      "referrer-policy": "no-referrer",
      ...(page.publicView && page.indexable ? {} : { "x-robots-tag": "noindex, nofollow" }),
      "x-content-type-options": "nosniff",
      // Authed pages are never cached; anonymous PUBLIC pages get a short
      // browser TTL so refreshes and repeat visitors don't spend Worker
      // invocations on unchanged HTML (2.5 min < the 5-min auto-refresh).
      "cache-control": authed ? "no-store" : "public, max-age=150",
    },
  });
}
