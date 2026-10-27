import type { EventSchemas, NoColonNames } from "./events";
import type { JsonValue } from "./json";
import type { EventWorkflowContext, StageOutcome, WorkflowContext, WorkflowMeta } from "./workflow";

export const WORKFLOW_KIND = "awf.workflow/v1" as const;

export type WorkflowInvocation = Readonly<{
  argv: readonly string[];
  cwd: string;
}>;

/** One stage an attempt entered: run, or reused from the attempt that ran it. */
export type StageSummary = {
  stage: string;
  source: "ran" | "reused";
  outcome: StageOutcome;
  /** The attempt that ran it. */
  attempt: number;
  /** How long it ran in this attempt: zero for a reused one. */
  spanMs: number;
  summary?: string;
  /** Its value, for a stage that returns one and succeeded. */
  value?: JsonValue;
  /** Reused from a value given rather than one a turn produced; see `StageRecord.provided`. */
  provided?: true;
};

/**
 * How an attempt ended. `interrupted` is never written: it is an attempt with no ending and no
 * process. `parked` is a run of a workflow with `events` waiting with nothing to do: the next event
 * continues it.
 */
export type AttemptOutcome = "completed" | "parked" | UnfinishedOutcome;

/**
 * How an attempt that didn't complete ended. `cancelled` is the operator stopping it, and wins over
 * the others. `timed-out` is its own deadline ending it; a deadline the workflow set and let escape
 * is `failed`. `stopped` is a stop: the workflow's, or a continue that can't go on as asked.
 */
export type UnfinishedOutcome = "stopped" | "failed" | "timed-out" | "cancelled";

/** How an attempt ended, which `report` renders. */
export type Ending<Result> =
  | { kind: "completed"; value: Result; stages: StageSummary[] }
  | {
      kind: "parked";
      stages: StageSummary[];
      /** Its last wait's label and `until`, an ISO time, which the mailbox records. */
      label?: string;
      until?: string;
    }
  | {
      kind: UnfinishedOutcome;
      /** The stage it ended in; absent between stages. */
      stage?: string;
      reason: string;
      stages: StageSummary[];
      /** The command that goes on from here. */
      continue: string;
    };

type WorkflowParts<Args extends JsonValue, Result extends JsonValue> = {
  readonly meta: WorkflowMeta;
  /**
   * Adapts operator input to the run's args. A run an event starts has no argv: it gets what
   * `prepare` makes of none, which the sender checks before it sends.
   */
  prepare(invocation: WorkflowInvocation): Args;
  /**
   * The run's id, derived from its args, such as a ticket's: unique within the workflow, letters,
   * digits, `.`, `_`, `@` and `-`, starting with a letter or digit. `awf run --id` overrides it;
   * without either, one is generated, or for a workflow with `events` the run is refused.
   */
  id?(args: Args): string;
  /**
   * Renders a completed attempt's value for a person at a terminal. Undefined, or no `present`, and
   * awf prints the JSON. An attempt that didn't complete is awf's to print: its stage, its reason
   * and the command that goes on.
   */
  present?(value: Result, ending: Ending<Result>): string | undefined;
  /**
   * A Markdown handoff of how the attempt ended for whoever acts on it, which the operator saves as
   * report.md. Called for every ending, `value` only for a completed one, so a stopped attempt can
   * hand off what its stages found. Undefined writes none.
   */
  report?(value: Result | undefined, ending: Ending<Result>): string | undefined;
};

type WithoutEvents<Args extends JsonValue, Result extends JsonValue> = {
  readonly events?: undefined;
  readonly starts?: undefined;
  readonly file?: undefined;
  run(context: WorkflowContext, args: Args): Promise<Result>;
};

