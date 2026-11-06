import type { JsonSchema } from "../schema";
import {
  AGENT_ENDED_ID,
  awfEventOf,
  type DeclaredEvents,
  type EventSchemas,
  type NoEvents,
  type OwnNames,
  PARTICIPANT_REPLY_ID,
} from "./events";
import type { JsonValue } from "./json";
import type { StageOutcome, WorkflowContext, WorkflowMeta } from "./workflow";

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
  /** Reused from a value given rather than one a turn produced; see a stage line's `provided`. */
  provided?: true;
};

/** A stage a run can't start at a later stage without: its value, which `--values` gives. */
export type StageNeed = { stage: string; schema: JsonSchema };

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
      /** Its last wait's label and `until`, an ISO time, which its `wait` line records. */
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
      /**
       * The stages whose values `--values` must give to start part-way, in the order reached;
       * absent unless it stopped for them.
       */
      needs?: StageNeed[];
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
   * without either, one is generated, or for a workflow with `starts`, whose senders name its runs,
   * the run is refused.
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
  /**
   * `import.meta.path`: by which a program's client finds the workflow and its project, where its
   * runs are kept, whoever starts or continues them.
   */
  readonly file?: string;
  run(context: WorkflowContext<NoEvents>, args: Args): Promise<Result>;
};

/** A run of a workflow with `events` takes them at its waits, and parks between them. */
type WithEvents<
  Args extends JsonValue,
  Result extends JsonValue,
  Events extends EventSchemas,
> = EventsRun<Args, Result, Events> & { readonly events: Events } & StartsAndFile<Events>;

type EventsRun<Args extends JsonValue, Result extends JsonValue, Events extends EventSchemas> = {
  run(context: WorkflowContext<Events>, args: Args): Promise<Result>;
};

/** `file` goes with `starts`: a sender holding the workflow, as `wf.emit` does, finds it by it. */
type StartsAndFile<Events extends EventSchemas> =
  | {
      /**
       * The events that start a run with an id that has none; any other is refused then. Absent,
       * any event starts one.
       */
      readonly starts: readonly OwnNames<Events>[];
      /**
       * `import.meta.path`: where a sender holding the workflow finds it, as `wf.emit` does, and
       * which project its runs live in, the nearest directory above it holding `.awf/`.
       */
      readonly file: string;
    }
  | {
      readonly starts?: undefined;
      /** `import.meta.path`, which `wf.emit` to this workflow needs; `awf` commands find it by path. */
      readonly file?: string;
    };

/** A workflow that gives `file`, `import.meta.path`, which `defineWorkflow` keeps in its type. */
export type Located = { readonly file: string };

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
 * and any argv is refused. With `events`, a name with a colon fails `tsc` unless it is awf's,
 * `{key}:reply: ParticipantReply` or `{key}:ended: AgentEnded`, and `starts` needs `file`; its
 * events are concrete here, as a helper generic over them can't make the context follow them. One
 * that gives `file` keeps it in its type, `Located`, for a program's client; with `events`, only
 * when its type arguments are inferred, not given.
 */
export function defineWorkflow<
  Args extends JsonValue = null,
  Result extends JsonValue = JsonValue,
  Events extends EventSchemas = never,
  File extends string | undefined = string | undefined,
>(
  spec: PrepareSpec<Args, Result> & { readonly events: DeclaredEvents<Events> } & EventsRun<
      Args,
      Result,
      Events
    > &
    StartsAndFile<Events> & { readonly file?: File },
): Workflow<Args, Result, Events> & ([File] extends [string] ? Located : unknown);
export function defineWorkflow<Args extends JsonValue = null, Result extends JsonValue = JsonValue>(
  spec: PrepareSpec<Args, Result> & WithoutEvents<Args, Result> & Located,
): Workflow<Args, Result> & Located;
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
  for (const [name, schema] of Object.entries(events)) {
    if (!name.includes(":")) continue;
    const awf = awfEventOf(name);
    if (!awf)
      return `events: ${name} has a colon, which only awf's own names do: {key}:reply and {key}:ended`;
    const declared = awf.kind === "reply" ? "ParticipantReply" : "AgentEnded";
    // By its `$id`: the workflow's agentswf may be another version than the awf loading it.
    const id = awf.kind === "reply" ? PARTICIPANT_REPLY_ID : AGENT_ENDED_ID;
    if (typeof schema !== "object" || schema === null || (schema as { $id?: unknown }).$id !== id)
      return `events: ${name} is awf's, declared with its schema: "${name}": ${declared}`;
  }
  const starts = given.starts;
  if (
    starts !== undefined &&
    (!Array.isArray(starts) ||
      starts.length === 0 ||
      starts.some((each) => typeof each !== "string" || each.includes(":") || !(each in events)))
  )
    return "starts lists the events, by their names, that start a run; absent, every event does";
  if (given.file !== undefined && typeof given.file !== "string") return "file is import.meta.path";
  if (starts !== undefined && given.file === undefined)
    return "a workflow with starts gives file: import.meta.path, by which a sender finds it";
  return undefined;
}
