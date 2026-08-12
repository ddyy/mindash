import type { WidgetCommon, WidgetDef } from "./def";
import { html, type SafeHtml } from "../html";
import { safeFetchText } from "../safefetch";
import { relativeTime } from "./shared";
import { decodeEntities } from "./rss";
import css from "./youtube.css";

// Latest videos from YouTube channels or playlists via the keyless RSS
// feeds (youtube.com/feeds/videos.xml). Video links and thumbnails are
// DERIVED from the validated 11-char video id - no URL from the feed body
// is ever emitted, so the CSP image origin (i.ytimg.com) holds by
// construction.
export interface YoutubeWidget extends WidgetCommon {
  type: "youtube";
  // UC… channel ids or UU…/PL… playlist ids; label is the human name the
  // editor's picker captured (shown in the editor and as the merge source)
  channels: { id: string; label?: string }[];
  limit: number;
  thumbnails: boolean;
  filter: "all" | "videos" | "shorts"; // channels only; playlists are taken as-is
}

export interface YoutubeData {
  videos: { id: string; title: string; published?: string; views?: number; source?: string }[];
}

const CHANNEL_ID = /^(UC|UU|PL)[A-Za-z0-9_-]{10,40}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function feedUrl(entry: string, filter: YoutubeWidget["filter"] = "all"): string {
  // Channel uploads have derived playlists YouTube maintains itself:
  // UULF<x> = long-form only, UUSH<x> = Shorts only (x = the UC id's tail).
  // That's the ONLY reliable Shorts signal - feeds carry no duration.
  if (entry.startsWith("UC") && filter !== "all") {
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${filter === "videos" ? "UULF" : "UUSH"}${entry.slice(2)}`;
  }
  const param = entry.startsWith("UC") ? "channel_id" : "playlist_id";
  return `https://www.youtube.com/feeds/videos.xml?${param}=${entry}`;
}

function tagText(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? decodeEntities((m[1] ?? "").trim()).trim() : undefined;
}

// Feed title (channel/playlist name) + entries with video id, title,
// published date, and view count from the Media RSS statistics block.
export function parseYtFeed(xml: string, limit: number): { source?: string; videos: YoutubeData["videos"] } {
  const head = xml.slice(0, xml.search(/<entry[\s>]/) === -1 ? xml.length : xml.search(/<entry[\s>]/));
  const source = tagText(head, "title");
  const videos: YoutubeData["videos"] = [];
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    if (videos.length >= limit) break;
    const block = m[0];
    const id = tagText(block, "yt:videoId");
    const title = tagText(block, "title");
    if (!id || !VIDEO_ID.test(id) || !title) continue;
    const published = tagText(block, "published");
    const viewsRaw = /<media:statistics[^>]*views="(\d+)"/i.exec(block)?.[1];
    const views = viewsRaw !== undefined ? Number(viewsRaw) : undefined;
    videos.push({ id, title, published, views });
  }
  return { source, videos };
}

export async function fetchData(cfg: YoutubeWidget): Promise<YoutubeData> {
  const multi = cfg.channels.length > 1;
  const results = await Promise.allSettled(
    cfg.channels.map(async (c) => {
      const xml = await safeFetchText(feedUrl(c.id, cfg.filter), {
        accept: ["application/atom+xml", "application/xml", "text/xml"],
      });
      const { source, videos } = parseYtFeed(xml, cfg.limit);
      return multi ? videos.map((v) => ({ ...v, source: c.label ?? source })) : videos;
    }),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<YoutubeData["videos"]> => r.status === "fulfilled");
  if (ok.length === 0) {
    const first = results[0];
    throw new Error(first && first.status === "rejected" ? String(first.reason?.message ?? first.reason) : "no feeds fetched");
  }
  // merge newest-first, same discipline as the RSS widget
  const videos = ok
    .flatMap((r) => r.value)
    .map((v, i) => ({ v, i, ts: v.published ? Date.parse(v.published) : NaN }))
    .sort((a, b) => {
      if (Number.isNaN(a.ts) && Number.isNaN(b.ts)) return a.i - b.i;
      if (Number.isNaN(a.ts)) return 1;
      if (Number.isNaN(b.ts)) return -1;
      return b.ts - a.ts;
    })
    .slice(0, cfg.limit)
    .map((x) => x.v);
  return { videos };
}

