import { html } from "./html";
import { av } from "./assetversion";
import { seedRaw, type RawDoc } from "./config";
import { publishConfig } from "./configstore";
import { csrfToken } from "./settings";
import setupClient from "./setup.client.js";
import type { SessionInfo } from "./auth/session";

// First-run setup (plan: "claim, then choose"). A fresh instance holds a
// placeholder document until its owner picks a timezone and decides
// whether to start from the example dashboard - so the seed's San
// Francisco weather and UTC calendars are never silently imposed, and an
// unclaimed instance never publishes a full dashboard to whoever finds
// it first.
//
// The placeholder is a real, valid document (every config reader keeps
// working) whose single note names the state. It is also the guard: setup
// may only overwrite a document that is still the placeholder.

export const SETUP_JS: string = setupClient;

const PLACEHOLDER_NAME = "setup-placeholder";

export function placeholderDoc(): unknown {
  return {
    theme: {},
    pages: [
      {
        name: "Home",
        rows: [
          {
            columns: [
              {
                width: "full",
                widgets: [
                  {
                    name: PLACEHOLDER_NAME,
                    type: "note",
                    title: "Welcome to mindash",
                    text:
                      "This instance has no owner yet.\n\n" +
                      "Create the first passkey to claim it, then finish setup - " +
                      "you will pick a timezone and choose whether to start from " +
                      "the example dashboard or an empty one.",
                    render: "markdown",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

// True while the document is untouched first-run scaffolding. Anything
// else - even a single edit - means setup has no business overwriting it.
export function isPlaceholderDoc(doc: RawDoc): boolean {
  const widgets = doc.pages.flatMap((p) => p.rows.flatMap((r) => r.columns.flatMap((c) => c.widgets)));
  return widgets.length === 1 && String(widgets[0]?.name) === PLACEHOLDER_NAME;
}

// Where the example dashboard's weather starts. Absent leaves the seed's
// San Francisco exactly as shipped.
export interface SetupPlace {
  latitude: number;
  longitude: number;
  label?: string;
  unit: "C" | "F";
}

// The document setup publishes: examples or bare, both stamped with the
// chosen zone. With examples, the local zone leads the world clock and
// the place (when known) moves the weather card - so the dashboard opens
// on the user's own time and sky rather than San Francisco's.
export function setupDoc(
  timezone: string | undefined,
  withExamples: boolean,
  place?: SetupPlace,
): unknown {
  if (!withExamples) {
    return {
      theme: {},
      ...(timezone ? { timezone } : {}),
      pages: [{ name: "Home", rows: [{ columns: [{ width: "full", widgets: [] }] }] }],
    };
  }
  const seed = seedRaw() as Record<string, unknown>;
  const doc = JSON.parse(JSON.stringify(seed)) as {
    timezone?: string;
    pages: { rows: { columns: { widgets: Record<string, unknown>[] }[] }[] }[];
  };
  if (timezone) doc.timezone = timezone;
  for (const p of doc.pages ?? []) {
    for (const r of p.rows ?? []) {
      for (const c of r.columns ?? []) {
        for (const w of c.widgets ?? []) {
          if (timezone && w.type === "clock" && Array.isArray(w.clocks)) {
            const clocks = w.clocks as { label?: string; tz?: string }[];
            if (!clocks.some((k) => k.tz === timezone)) {
              const city = (timezone.split("/").pop() ?? timezone).replace(/_/g, " ");
              w.clocks = [{ label: city, tz: timezone }, ...clocks].slice(0, 8);
            }
          }
          if (place && w.type === "weather") {
            w.latitude = place.latitude;
            w.longitude = place.longitude;
            w.unit = place.unit;
            if (place.label) w.location = place.label;
            else delete w.location; // never keep "San Francisco" over new coordinates
          }
        }
      }
    }
  }
  return doc;
}

function page(body: ReturnType<typeof html>): Response {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mindash - setup</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${av("/styles.css")}">
</head>
<body>
<header><h1>mindash</h1><span class="updated">setup</span></header>
<main class="center-prompt">${body}</main>
<script src="${av("/setup.js")}"></script>
</body>
</html>`;
  return new Response(doc.value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

interface CfGeo {
  timezone?: string;
  city?: string;
  country?: string;
  latitude?: string | number;
  longitude?: string | number;
}

function cf(req: Request): CfGeo {
  return ((req as { cf?: CfGeo }).cf ?? {}) as CfGeo;
}

// Geo-IP is the no-JS default; /setup.js overrides it with the browser's
// own zone when they disagree.
function cfTimezone(req: Request): string {
  const tz = cf(req).timezone;
  if (typeof tz !== "string" || !tz) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "";
  }
}

// Fahrenheit's remaining holdouts; everyone else gets Celsius. The
// weather widget's own default is F, which is wrong for most installs.
const FAHRENHEIT = new Set(["US", "BS", "BZ", "KY", "PW", "FM", "MH", "LR"]);

function cfUnit(req: Request): "C" | "F" {
  const country = cf(req).country;
  return typeof country === "string" && FAHRENHEIT.has(country.toUpperCase()) ? "F" : "C";
}

function cfCoords(req: Request): { latitude: number; longitude: number } | undefined {
  const { latitude, longitude } = cf(req);
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return undefined;
  return { latitude: lat, longitude: lon };
}

// One-shot city lookup for the setup form. The editor has its own
// interactive picker (editorGeocode); this is the non-interactive twin -
// first hit wins, and any failure falls back to the geo-IP coordinates
// rather than blocking setup.
async function geocodeCity(name: string): Promise<{ latitude: number; longitude: number; label: string } | undefined> {
  const { safeFetchJson } = await import("./safefetch");
  try {
    const raw = (await safeFetchJson(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`,
    )) as { results?: { name: string; admin1?: string; latitude: number; longitude: number }[] };
    const hit = raw.results?.[0];
    if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) return undefined;
    return { latitude: hit.latitude, longitude: hit.longitude, label: hit.name };
  } catch {
    return undefined;
  }
}

export async function setupPage(req: Request, session: SessionInfo, error?: string): Promise<Response> {
  const csrf = await csrfToken(session);
  const detected = cfTimezone(req);
  const city = typeof cf(req).city === "string" ? (cf(req).city as string) : "";
  const unit = cfUnit(req);
  return page(html`<section class="widget">
    <h2>Finish setup</h2>
    <p class="meta">Everything here is changeable later in the editor.</p>
    ${error ? html`<p class="meta" style="color:var(--negative)">${error}</p>` : null}
    <form method="post" action="/setup">
      <input type="hidden" name="csrf" value="${csrf}">
      <p>
        <label for="timezone">Timezone</label><br>
        <input id="timezone" name="timezone" type="text" value="${detected}"
               placeholder="America/New_York" autocomplete="off" style="width:100%">
        <span id="tz-note" class="meta">Clocks, countdowns, and calendars use this by default.</span>
      </p>
      <p>
        <label><input type="radio" name="examples" value="yes" checked> Start with example widgets</label><br>
        <span class="meta">A working dashboard to edit: news, weather, clocks, and more.</span>
      </p>
      <div id="weather-block">
        <p>
          <label for="city">Weather location</label><br>
          <input id="city" name="city" type="text" value="${city}"
                 placeholder="Amsterdam" autocomplete="off" style="width:100%">
          <span class="meta">Guessed from your connection, so check it - a VPN moves it.</span>
        </p>
        <p>
          <label for="unit">Temperature</label>
          <select id="unit" name="unit">
            <option value="C" ${unit === "C" ? "selected" : ""}>Celsius</option>
            <option value="F" ${unit === "F" ? "selected" : ""}>Fahrenheit</option>
          </select>
        </p>
      </div>
      <p>
        <label><input type="radio" name="examples" value="no"> Start empty</label><br>
        <span class="meta">One blank page. Add widgets from the gallery yourself.</span>
      </p>
      <p><button type="submit" class="primary">Create my dashboard</button></p>
    </form>
  </section>`);
}

export async function setupApply(req: Request, env: Env, session: SessionInfo): Promise<Response> {
  const form = await req.formData();
  if (String(form.get("csrf") ?? "") !== (await csrfToken(session))) {
    return setupPage(req, session, "stale form (CSRF token mismatch)");
  }
  const { getCurrentConfig } = await import("./config");
  const { doc, version } = await getCurrentConfig(env);
  if (!isPlaceholderDoc(doc)) {
    return page(html`<section class="widget">
      <h2>Already set up</h2>
      <p class="meta">This dashboard has content, so setup will not overwrite it. Edit it in the editor instead.</p>
      <p><a href="/">Open dashboard</a> · <a href="/settings/editor">Open editor</a></p>
    </section>`);
  }
  const raw = String(form.get("timezone") ?? "").trim();
  let timezone: string | undefined;
  if (raw) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw });
      timezone = raw;
    } catch {
      return setupPage(req, session, `unknown timezone "${raw.slice(0, 40)}" - use an IANA name like America/New_York`);
    }
  }
  const withExamples = String(form.get("examples") ?? "yes") !== "no";
  // Weather only matters for the example dashboard - the empty start has
  // no card to place. A typed city is geocoded; anything that fails to
  // resolve falls back to the geo-IP coordinates, and if those are
  // missing too the seed's own location stands.
  let place: SetupPlace | undefined;
  if (withExamples) {
    const unit = String(form.get("unit") ?? "") === "F" ? "F" : "C";
    const typed = String(form.get("city") ?? "").trim().slice(0, 60);
    const coords = cfCoords(req);
    const hit = typed ? await geocodeCity(typed) : undefined;
    if (hit) place = { latitude: hit.latitude, longitude: hit.longitude, label: hit.label, unit };
    else if (coords) place = { ...coords, ...(typed ? { label: typed } : {}), unit };
    else if (typed) place = undefined; // unresolvable name, no fallback coords: leave the seed alone
  }
  const epoch =
    (await env.DB.prepare("SELECT epoch FROM owner_state WHERE id = 1").first<{ epoch: number }>())?.epoch ?? 1;
  const res = await publishConfig(env, {
    baseVersion: version,
    candidate: setupDoc(timezone, withExamples, place),
    actor: "setup",
    hasSources: true,
    epoch,
  });
  if (!res.ok) {
    return setupPage(req, session, `could not save: ${"error" in res ? res.error : "version conflict, try again"}`);
  }
  return Response.redirect(new URL("/", req.url).toString(), 303);
}
