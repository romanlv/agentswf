import {
  durationMilliseconds,
  positiveDurationMilliseconds,
  secondsForMilliseconds,
} from "@agentswf/contract/workflow";
import { messageOf } from "./errors";

/**
 * A flag's duration in milliseconds, longer than none: the one grammar, `"90s"`, `"1.5h"`, `"1d"`.
 * A number of `ms`, which the CLI took before 0.1.0-beta.6, is refused with its replacement.
 */
export function parseDuration(value: string, flag: string): number {
  const seconds = secondsForMilliseconds(value);
  if (seconds === undefined) return positiveDurationMilliseconds(value, flag);
  throw new Error(
    `${flag} is a duration, a decimal and s, m, h or d: give ${seconds}, not ${value}`,
  );
}

/**
 * `--wait`, in seconds from none to `maxSeconds`: a duration, `"90s"`. A bare number of seconds,
 * which it took before 0.1.0-beta.6, is refused with its replacement.
 */
export function parseWait(value: string, maxSeconds: number): number {
  if (/^\d+(\.\d+)?$/.test(value))
    throw new Error(
      `--wait takes a duration up to ${maxSeconds}s: give --wait ${Math.min(Number(value), maxSeconds)}s`,
    );
  let seconds: number;
  try {
    seconds = durationMilliseconds(value) / 1000;
  } catch (error) {
    throw new Error(`--wait takes a duration up to ${maxSeconds}s: ${messageOf(error)}`);
  }
  if (seconds > maxSeconds) throw new Error(`--wait takes a duration up to ${maxSeconds}s`);
  return seconds;
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
