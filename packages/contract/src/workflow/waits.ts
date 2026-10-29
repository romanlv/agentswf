import type { EventId, Matched, WorkflowEvent } from "./events";

/**
 * A length of time: days, hours or minutes, `"14d"`, `"4h"`, `"1.5h"`. A typo of the unit fails
 * `tsc`; a number that isn't a plain positive one, such as `"-2d"`, throws where it is given.
 */
export type Duration = `${number}d` | `${number}h` | `${number}m`;

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

/** What `is(e)` reads of an event. */
export type EventLike = { readonly name: string; readonly from: string; readonly data?: unknown };

/**
 * A due time recorded once under a name. The first call names the time; a later one under the
 * name, in this attempt or another, gets the recorded timer. Due, it fires into the mailbox as
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

export interface WaitOptions {
  /** What `awf runs` shows while the run waits here or is parked at this wait. */
  label?: string;
}

export interface SelectOptions {
  /** As a wait's label; a function is asked again at each wait. */
  label?: string | (() => string);
}
