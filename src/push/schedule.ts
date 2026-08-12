// Schedule semantics: interval + anchor, never a bare
// `expect_every` - the anchor gives the schedule a phase, so the sweep can
// enumerate which occurrences should have existed and a ping can claim its
// occurrence deterministically. Anchor is "HH:MM" UTC.

export interface Schedule {
  intervalMs: number;
  graceMs: number;
  anchorMs: number; // offset within a UTC day
}

const DAY_MS = 24 * 3600 * 1000;
// Any fixed midnight works as the epoch base; occurrences are congruent mod interval.
const BASE = Date.UTC(2024, 0, 1);

function anchorEpoch(s: Schedule): number {
  return BASE + s.anchorMs;
}

export function parseAnchor(raw: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!m) throw new Error(`bad anchor "${raw}" (expected HH:MM UTC)`);
  return (Number(m[1]) * 3600 + Number(m[2]) * 60) * 1000;
}

// Largest expected occurrence <= t.
export function occurrenceAtOrBefore(s: Schedule, t: number): number {
  const base = anchorEpoch(s);
  return base + Math.floor((t - base) / s.intervalMs) * s.intervalMs;
}

export function nextOccurrenceAfter(s: Schedule, t: number): number {
  const at = occurrenceAtOrBefore(s, t);
  return at <= t ? at + s.intervalMs : at;
}

// The occurrence a ping arriving at t may claim, or null for manual/ad-hoc.
// Early margin lets a slightly-early ping claim the upcoming occurrence.
export function claimableOccurrence(s: Schedule, t: number, activatedAt: number): number | null {
  const early = Math.min(Math.round(s.intervalMs * 0.1), 5 * 60 * 1000);
  const exp = occurrenceAtOrBefore(s, t + early);
  if (exp < activatedAt) return null;
  return exp;
}

export function describeAnchor(anchorMs: number): string {
  const mins = Math.round((anchorMs % DAY_MS) / 60000);
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
}