/** A run of a workflow with `events` is named by its sender, takes events at `receive` and parks. */
type WithEvents<Args extends JsonValue, Result extends JsonValue, Events extends EventSchemas> = {
  /**
   * `import.meta.path`: where a sender finds the workflow, and which project its runs live in, the
   * nearest directory above it holding `.awf/`, whoever sends.
   */
  readonly file: string;
  readonly events: Events;
  /**
   * The events that start a run with an id that has none; any other is refused then. Absent, any
   * event starts one.
   */
  readonly starts?: readonly (keyof Events & string)[];
  run(context: EventWorkflowContext<Events>, args: Args): Promise<Result>;
};

/** A workflow, as its file exports it: with `events` when its runs take them. */
export type Workflow<
  Args extends JsonValue = JsonValue,
  Result extends JsonValue = JsonValue,
  Events extends EventSchemas = never,
> = { readonly kind: typeof WORKFLOW_KIND } & WorkflowParts<Args, Result> &
  ([Events] extends [never] ? WithoutEvents<Args, Result> : WithEvents<Args, Result, Events>);

/** `prepare` may be left out only by a workflow of no arguments. */
type PrepareSpec<Args extends JsonValue, Result extends JsonValue> = Omit<
  WorkflowParts<Args, Result>,
  "prepare"
> &
  ([Args] extends [null]
    ? { prepare?: WorkflowParts<Args, Result>["prepare"] }
    : { prepare: WorkflowParts<Args, Result>["prepare"] });

/**
 * Defines a workflow. One whose args are `null` may leave out `prepare`: then it takes no arguments,
 * and any argv is refused. With `events`, an event name with a colon fails `tsc`; its events are
 * concrete here, as a helper generic over them can't make the context follow them.
 */
export function defineWorkflow<
  Args extends JsonValue = null,
  Result extends JsonValue = JsonValue,
  Events extends EventSchemas = never,
>(
  spec: PrepareSpec<Args, Result> & { readonly events: NoColonNames<Events> } & Omit<
      WithEvents<Args, Result, Events>,
      "events"
    >,
): Workflow<Args, Result, Events>;
export function defineWorkflow<Args extends JsonValue = null, Result extends JsonValue = JsonValue>(
  spec: PrepareSpec<Args, Result> & WithoutEvents<Args, Result>,
): Workflow<Args, Result>;
export function defineWorkflow(spec: { readonly prepare?: unknown }): unknown {
  return { ...spec, prepare: spec.prepare ?? noArguments, kind: WORKFLOW_KIND };
}

function noArguments({ argv }: WorkflowInvocation): null {
  if (argv.length > 0) throw new Error(`this workflow takes no arguments, not ${argv.join(" ")}`);
  return null;
}

/** Whether a workflow, as a file exports it, declares `events`. */
export function isEventWorkflow(
  workflow: unknown,
): workflow is Workflow<JsonValue, JsonValue, EventSchemas> {
  return (
    typeof workflow === "object" &&
    workflow !== null &&
    (workflow as { kind?: unknown }).kind === WORKFLOW_KIND &&
    (workflow as { events?: unknown }).events !== undefined
  );
}

/**
 * Why a workflow's `events`, `starts` and `file` are not as `tsc` would have them for a file it never
 * saw; undefined when they are.
 */
export function eventWorkflowProblem(workflow: unknown): string | undefined {
  const given = workflow as Partial<Record<string, unknown>> | null;
  if (typeof given !== "object" || given === null) return "a workflow is an object";
  const events = given.events;
  if (typeof events !== "object" || events === null)
    return "a workflow with events declares them in events";
  const colon = Object.keys(events).find((each) => each.includes(":"));
  if (colon) return `events: ${colon} has a colon, which only awf's own names do`;
  const starts = given.starts;
  if (
    starts !== undefined &&
    (!Array.isArray(starts) ||
      starts.length === 0 ||
      starts.some((each) => typeof each !== "string" || !(each in events)))
  )
    return "starts lists the events, by their names, that start a run; absent, every event does";
  if (typeof given.file !== "string") return "a workflow with events gives file: import.meta.path";
  return undefined;
}
