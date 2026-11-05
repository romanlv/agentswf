import type { EventId, Matched, WorkflowEvent } from "./events";

/**
 * A length of time: a decimal and `s`, `m`, `h` or `d`, `"90s"`, `"10m"`, `"1.5h"`, `"14d"`. A typo
 * of the unit fails `tsc`; a number that isn't a plain one, such as `"-2d"` or `"1e3s"`, throws
 * where it is given. A string read from data is checked with `duration()`.
 */
export type Duration = `${number}s` | `${number}m` | `${number}h` | `${number}d`;

const DURATION = /^(\d+(?:\.\d+)?)(s|m|h|d)$/;
const UNIT_MILLISECONDS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** Far past any wait, and short enough that now and it is still a `Date`. */
const LONGEST_DAYS = 100_000;

/** A duration's length in milliseconds, rounded; throws, saying the grammar, for anything else. */
export function durationMilliseconds(text: unknown): number {
  const matched = typeof text === "string" ? DURATION.exec(text) : null;
  if (!matched)
    throw new Error(
      `a duration is a decimal and s, m, h or d, such as "90s", "10m", "1.5h" or "14d"; not ${typeof text === "string" ? JSON.stringify(text) : String(text)}`,
    );
  const unit = matched[2] as keyof typeof UNIT_MILLISECONDS;
  const milliseconds = Math.round(Number(matched[1]) * UNIT_MILLISECONDS[unit]);
  if (milliseconds > LONGEST_DAYS * UNIT_MILLISECONDS.d)
    throw new Error(`the duration ${text} is too long: at most ${LONGEST_DAYS}d`);
  return milliseconds;
}

/**
 * As `durationMilliseconds`, for a length that must be longer than none: `what` names it in the
 * error, `"a route's timeout"`.
 */
export function positiveDurationMilliseconds(text: unknown, what: string): number {
  let milliseconds: number;
  try {
    milliseconds = durationMilliseconds(text);
  } catch (error) {
    throw new Error(`${what} is a positive duration: ${(error as Error).message}`);
  }
  if (milliseconds <= 0)
    throw new Error(`${what} is a positive duration: not ${JSON.stringify(text)}`);
  return milliseconds;
}

/**
 * A duration read from data, checked: `duration(event.data.every)`. Throws, saying the grammar, for
 * anything else.
 */
export function duration(text: unknown): Duration {
  durationMilliseconds(text);
  return text as Duration;
}

/**
 * A call's bound: how long from when it is called, or the time it ends by; `false`, none of its
 * own. Either way it never reaches past the stage, `parallel` or run around the call.
 */
export type Timeout = Duration | Date | false;

/** When a timer is due: a duration from when it is first set, or a time. */
export type When = Duration | Date;

/** Type-only: what a source hands back when a wait takes it. */
declare const TAKES: unique symbol;

/**
 * Something a wait can take: a timer, a signal, a participant's reply, an agent's turn's end. `T`
 * is what it hands back when it does. Only awf makes one, so a promise is never a source.
 */
export interface Source<T> {
  readonly [TAKES]: T;
}

/** What a source hands back of an event: its data with the event's id and arrival. */
export type Taken<T> = T & { readonly id: EventId; readonly at: string };

/** A timer's firing: its name. */
export type TimerDue = { readonly name: string };

/** A timer's event, `timer:due`, from the timer's name, `at` the time it was due. */
export type TimerDueEvent = WorkflowEvent<"timer:due", TimerDue>;

/** A time read from state, as a select returns it: `at`, the time it came for, an ISO time. */
export type TimeDue = Taken<Record<never, never>>;

/**
 * A select's branch that comes due at a time the run's state holds: `wf.at(() => …)`. Not a
 * timer: nothing is recorded under a name, and it lives as long as its loop.
 */
export interface TimeRead extends Source<TimeDue> {
  readonly [TIME_READ]: true;
}

declare const TIME_READ: unique symbol;

/** What `is(e)` reads of an event. */
export type EventLike = { readonly name: string; readonly from: string; readonly data?: unknown };

/**
 * A due time recorded once under a name. The first call names the time; a later one under the
 * name, in this attempt or another, gets the recorded timer. Due, it fires as
 * `timer:due`, which `receive` takes beside the run's other events and a race takes as its branch.
 */
export interface Timer extends Source<Taken<TimerDue>> {
  readonly name: string;
  /** When it is due, an ISO time. */
  readonly due: string;
  /** It won't fire, and a `timer:due` of it not yet taken is withdrawn; the name stays cancelled. */
  cancel(): Promise<void>;
  /** True for this timer's `timer:due`. */
  is(event: EventLike): event is TimerDueEvent & Matched;
}

/** One of the workflow's declared events, as a wait takes it. */
export interface Signal<Event extends { readonly name: string; readonly from: string }>
  extends Source<Event> {
  readonly name: string;
  /** True for an event of this name. */
  is(event: EventLike): event is Event & Matched;
}

/** A wait's branches: each a source, by the name its answer has it under. */
export type Branches = Readonly<Record<string, Source<unknown>>>;

/** A race's branches: a source, or a duration, which is a timer of the race's own. */
export type RaceBranches = Readonly<Record<string, Source<unknown> | Duration>>;

/** Race branches as a race takes them: as `Checked`, and none a time read from state, a select's. */
export type RaceChecked<B> = Checked<B> & {
  readonly [K in keyof B]: B[K] extends TimeRead ? never : B[K];
};

type ValueOf<B> = B extends Source<infer T> ? T : B extends Duration ? Taken<TimerDue> : never;

/**
 * Branches as a wait takes them: at least one, and none named `key`, which the answer uses. Of two
 * branches that take one event, the first declared takes it.
 */
export type Checked<B> = keyof B extends never
  ? never
  : B extends { readonly key: unknown }
    ? never
    : B;

/**
 * What a race or a select took: the branch's name as `key`, and what it took under that name. The
 * other branches are `undefined`, so `if (next.reply)` narrows as `switch (next.key)` does.
 */
export type Next<B> = {
  [K in keyof B & string]: { readonly key: K } & { readonly [P in K]: ValueOf<B[K]> } & {
    readonly [P in Exclude<keyof B & string, K>]?: undefined;
  };
}[keyof B & string];

/** The options of `receive`, `race` and `select`. */
export interface WaitOptions {
  /**
   * What `awf runs` shows while the run waits here or is parked at this wait. A function is asked
   * at each wait: a select's every pass.
   */
  label?: string | (() => string);
}
