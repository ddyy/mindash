import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { safeFetchJson } from "../safefetch";
import css from "./weather.css";

export interface WeatherWidget extends WidgetCommon {
  type: "weather";
  latitude: number;
  longitude: number;
  location?: string; // display label from geocoding; coords stay canonical
  unit: "C" | "F"; // presentation only (default F) - fetched metric, converted at render
}

export interface WeatherData {
  tempC: number;
  code: number;
  windKmh: number;
  daily: { date: string; minC: number; maxC: number }[];
}

const CODE_LABELS: [number[], string][] = [
  [[0], "Clear"],
  [[1, 2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Fog"],
  [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "Rain"],
  [[71, 73, 75, 77, 85, 86], "Snow"],
  [[95, 96, 99], "Thunderstorm"],
];

function codeLabel(code: number): string {
  for (const [codes, label] of CODE_LABELS) if (codes.includes(code)) return label;
  return "-";
}

export async function fetchData(cfg: WeatherWidget): Promise<WeatherData> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${cfg.latitude}&longitude=${cfg.longitude}` +
    `&current=temperature_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=3`;
  const raw = (await safeFetchJson(url)) as {
    current?: { temperature_2m?: number; weather_code?: number; wind_speed_10m?: number };
    daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] };
  };
  const daily = (raw.daily?.time ?? []).slice(0, 3).map((date, i) => ({
    date,
    minC: raw.daily?.temperature_2m_min?.[i] ?? NaN,
    maxC: raw.daily?.temperature_2m_max?.[i] ?? NaN,
  }));
  return {
    tempC: raw.current?.temperature_2m ?? NaN,
    code: raw.current?.weather_code ?? -1,
    windKmh: raw.current?.wind_speed_10m ?? NaN,
    daily,
  };
}

function day(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { weekday: "short" });
}

export function render(data: WeatherData, cfg: WeatherWidget): SafeHtml {
  const f = cfg.unit === "F";
  const t = (c: number) => Math.round(f ? (c * 9) / 5 + 32 : c);
  const wind = f ? `${Math.round(data.windKmh * 0.621371)} mph` : `${Math.round(data.windKmh)} km/h`;
  return html`<div class="weather">
    ${cfg.location ? html`<span class="meta">${cfg.location}</span>` : null}
    <div class="now">
      <span class="temp">${t(data.tempC)}°${cfg.unit}</span>
      <span class="cond">${codeLabel(data.code)}</span>
      <span class="meta">wind ${wind}</span>
    </div>
    <ul class="days">
      ${data.daily.map(
        (d) => html`<li>
          <span>${day(d.date)}</span>
          <span class="meta">${t(d.minC)}° / ${t(d.maxC)}°</span>
        </li>`,
      )}
    </ul>
  </div>`;
}

export const def: WidgetDef<WeatherWidget, WeatherData> = {
  meta: {
    title: "Weather",
    icon: "🌤",
    category: "Personal",
    description: "Current conditions and 3-day range (open-meteo, no key).",
  },
  sourceFields: ["latitude", "longitude"],
  form: [
    {
      key: "location",
      label: "Location (city, state, or zip)",
      kind: "geosearch",
      prefill: "San Francisco (default - search to change)",
      help: "Search sets the coordinates; they stay fixed afterwards.",
    },
    { key: "unit", label: "Units", kind: "select", options: ["F", "C"] },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, placeholder: "30m", prefill: "30m" },
    { key: "latitude", label: "Latitude", kind: "number", required: true, advanced: true, placeholder: "37.77", prefill: "37.77" },
    { key: "longitude", label: "Longitude", kind: "number", required: true, advanced: true, placeholder: "-122.42", prefill: "-122.42" },
  ],
  parse(w, where, common, h) {
    return {
      ...common,
      refreshSeconds: h.parseInterval(w.refresh_interval, `${where}.refresh_interval`),
      type: "weather",
      latitude: h.num(w.latitude, `${where}.latitude`),
      longitude: h.num(w.longitude, `${where}.longitude`),
      location: typeof w.location === "string" && w.location.trim() ? w.location.trim().slice(0, 80) : undefined,
      unit: w.unit === "C" ? "C" : "F",
    };
  },
  fetchData,
  render,
  css,
};
