import type { WidgetCommon, WidgetDef } from "./def";
import { html, safeUrl, type SafeHtml } from "../html";
import { safeFetchJson } from "../safefetch";
import { relativeTime } from "./shared";

export interface HackerNewsWidget extends WidgetCommon {
  type: "hackernews";
  limit: number;
}

export interface HnData {
  stories: { id: number; title: string; url: string; score: number; comments: number; time: number }[];
}

const API = "https://hacker-news.firebaseio.com/v0";

export async function fetchData(cfg: HackerNewsWidget): Promise<HnData> {
  const top = (await safeFetchJson(`${API}/topstories.json`)) as number[];
  const ids = top.slice(0, cfg.limit);
  const stories = await Promise.all(
    ids.map(async (id) => {
      const it = (await safeFetchJson(`${API}/item/${id}.json`)) as {
        id?: number;
        title?: string;
        url?: string;
        score?: number;
        descendants?: number;
        time?: number;
      } | null;
      if (!it?.title) return null;
      return {
        id,
        title: it.title,
        url: it.url ?? `https://news.ycombinator.com/item?id=${id}`,
        score: it.score ?? 0,
        comments: it.descendants ?? 0,
        time: (it.time ?? 0) * 1000,
      };
    }),
  );
  return { stories: stories.filter((s): s is NonNullable<typeof s> => s !== null) };
}

export function render(data: HnData, _cfg: HackerNewsWidget): SafeHtml {
  if (data.stories.length === 0) return html`<p class="empty">No stories.</p>`;
  return html`<ul class="feed">
    ${data.stories.map(
      (s) => html`<li>
        <a href="${safeUrl(s.url)}" rel="noreferrer">${s.title}</a>
        <span class="meta">
          ${s.score} pts ·
          <a class="quiet" href="${safeUrl(`https://news.ycombinator.com/item?id=${s.id}`)}" rel="noreferrer"
            >${s.comments} comments</a
          >
          · ${relativeTime(s.time)}
        </span>
      </li>`,
    )}
  </ul>`;
}

export const def: WidgetDef<HackerNewsWidget, HnData> = {
  meta: {
    title: "Hacker News",
    icon: "🟧",
    category: "Feeds",
    description: "Top stories with points and comment counts.",
  },
  sourceFields: [],
  form: [
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, placeholder: "15m", prefill: "15m" },
    { key: "limit", label: "Stories to show", kind: "number", advanced: true, placeholder: "10" },
  ],
  parse(w, where, common, h) {
    return {
      ...common,
      refreshSeconds: h.parseInterval(w.refresh_interval, `${where}.refresh_interval`),
      type: "hackernews",
      limit: Math.min(Math.max(1, Math.trunc(h.num(w.limit ?? 10, `${where}.limit`))), 20),
    };
  },
  fetchData,
  render,
};