export function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M views`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k views`;
  return `${n} views`;
}

export function render(data: YoutubeData, cfg: YoutubeWidget): SafeHtml {
  if (data.videos.length === 0) return html`<p class="empty">No videos.</p>`;
  return html`<ul class="yt-list">
    ${data.videos.map((v) => {
      const watch = `https://www.youtube.com/watch?v=${v.id}`;
      const meta = [
        v.published ? relativeTime(v.published) : "",
        v.views !== undefined ? formatViews(v.views) : "",
        v.source ?? "",
      ].filter(Boolean);
      return html`<li>
        ${cfg.thumbnails
          ? html`<a class="yt-thumb" href="${watch}" rel="noreferrer" tabindex="-1" aria-hidden="true"><img src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="" loading="lazy" width="104" height="58"></a>`
          : null}
        <span class="yt-info">
          <a href="${watch}" rel="noreferrer">${v.title}</a>
          ${meta.length ? html`<span class="meta">${meta.join(" · ")}</span>` : null}
        </span>
      </li>`;
    })}
  </ul>`;
}

export const def: WidgetDef<YoutubeWidget, YoutubeData> = {
  meta: {
    title: "YouTube channel",
    icon: "\u{1F4FA}",
    defaultTitle: "YouTube",
    category: "Feeds",
    description: "Latest videos from channels or playlists - keyless, via YouTube's RSS feeds.",
  },
  // thumbnails is source-scope like bookmark favicons: enabling it makes
  // every viewer contact i.ytimg.com with the listed video ids
  sourceFields: ["channels", "channel", "thumbnails"],
  form: [
    {
      key: "channels",
      label: "Channels",
      kind: "strlist",
      search: "youtube",
      placeholder: "UC… channel id or PL… playlist id",
      help: "Up to 4 merge newest-first. Search below by @handle or channel URL - ids are also typable.",
    },
    { key: "refresh_interval", label: "Refresh every", kind: "interval", required: true, placeholder: "1h", prefill: "1h" },
    {
      key: "thumbnails",
      label: "Thumbnails",
      kind: "select",
      options: ["shown", "hidden"],
      help: "Thumbnails load from YouTube's image host (i.ytimg.com).",
    },
    {
      key: "filter",
      label: "Content",
      kind: "select",
      options: ["all", "videos", "shorts"],
      help: "videos = uploads without Shorts. Applies to channels; playlists are taken as-is.",
    },
    { key: "limit", label: "Videos to show", kind: "number", advanced: true, placeholder: "5" },
  ],
  parse(w, where, common, h) {
    // entries are bare id strings or {id, label} from the editor's picker
    const raw = w.channels ?? w.channel;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/).filter(Boolean) : [];
    if (list.length === 0) throw new Error(`${where}: at least one channel or playlist id required`);
    if (list.length > 4) throw new Error(`${where}: at most 4 entries`);
    const channels = list.map((entry, i) => {
      const o: Record<string, unknown> =
        typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : { id: entry };
      const id = h.str(o.id, `${where}.channels[${i}].id`).trim();
      if (!CHANNEL_ID.test(id)) throw new Error(`${where}.channels[${i}]: bad entry "${id.slice(0, 20)}"`);
      const label = typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 60) : undefined;
      return { id, ...(label ? { label } : {}) };
    });
    return {
      ...common,
      refreshSeconds: h.parseInterval(w.refresh_interval, `${where}.refresh_interval`),
      type: "youtube",
      channels,
      // same dual raw form as bookmark favicons: "hidden" from the editor
      // select, false from MCP/YAML; anything else (unset included) is on
      thumbnails: !(w.thumbnails === "hidden" || w.thumbnails === false),
      filter: w.filter === "videos" || w.filter === "shorts" ? w.filter : "all",
      limit: Math.min(Math.max(1, Math.trunc(h.num(w.limit ?? 5, `${where}.limit`))), 15),
    };
  },
  fetchData,
  render,
  css,
};
