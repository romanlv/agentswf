import { durationMilliseconds, positiveDurationMilliseconds } from "@agentswf/contract/workflow";
import { deprecationLine } from "./deprecations";
import { messageOf } from "./errors";

/**
 * A flag's duration in milliseconds, longer than none: the one grammar, `"90s"`, `"1.5h"`, `"1d"`.
 * A whole number of `ms`, which the CLI took before, is read until 0.1.0 and `deprecated` told.
 */
export function parseDuration(
  value: string,
  flag: string,
  deprecated: (line: string) => void,
): number {
  const ms = /^(\d+)ms$/.exec(value);
  if (!ms) return positiveDurationMilliseconds(value, flag);
  const milliseconds = Number(ms[1]);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
    throw new Error(`${flag} is a positive duration: not ${value}`);
  deprecated(deprecationLine("duration-ms", value));
  return milliseconds;
}

/**
 * `--wait`, in seconds from none to `maxSeconds`: a duration, `"90s"`. A bare number of seconds,
 * which it took before, is read until 0.1.0 and `deprecated` told.
 */
export function parseWait(
  value: string,
  maxSeconds: number,
  deprecated: (line: string) => void,
): number {
  const bare = /^\d+(\.\d+)?$/.test(value);
  let seconds: number;
  try {
    seconds = bare ? Number(value) : durationMilliseconds(value) / 1000;
  } catch (error) {
    throw new Error(`--wait takes a duration up to ${maxSeconds}s: ${messageOf(error)}`);
  }
  if (seconds > maxSeconds) throw new Error(`--wait takes a duration up to ${maxSeconds}s`);
  if (bare) deprecated(deprecationLine("wait-seconds", value));
  return seconds;
}

/** `45s`, `6m40s`, `1h02m`. */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * When a timer given `when` is due, epoch ms, from `now`, and `when` as its record keeps it: a
 * `Duration` as given, or a `Date` as an ISO time. A workflow's grammar, apart from the CLI's
 * `parseDuration`: a wait is days long, and `1.5h` reads as written.
 */
export function parseWhen(when: unknown, now: number): { due: number; when: string } {
  if (when instanceof Date) {
    const due = when.getTime();
    if (!Number.isFinite(due)) throw new Error("a timer's time is a valid Date");
    return { due, when: when.toISOString() };
  }
  let milliseconds: number;
  try {
    milliseconds = durationMilliseconds(when);
  } catch (error) {
    throw new Error(`a timer is due in a duration or at a Date: ${messageOf(error)}`);
  }
  return { due: now + milliseconds, when: when as string };
}
