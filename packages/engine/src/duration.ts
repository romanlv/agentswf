/** A duration such as `500ms`, `30s`, `20m` or `2h`, in milliseconds. */
export function parseDuration(value: string): number {
  const matched = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!matched) throw new Error(`invalid duration: ${value}`);
  const amount = Number(matched[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`invalid duration: ${value}`);
  const unit = matched[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`duration is too large: ${value}`);
  return milliseconds;
}

/** `45s`, `6m40s`, `1h02m`. */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * When a timer given `when` is due, epoch ms, from `now`, and `when` as its record keeps it: a
 * duration of days, hours or minutes as given, or a `Date` as an ISO time. A workflow's grammar,
 * apart from the CLI's `parseDuration`: a wait is days long, and `1.5h` reads as written.
 */
export function parseWhen(when: unknown, now: number): { due: number; when: string } {
  if (when instanceof Date) {
    const due = when.getTime();
    if (!Number.isFinite(due)) throw new Error("a timer's time is a valid Date");
    return { due, when: when.toISOString() };
  }
  const matched = typeof when === "string" ? /^(\d+(?:\.\d+)?)(d|h|m)$/.exec(when) : null;
  if (!matched)
    throw new Error(
      `a timer is due in days, hours or minutes, "14d", "4h", "1.5h", or at a Date; not ${String(when)}`,
    );
  const unit = matched[2] === "d" ? 86_400_000 : matched[2] === "h" ? 3_600_000 : 60_000;
  return { due: now + Math.round(Number(matched[1]) * unit), when: when as string };
}
