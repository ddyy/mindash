import { html, SafeHtml } from "./html";

// One global row shared by dashboard, editor, and settings: brand +
// where-am-I links. Surface-specific tools live in a secondary row below.
export interface HeaderOpts {
  title?: string;
  logo?: string;
  dashHref?: string;
  editHref?: string;
  authed?: boolean; // false = brand only (public dashboard views)
}

// Small inline icons, stroked/filled with currentColor so they follow the
// pill's text color (muted -> hover -> accent) in every theme. Decorative:
// the text label stays, so they're aria-hidden.
const NAV_ICONS = {
  dashboard: new SafeHtml(
    `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="1" y="1" width="6" height="6" rx="1.2"/><rect x="9" y="1" width="6" height="6" rx="1.2"/><rect x="1" y="9" width="6" height="6" rx="1.2"/><rect x="9" y="9" width="6" height="6" rx="1.2"/></svg>`,
  ),
  edit: new SafeHtml(
    `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.1 1.9a2 2 0 0 1 2.9 2.9l-8.8 8.8-3.9 1 1-3.9zM10 4.4l1.6 1.6"/></svg>`,
  ),
  settings: new SafeHtml(
    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M1.5 4.5h13M1.5 11.5h13"/><circle cx="6" cy="4.5" r="2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="11.5" r="2" fill="currentColor" stroke="none"/></svg>`,
  ),
};

// The three views, in this order, on every authenticated surface - only
// which one is marked active changes, so the nav never moves under the
// reader. Public dashboard views (authed: false) get the brand alone.
const VIEWS = [
  { key: "dashboard", id: "nav-dashboard", label: "Dashboard", icon: NAV_ICONS.dashboard },
  { key: "edit", id: "nav-edit", label: "Edit", icon: NAV_ICONS.edit },
  { key: "settings", id: "nav-settings", label: "Settings", icon: NAV_ICONS.settings },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

export function globalHeader(active: ViewKey, opts: HeaderOpts = {}): SafeHtml {
  // Dashboard's target follows the surface: the editor points it at the
  // page being edited (its client keeps #nav-dashboard current), and
  // elsewhere it is the dashboard root.
  const href: Record<ViewKey, string> = {
    dashboard: opts.dashHref ?? "/",
    edit: opts.editHref ?? "/settings/editor",
    settings: "/settings",
  };
  // Edit and Settings mark exactly the page they sit on. The Dashboard
  // pill may point at the root while the reader is on /p/<slug>, so it
  // claims "current item in this set" rather than "current page".
  const current: Record<ViewKey, string> = { dashboard: "true", edit: "page", settings: "page" };
  return html`<header class="global-nav">
  <h1><a class="brand" href="/">${opts.logo ? html`<img class="logo" src="${opts.logo}" alt="">` : null}${opts.title ?? "mindash"}</a></h1>
  ${
    opts.authed === false
      ? null
      : html`<nav class="views" aria-label="Views">
    ${VIEWS.map((v) => {
      // Edit is a TOGGLE: pressed while editing it leaves for the
      // dashboard, the same as the Dashboard pill beside it (an unsaved
      // draft is protected by the editor's beforeunload prompt, not by
      // making the control inert). It keeps its own id - the editor's
      // page-following update points both pills at the page being edited.
      if (v.key === active && active === "edit") {
        return html`<a id="${v.id}" class="view active" href="${href.dashboard}"
          aria-current="${current[v.key]}" title="Leave the editor">${v.icon}${v.label}</a>`;
      }
      // Any other current view is a marker, not a link: re-entering it
      // would just reload the page you are on. Non-active pills stay
      // ordinary links, so the row never changes shape.
      if (v.key === active) {
        return html`<span class="view active" aria-current="${current[v.key]}">${v.icon}${v.label}</span>`;
      }
      return html`<a id="${v.id}" class="view" href="${href[v.key]}">${v.icon}${v.label}</a>`;
    })}
  </nav>`
  }
</header>`;
}
