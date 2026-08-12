import type { LogWidget } from "../config";
import { html, type SafeHtml } from "../html";
import { relativeTime } from "../widgets/shared";

// Log widget rendering: lines pushed to /push/<name>, newest first. Text
// is plain data through the escaping template - nothing from the wire can
// become markup.

export interface MessageRow {
  msg_id: string;
  level: string;
  text: string;
  created_at: number;
}

export const LOG_LEVELS = new Set(["info", "warn", "error"]);

export function renderLog(w: LogWidget, rows: MessageRow[]): SafeHtml {
  if (rows.length === 0) {
    return html`<p class="empty">No messages yet.</p>
      <span class="meta">POST text to <code>/push/${w.name}</code> with its bearer token.</span>`;
  }
  return html`<ul class="log-list">
    ${rows.map((r) => {
      const level = LOG_LEVELS.has(r.level) ? r.level : "info";
      return html`<li class="lvl-${level}">
        <span class="log-dot" title="${level}"></span>
        <span class="log-text">${r.text}</span>
        <span class="meta">${relativeTime(r.created_at)}</span>
      </li>`;
    })}
  </ul>`;
}
