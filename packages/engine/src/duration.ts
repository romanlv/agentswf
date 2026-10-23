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
