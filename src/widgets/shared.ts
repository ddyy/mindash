export function relativeTime(raw: string | number): string {
  const t = typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Display size for the widgets whose whole point is a number you read
// across the room (clock, countdown). Sizes are relative to the card's
// own text so a themed font-size still scales them.
export const DISPLAY_SIZES = ["default", "large", "x-large"] as const;
export type DisplaySize = (typeof DISPLAY_SIZES)[number];

export function sizeClass(size: DisplaySize): string {
  return size === "default" ? "" : `size-${size.replace("-", "")}`;
}
