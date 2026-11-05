// A program's way to a workflow's runs, `agentswf/client`: the types and the one error, pure. The
// engine's `client()` does the I/O. Outside the author surface: a workflow never imports it.

import type { EmitResultJson, InboxItemJson, RunStateJson } from "./records";
import type { EventData, EventsOf, OwnNames } from "./workflow/events";
import type { Ending, Located, Workflow } from "./workflow/executable";
import type { JsonValue } from "./workflow/json";

export type { Ending, EventData, EventsOf, Located };

/** The names a program may send `W`'s runs: its own events, and each `{key}:reply` it declares. */
export type Sendable<W> =
  | OwnNames<EventsOf<W>>
  | Extract<keyof EventsOf<W> & string, `${string}:reply`>;

// biome-ignore lint/suspicious/noExplicitAny: any events, as a workflow of no events is refused by `Workflow<…, EventSchemas>`.
type AnyEvents = any;

/** A workflow a program can start or read the runs of: plain or with events, giving `file`. */
export type Startable<Args extends JsonValue, Result extends JsonValue> = (
  | Workflow<Args, Result, AnyEvents>
  // Last, so a plain workflow without `file` is told that `file` is what it lacks.
  | Workflow<Args, Result>
) &
  Located;

/** What a client is given: whose runs it reaches, and what an attempt it launches inherits. */
export type ClientOptions = {
  /** The operator's home, where `~/.awf` is; absent, the program's. */
  home?: string;
  /** What a launched attempt inherits, as `awf emit`'s environment; absent, the program's. */
  environment?: Readonly<Record<string, string | undefined>>;
};

/** A program's way to a workflow's runs, each addressed by the workflow and the run's id. */
export type Client = {
  /**
   * Sends event `name` to the run `run` of `workflow`: one of its own events, which may start the
   * run, or a participant's `{key}:reply` to a run that is there. The run's state is the outcome; a
   * name, data or id the workflow refuses throws a `ClientError`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: any args, result and events: `W` itself is what is checked.
  emit<W extends Workflow<any, any, any> & Located, N extends Sendable<W>>(
    workflow: W,
    run: string,
    name: N,
    data: EventData<W, N>,
    options?: { eventId?: string; source?: string },
  ): Promise<EmitResultJson>;
  /**
   * Makes sure the run with these args exists and has been launched. Without `id`, the workflow's
   * `id(args)` names it, or else, for a workflow without `starts`, a new id does.
   */
  start<Args extends JsonValue, Result extends JsonValue>(
    workflow: Startable<Args, Result>,
    args: NoInfer<Args>,
    options?: { id?: string },
  ): Promise<StartResult<Result>>;
  /** The run `run` of `workflow`; a `ClientError` `no-run` when there is none. */
  get<Result extends JsonValue>(
    // biome-ignore lint/suspicious/noExplicitAny: any args: only the result reaches the handle.
    workflow: Startable<any, Result>,
    run: string,
  ): Promise<Run<Result>>;
  /**
   * What the workflow's runs posted and asked, oldest first, as `awf inbox --workflow --json` lists
   * it: from just after `after`, a cursor an earlier item carried, or from the start.
   */
  // biome-ignore lint/suspicious/noExplicitAny: any workflow that gives its file.
  inbox(workflow: Startable<any, any>, options?: { after?: string }): Promise<InboxItemJson[]>;
};

/**
 * What `start` did: `started` a new run; found it `exists`, launching it only if it never had an
 * attempt; `launch-failed`, the run kept for a retry; or `stuck`, its launch failed three times.
 */
export type StartResult<Result> = {
  run: Run<Result>;
  did: "started" | "exists" | "launch-failed" | "stuck";
  /** With `launch-failed`: what the attempt said before it exited. */
  error?: string;
};

/** A run, read from its files whenever asked. */
export type Run<Result> = {
  readonly id: string;
  /** `{workflow}/{id}`, as `awf runs` and `awf logs` take it. */
  readonly ref: string;
  status(): Promise<RunStatus<Result>>;
  /**
   * Resolves at the run's next rest after the call: it ends, parks, crashes or sticks; at once if
   * it isn't running. With `final`, at the first rest nothing will continue on its own. Rejects
   * when the run can't be read, or with `signal`'s reason when it aborts.
   */
  wait(options?: { final?: boolean; signal?: AbortSignal }): Promise<RunStatus<Result>>;
};

export type RunStatus<Result> = {
  /** As `awf runs` reads it: running, parked, completed, failed, interrupted, stuck, … */
  state: RunStateJson;
  /**
   * Nothing will continue it on its own: completed, stopped, cancelled, stuck; a plain run also
   * failed, timed-out, interrupted. An event run that failed is continued only by its next event
   * or `awf tick`: with neither, a final wait waits on.
   */
  final: boolean;
  /** The last attempt's, once it has ended. */
  ending?: Ending<Result>;
};

/**
 * Why a client refused a call, by what the caller got wrong: `event`, a name the workflow doesn't
 * take or data its schema refuses; `id`, a run or event id the grammar refuses, or one `id(args)`
 * returns; `no-id`, a start of a workflow with `starts` naming no run; `prepare`, a starting event
 * whose `prepare` refuses no argv, or an `id(args)` that throws; `file`, a workflow whose `file`
 * isn't the path that exports it; `project`, a workflow directly in home; `no-engine`, a project
 * with no `agentswf`, or one declared and not installed; `other-engine`, a project whose `agentswf`
 * is another version than the client's; `no-run`; `other-args`, a start of a run there with other
 * args or none recorded; `cursor`, an `after` made for another run, workflow or filter.
 */
export type ClientErrorCode =
  | "event"
  | "id"
  | "no-id"
  | "prepare"
  | "file"
  | "project"
  | "no-engine"
  | "other-engine"
  | "no-run"
  | "other-args"
  | "cursor";

/** What a client throws for a call the caller got wrong; what the run decided is a value. */
export class ClientError extends Error {
  readonly code: ClientErrorCode;
  /** The run it was about, `{workflow}/{id}`, when there was one. */
  readonly ref?: string;

  constructor(code: ClientErrorCode, message: string, ref?: string) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    if (ref !== undefined) this.ref = ref;
  }
}
