import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type EventLine,
  type RunLine,
  type RunPanes,
  readRun,
  type SandboxRecord,
  type StageLine,
} from "@agentswf/contract/records";
import {
  AWF_ID_PREFIX,
  awfEventOf,
  type Duration,
  type Ending,
  type EventSchemas,
  type HarnessAllowance,
  isEventWorkflow,
  type JsonObject,
  type JsonValue,
  type KeepPane,
  type OutputOf,
  positiveDurationMilliseconds,
  type RuntimeAliases,
  WORKFLOW_KIND,
  type Workflow,
} from "@agentswf/contract/workflow";
import type { Harness } from "@agentswf/harness";
import { SCRIPTED_HOMES } from "@agentswf/harness/testing";
import { createFakeSandboxProvider } from "@agentswf/sandbox/testing/fake";
import { decideEnding, type Finished } from "../attempt-ending";
import { continueCommand } from "../attempt-view";
import { checkEvent, eventIdProblem, replyRecord } from "../emit";
import { messageOf } from "../errors";
import { isInside } from "../files";
import { appendIn, readIn } from "../in-lines";
import { OPERATOR_ALIASES } from "../operator-aliases";
import { type EarlierOps, listOps } from "../ops";
import { KEEP_PANES } from "../pane-layout";
import { claimRunLines, type RunLines, readRunLines, runLinesFile } from "../run-lines";
import type { TimerState } from "../run-policy/waits";
import { createRun, idProblem, readEvents, readTurns } from "../runs";
import { primaryFailure, type WorkflowStopped } from "../stopped";
import { RunParked, readWaits } from "../waits";
import { assertJsonValue, type EventWorkflow } from "../workflow-loader";
import type { RunnableWorkflow } from "../workflow-runner";
import { runWorkflow, type SettledRun, WorkflowRunError } from "../workflow-runner";
import { ParticipantScripts } from "./coordinators";
import { createScriptedDecisions, type DecisionRequest, type DecisionScript } from "./decisions";
import {
  type AgentSandbox,
  type CompactionRecord,
  createScriptedHost,
  type OpenedAgent,
  type SetRecord,
  type TestTurn,
} from "./host";
import {
  type MessageScript,
  MessageScripts,
  type ParticipantScript,
  type Script,
  Scripts,
} from "./script";

/**
 * What a test gives `testWorkflow`, for a workflow taking `Args`, and with `Events` when it declares
 * them. A key not listed here is refused when the test runs. Bare, `TestOptions` is what any test
 * may share, with no args or events: spread into a test's own, it gives them.
 */
export type TestOptions<
  Args extends JsonValue = never,
  Events extends EventSchemas = never,
> = CommonTestOptions & ArgsOption<Args, Events> & EventOptions<Events>;

/**
 * `args` is required where the workflow has no events and `null` is not among its args. Absent, the
 * run gets what `prepare` makes of no argv, as `awf run` given none, or a run an event starts, has.
 */
type ArgsOption<Args extends JsonValue, Events extends EventSchemas> = [Args] extends [never]
  ? { args?: undefined }
  : [Events] extends [never]
    ? null extends Args
      ? {
          /** The args `run` is given, as they are: `prepare` isn't called for them. */
          args?: Args;
        }
      : {
          /** The args `run` is given, as they are: `prepare` isn't called for them. */
          args: Args;
        }
    : {
        /**
         * Its args, as `awf run --id {id} -- {args}` would prepare them; absent, what `prepare` makes
         * of no argv, as a run an event starts has.
         */
        args?: Args;
      };

/** What only a test of a workflow with events gives: what its run starts with, and is sent. */
type EventOptions<Events extends EventSchemas> = [Events] extends [never]
  ? unknown
  : {
      /** The event the run starts with, as `awf emit` would send it; absent, it starts with none. */
      event?: {
        [Name in keyof Events & string]: { name: Name; data: OutputOf<Events[Name]> } & EventIds;
      }[keyof Events & string];
      /** Sent at points in the run, each once its point is reached. */
      events?: readonly ScriptedEvent<Events>[];
    };

/**
 * What an earlier attempt left: given, the test's attempt is that run's continue, the attempt after
 * the latest its lines name, attempt 2 when they name none later than 1.
 */
export type EarlierAttempt = {
  /**
   * The stages it recorded, by name: each value, or `undefined` for a stage that returns nothing,
   * reused without calling their work, as `awf run --continue` would. Written as attempt 1's
   * `stage` lines.
   */
  stages?: Readonly<Record<string, JsonValue | undefined>>;
  /**
   * The events senders gave the run, its `in.jsonl`, in order. A starting `event` is appended
   * after them, as the event that woke it.
   */
  events?: readonly EventLine[];
  /**
   * What the run settled, its `run.jsonl` lines, in order, after `stages`: its timers, what its
   * waits and races took, and the turns it began, as `run.run` gives them.
   */
  run?: readonly RunLine[];
};

type CommonTestOptions = {
  /** The run's id, as `awf run --id` or a sender names it; `"test"`. */
  id?: string;
  /** Laid out before the run, by path under its directory, which the test removes. */
  files?: Readonly<Record<string, FileTree>>;
  /** Each agent's script, by its key or a pattern such as `"review:*"`. */
  agents?: Readonly<Record<string, Script>>;
  /**
   * Each agent's compactions, apart from its turns: `answer("summary")` or a `noAnswer`, a list one
   * entry per compaction. An agent with none here has every compaction answer `""`.
   */
  compactions?: Readonly<Record<string, Script>>;
  /**
   * Each agent's message operations, apart from its turns, by its key or a pattern: a script for
   * all of them, or a list, one per operation. An agent a message wakes with none here fails the
   * test.
   */
  messages?: Readonly<Record<string, MessageScript | readonly MessageScript[]>>;
  /**
   * Each participant's script, by the key the workflow connects it under. When no turn runs, no
   * script is still working, and everything left waits on a participant with no `until`, the attempt
   * ends: its open questions expire `attempt-ended` and, unless the workflow returned, `run.value`
   * throws. While a question has an `until`, the test waits for the earliest, and `stall` does not
   * count that wait. A route
   * or message reaching a participant with none here fails the test.
   */
  participants?: Readonly<Record<string, ParticipantScript>>;
  /** Each decision's answers, by its key or a pattern. */
  decisions?: Readonly<Record<string, DecisionScript>>;
  /** What `wf.allowance` reads, one per harness; a harness with none here reads `none`. */
  allowance?: readonly HarnessAllowance[];
  /** Runtime aliases beside the ones `awf run` installs, `claude` and `codex`; the same name replaces one. */
  runtimes?: RuntimeAliases;
  /** The run's deadline; none unless given, as `awf run` has none unless `--timeout` gives one. */
  timeout?: Duration;
  /** Real time with no turn or decision starting or ending before the test fails; `"2s"`. */
  stall?: Duration;
  /**
   * The run's clock is virtual: where a run would park with a timer to come, the clock moves to it
   * and the timer fires, so a two-day reminder takes no time. After this many, the run parks
   * instead, as a loop of reminders nobody answers would; 20. Zero parks at the first.
   */
  maxTimers?: number;
  /** Where the agents work; by default a temporary directory, removed afterwards. */
  cwd?: string;
  /**
   * The session the run is started from, by its harness; absent, `agents.caller` and
   * `agents.forkCaller` answer `null`. It is handed over, as `awf run --here` hands one over, and its
   * turns are answered from the script under the key the workflow gives it; with `here: false` it
   * waits on the run, and `agents.caller` answers `null`. A fork of it runs on `model`, the model its
   * files show; without one, `forkCaller` answers `null`, as it does where they name none.
   */
  caller?: { harness: Harness; model?: string; here?: boolean };
  /**
   * More turns started than this fails the test, so a loop that never ends doesn't hang it; 20.
   * Nudges and wakes for a message don't count.
   */
  maxTurns?: number;
  /** What an earlier attempt left; given, the test's attempt is its continue. */
  earlier?: EarlierAttempt;
  /**
   * The stage the attempt starts at, as `--from-stage`: a continue of `earlier`, or a new run
   * started there. A workflow with events takes it only with `earlier`, as `awf run` takes it only
   * with `--continue`.
   */
  fromStage?: string;
  /**
   * Values of stages before `fromStage` with no record to reuse, as `awf run --values` gives them;
   * a workflow with events takes none.
   */
  values?: Readonly<Record<string, JsonValue>>;
  /**
   * Where the run's TUI agents' panes go and whether they stay, as `awf run --workspace` and
   * `--keep-panes` give them: `run.agents` shows what each agent's host was asked. Absent, the
   * run's workspace, and no pane kept.
   */
  panes?: RunPanes;
};

/** Every option a test may give, whatever its workflow's args and events: what the run reads. */
type AnyTestOptions = CommonTestOptions & {
  args?: JsonValue;
  event?: { name: string; data: JsonValue } & EventIds;
  events?: readonly ScriptedEvent<EventSchemas>[];
};

const OPTION_KEYS: readonly (keyof AnyTestOptions)[] = [
  "args",
  "id",
  "files",
  "agents",
  "compactions",
  "messages",
  "participants",
  "decisions",
  "allowance",
  "runtimes",
  "caller",
  "timeout",
  "stall",
  "maxTimers",
  "maxTurns",
  "cwd",
  "earlier",
  "fromStage",
  "values",
  "panes",
  "event",
  "events",
];
const EARLIER_KEYS: readonly (keyof EarlierAttempt)[] = ["stages", "events", "run"];

/**
 * A test's options as `testWorkflow` was called, `(workflow, options?)`: a workflow's args given
 * second, or options third, are refused, naming `{ args }`; object args given second are named by
 * their first key.
 */
export function testCall(workflow: unknown, given: readonly unknown[]): AnyTestOptions {
  if (given.length > 1)
    throw new Error(
      "testWorkflow takes (workflow, options?): give args among the options, testWorkflow(workflow, { args, … })",
    );
  const options = plainOptions(given[0] === undefined ? {} : given[0]);
  const problem = optionsProblem(
    options,
    isEventWorkflow(workflow),
    (workflow as { meta?: { name?: string } } | null)?.meta?.name ?? "the workflow",
  );
  if (problem) throw new Error(problem);
  if (!isWorkflow(workflow))
    throw new Error(
      "testWorkflow(workflow, options?) tests a workflow defineWorkflow made: define it with defineWorkflow",
    );
  return options;
}

function isObject(value: unknown): value is AnyTestOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as a test's options: an object literal, never a `Date`, an array or a class's instance. */
function plainOptions(value: unknown): AnyTestOptions {
  const prototype = isObject(value) ? Object.getPrototypeOf(value) : undefined;
  if (prototype === Object.prototype || prototype === null) return value as AnyTestOptions;
  const kind =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "an array"
        : typeof value === "object"
          ? `a ${(prototype as { constructor?: { name?: string } }).constructor?.name || "object"}`
          : `a ${typeof value}`;
  throw new Error(
    `testWorkflow's options are an object literal, not ${kind}: testWorkflow(workflow, { args, … })`,
  );
}

function isWorkflow(workflow: unknown): workflow is Workflow {
  return (
    typeof workflow === "object" &&
    workflow !== null &&
    (workflow as { kind?: unknown }).kind === WORKFLOW_KIND
  );
}

/** Why a test's options aren't ones `testWorkflow` takes; undefined when they are. */
function optionsProblem(
  options: AnyTestOptions,
  withEvents: boolean,
  name: string,
): string | undefined {
  for (const key of Object.keys(options) as (keyof AnyTestOptions)[]) {
    if (!OPTION_KEYS.includes(key))
      return `testWorkflow has no option ${JSON.stringify(key)}: its options are ${OPTION_KEYS.join(", ")}${
        "args" in options ? "" : "; a workflow's args are given as { args }"
      }`;
    if (!withEvents && (key === "event" || key === "events"))
      return `${key} is an option for a workflow with events, and ${name} declares none`;
  }
  const panes = panesProblem(options.panes);
  if (panes) return panes;
  const { earlier } = options;
  if (earlier === undefined) return undefined;
  if (!isObject(earlier)) return "earlier is an object: { stages?, events?, run? }";
  const unknown = Object.keys(earlier).find(
    (key) => !EARLIER_KEYS.includes(key as keyof EarlierAttempt),
  );
  return unknown === undefined
    ? undefined
    : `earlier has no ${JSON.stringify(unknown)}: it gives ${EARLIER_KEYS.join(", ")}`;
}

/** Why `panes` isn't what `awf run --workspace` and `--keep-panes` could give; undefined when it is. */
function panesProblem(panes: unknown): string | undefined {
  if (panes === undefined) return undefined;
  if (!isObject(panes)) return "panes is an object: { workspace?, keep? }";
  const { workspace, keep, ...rest } = panes as Record<string, unknown>;
  const other = Object.keys(rest)[0];
  if (other !== undefined) return `panes has no ${JSON.stringify(other)}: it gives workspace, keep`;
  if (keep !== undefined && !KEEP_PANES.includes(keep as KeepPane))
    return `panes.keep is ${KEEP_PANES.join(", ")}, not ${JSON.stringify(keep)}`;
  const named =
    isObject(workspace) &&
    Object.keys(workspace).join() === "name" &&
    typeof (workspace as { name?: unknown }).name === "string" &&
    (workspace as { name: string }).name.trim() !== "";
  if (workspace !== undefined && workspace !== "run" && workspace !== "origin" && !named)
    return `panes.workspace is "run", "origin" or { name }, not ${JSON.stringify(workspace)}`;
  return undefined;
}

/** What a test of the engine, not of a workflow, may give `runTest`. */
type EngineTestOptions = {
  /**
   * Where an agent may `--await-reply`: `listed`, where the engine's list allows it for the
   * agent's harness and placement, as a run would; `anywhere`, on any harness, the fake's included.
   */
  awaitReply?: "listed" | "anywhere";
};

/** A test's length of time in milliseconds, a `Duration` checked; undefined when not given. */
function milliseconds(options: AnyTestOptions, field: "timeout" | "stall"): number | undefined {
  const given = options[field];
  return given == null ? undefined : positiveDurationMilliseconds(given, `a test's ${field}`);
}

/** A file's contents, or a directory of them by name. */
export type FileTree = string | { readonly [name: string]: FileTree };

/** A `keepAlive` that gives no `window`, in a test: the hour it would be stalls it. */
const TEST_WINDOW_MS = 100;

const WAITED_OUT = "the test ended the attempt: everything left waited on a participant";

/**
 * An event a test sends while the run goes on, at an agent's `n`th turn, `"{agent}#{n}"`: `during`
 * it, or `after` it has ended, once the run waits live in an agent's `keepAlive` window. `n` counts
 * the agent's turns in the test, a nudge's included, and not its compactions: not the `n` of its
 * operation's id, `{agent}.{n}`, which counts each operation once and its compactions too.
 */
export type ScriptedEvent<Events extends EventSchemas> = (
  | { during: string; after?: undefined }
  | { after: string; during?: undefined }
) &
  EventIds &
  {
    [Name in Exclude<keyof Events & string, `${string}:ended`>]: {
      name: Name;
      data: OutputOf<Events[Name]>;
    };
  }[Exclude<keyof Events & string, `${string}:ended`>];

/** An event's id in the run's `in.jsonl`, as `awf emit --event-id` gives it. */
type EventIds = { eventId?: string };

/** An event the run sent, to the run whose ref is `ref`, which a test doesn't start. */
export type EmittedEvent = { ref: string; name: string; data: JsonValue; eventId?: string };

/** What the run did. Under `parallel`, what started first is scheduling: read by key. */
export type TestRun<Result> = {
  /**
   * What the workflow returned. When it threw instead, reading this throws, with the workflow's
   * error as the cause: `expect(() => run.value).toThrow(…)`. So does spreading or serialising the
   * run.
   */
  readonly value: Result;
  /** Every turn, nudges included, in the order they started. */
  turns: TestTurn[];
  /** One agent's turns, in its session's order. */
  turnsOf(agent: string): TestTurn[];
  /** Every compaction, in the order they started; not among the turns. */
  compactions: CompactionRecord[];
  /** One agent's compactions, in order. */
  compactionsOf(agent: string): CompactionRecord[];
  /** Every switch of an agent's model or effort its host was asked for, in order; not among the turns. */
  sets: SetRecord[];
  /** One agent's switches, in order. */
  setsOf(agent: string): SetRecord[];
  /** The messages admitted for one agent, in the order sent: who sent each, whether it asked, and how it ended. */
  messagesOf(recipient: string): MessageRecord[];
  /** Every agent opened, in the order opened. */
  agents: OpenedAgent[];
  /** The agent opened under `key`; throws, naming the keys opened, when there is none. */
  agentOf(key: string): OpenedAgent;
  decisions: DecisionRequest[];
  logs: { message: string; fields?: JsonObject }[];
  /**
   * Each stage the attempt entered, in order, by its line in `run.jsonl`: one it ran or was given
   * its own, times and reason included, which the run's own summaries leave out; one it reused the
   * line it reused, an earlier attempt's. A stage the plan stopped as it was entered wrote none, and
   * is absent.
   */
  stages: StageLine[];
  /**
   * How the attempt ended, as the workflow's `present` and `report` are given it: `completed` with
   * its value, `parked` at its last wait, or `stopped`, `failed`, `timed-out` or `cancelled` with
   * the stage it ended in and why.
   */
  ending: Ending<Result>;
  /** Every event the run sent to another workflow, in order. */
  emits: EmittedEvent[];
  /** The run's timers in the order set: when each was due, and whether it fired or was cancelled. */
  timers: { name: string; due: string; state: "fired" | "cancelled" | "pending" }[];
  /** The events senders gave the run, its `in.jsonl` as the run left it, in order. */
  events: EventLine[];
  /**
   * What the run settled, its `run.jsonl` as the run left it, in order: each attempt's `claimed`,
   * and its stages, timers, sessions, what its waits and races took, and the turns it began.
   */
  run: RunLine[];
};

/**
 * `testWorkflow`, and what only the engine's own tests give it: a workflow may be its `meta` and
 * `run` alone, which the engine's tests build and a workflow's never does.
 */
export async function runTest<Result extends JsonValue>(
  // biome-ignore lint/suspicious/noExplicitAny: args are checked by the call that typed them.
  workflow: RunnableWorkflow<any, Result> | Workflow<any, Result, EventSchemas>,
  options: AnyTestOptions = {},
  engine: EngineTestOptions = {},
): Promise<TestRun<Result>> {
  const withEvents = isEventWorkflow(workflow) ? (workflow as EventWorkflow) : undefined;
  const problem = optionsProblem(options, withEvents !== undefined, workflow.meta.name);
  if (problem) throw new Error(problem);
  const logs: TestRun<Result>["logs"] = [];
  const earlier = earlierOf(options);
  if (withEvents && options.values !== undefined)
    throw new Error(
      "a run of a workflow with events takes no values: before fromStage, a stage with no record runs",
    );
  if (withEvents && options.fromStage !== undefined && earlier.continues === false)
    throw new Error(
      "a run of a workflow with events takes fromStage only with earlier, as awf run takes --from-stage only with --continue",
    );
  const started = startOf(withEvents, options);
  const definition = workflow as RunnableWorkflow<JsonValue, Result>;
  const scripts = new Scripts(options.agents);
  const compactionScripts = new Scripts(options.compactions, {
    noun: "compaction",
    option: "compactions",
  });
  const messageScripts = new MessageScripts(options.messages);
  if (options.values !== undefined && options.fromStage === undefined) {
    throw new Error("values give the stages before fromStage: give fromStage too");
  }
  const stopping = new AbortController();
  const problems: string[] = [];
  const stallMs = milliseconds(options, "stall") ?? 2_000;
  const timeoutMs = milliseconds(options, "timeout");
  let stall: ReturnType<typeof setTimeout> | undefined;
  /** The test ended the attempt: everything left waited on a coordinator's script. */
  let waitedOut = false;
  const arm = (ms: number) => {
    clearTimeout(stall);
    stall = setTimeout(stalled, ms);
  };
  const stalled = () => {
    const open = coordinators.open();
    if (host.inFlight().length === 0 && coordinators.idle && open.length > 0) {
      const closes = open.flatMap((each) => (each.closesAt === undefined ? [] : [each.closesAt]));
      // A question that closes on its own is waited for; that wait is not a stall.
      if (closes.length > 0) return arm(Math.max(0, Math.min(...closes) - Date.now()) + stallMs);
      waitedOut = true;
      stopping.abort(new Error("everything left waits on a participant"));
      return;
    }
    if (host.inFlight().length === 0 && liveUntil !== undefined && liveUntil > now())
      return stopWith(
        `the run stalled: it waits live in an agent's keepAlive window for ${liveUntil - now()} ms more; a test gives the agent a short window, or none`,
      );
    const waiting = host
      .inFlight()
      .map((turn) => `"${turn.agent}" turn ${turn.n}${turn.nudge ? " (nudge)" : ""}`);
    stopWith(
      `the run stalled: nothing started or ended for ${stallMs} ms; ${
        waiting.length > 0 ? `in flight: ${waiting.join(", ")}` : "no turn in flight"
      }`,
    );
  };
  /** How far the virtual clock is ahead of the real one. */
  let ahead = 0;
  const now = () => Date.now() + ahead;
  const maxTimers = options.maxTimers ?? 20;
  if (!Number.isInteger(maxTimers) || maxTimers < 0)
    throw new Error(`maxTimers is a whole number of timers, 0 or more, not ${options.maxTimers}`);
  let skipped = 0;
  /** The clock stopped at maxTimers, and the run parked there. */
  let stoppedSkipping = false;
  const skip = async (until: number) => {
    if (skipped >= maxTimers) {
      stoppedSkipping = true;
      return false;
    }
    skipped += 1;
    ahead += Math.max(0, until - now());
    liveUntil = undefined;
    events.onActivity();
    return true;
  };
  const scripted = withEvents && new ScriptedEvents(withEvents, options, earlier.events ?? [], now);
  const maxTurns = options.maxTurns ?? 20;
  if (!Number.isInteger(maxTurns) || maxTurns < 1)
    throw new Error(`maxTurns is a whole number of turns, at least 1, not ${options.maxTurns}`);
  let turnsStarted = 0;
  /** The end of the window the run last waited live to. */
  let liveUntil: number | undefined;
  let nudge: (() => void) | undefined;
  const events = {
    onActivity: () => arm(stallMs),
    onScriptError: (message: string) => stopWith(message),
    onTurnStarted: async (turn: TestTurn) => {
      turnsStarted += 1;
      if (turnsStarted > maxTurns)
        return stopWith(
          `the run started more than ${maxTurns} turns (maxTurns): a loop that never ends, or a run that needs a larger maxTurns?`,
        );
      const due = scripted ? scripted.due(turn) : [];
      if (due.length === 0) return;
      for (const line of due) await appendIn(run.dir, line);
      nudge?.();
    },
  };
  const attempt = earlier.continues
    ? Math.max(1, ...(earlier.run ?? []).map((line) => line.attempt)) + 1
    : 1;
  const coordinators = new ParticipantScripts(options.participants, attempt, events);
  const stopWith = (message: string) => {
    problems.push(message);
    stopping.abort(new Error(message));
  };
  const temporary: string[] = [];
  const directory = () => {
    const path = mkdtempSync(join(tmpdir(), "awf-test-"));
    temporary.push(path);
    return path;
  };
  // Laid out under a directory of the test's own, which it removes: never into one it was given.
  if (options.files && options.cwd !== undefined)
    throw new Error("files are laid out in the test's own directory: give files or cwd, not both");
  const cwd = options.cwd ?? directory();
  let args: JsonValue;
  try {
    args = argsOf(workflow, options, cwd);
  } catch (error) {
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
    throw error;
  }
  const host = createScriptedHost(
    scripts,
    compactionScripts,
    messageScripts,
    events,
    options.caller ? { ...options.caller, cwd } : undefined,
  );
  const decisions = createScriptedDecisions(options.decisions ?? {}, events);
  // Sandboxes are opened by a provider that confines nothing and hosts panes.
  const sandboxes = createFakeSandboxProvider({ panes: { prelude: "true", ready: "ready" } });

  let settled: { value: Result } | { error: unknown };
  /** What the run came to, as `awf run` decides its ending from. */
  let finished: Finished;
  /** What the workflow returned, before the run settled: a test that waits out a question keeps it. */
  let returned: { value: Result } | undefined;
  const watched: RunnableWorkflow<JsonValue, Result> = {
    ...definition,
    run: async (context, given) => {
      const value = await definition.run(context, given);
      if (!waitedOut) returned = { value };
      return value;
    },
  };
  let sandboxOf = new Map<string, AgentSandbox>();
  const emits: EmittedEvent[] = [];
  let inLines: EventLine[] = [];
  let runLines: RunLine[] = [];
  let timers: TestRun<Result>["timers"] = [];
  let stages: StageLine[] = [];
  let messages: (MessageRecord & { to: string })[] = [];
  const runRoot = directory();
  const deadline =
    timeoutMs === undefined ? undefined : { unixMilliseconds: Date.now() + timeoutMs };
  const run = await createRun(runRoot, {
    id: started.id,
    workflow: definition.meta.name,
    argv: [],
    cwd,
    sandbox: null,
  }).catch((error: unknown) => {
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
    throw error;
  });
  let lines: RunLines;
  let ops: EarlierOps;
  try {
    if (earlier.stages) await recordEarlierAttempt(run.dir, earlier.stages);
    if (earlier.run) await writeEarlierLines(run.dir, earlier.run);
    for (const line of earlier.events ?? []) await appendIn(run.dir, line);
    if (started.record) await appendIn(run.dir, started.record);
    ops = await listOps(run.dir);
    lines = await claimRunLines(run.dir, attempt, new Date(now()).toISOString());
  } catch (error) {
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
    throw error;
  }
  const recordedStages = async ({ stages: entered = [] }: SettledRun) => {
    const { view } = await readRunLines(run.dir);
    // The run's summaries hold one entry per stage, as it last stood: a stage by content that
    // failed and ran again in this attempt is one entry, its latest line. So each entry's line is
    // the latest its attempt wrote: a stage this attempt ran or was given has its own, a reused one
    // the line it reused. A stage the plan stopped wrote none.
    return entered.flatMap(({ stage, attempt: wrote }) => {
      const line = view.stages[stage]?.history.findLast((each) => each.attempt === wrote);
      return line ? [line] : [];
    });
  };
  events.onActivity();
  try {
    // A path it can't lay out is the test's mistake, never the workflow's.
    await layOut(options.files, cwd).catch((error: unknown) => {
      stopWith(messageOf(error));
      throw error;
    });
    const result = await runWorkflow(watched, args, {
      runRoot,
      livenessPolicy: { quietMs: 1, responseMs: 25, deliveryMs: 100, releaseMs: 1000 },
      // A workflow's own default hour would stall its test; one it gives is kept.
      defaultWindowMs: TEST_WINDOW_MS,
      now,
      ...(engine.awaitReply === "anywhere" ? { awaitReply: () => true } : {}),
      run: {
        dir: run.dir,
        id: run.record.id,
        lines,
        ops,
        ...(options.fromStage === undefined ? {} : { fromStage: options.fromStage }),
        ...(options.panes === undefined ? {} : { panes: options.panes }),
        ...(options.values === undefined
          ? {}
          : { values: new Map(Object.entries(options.values)) }),
        ...(scripted
          ? {
              events: true as const,
              park: async () => undefined,
              skip,
              live: async (until: number) => {
                liveUntil = until;
                const due = scripted.ended(host.inFlight());
                for (const line of due) await appendIn(run.dir, line);
                if (due.length > 0) nudge?.();
              },
              listenNudges: (given: () => void) => {
                nudge = given;
              },
            }
          : // A plain run waits for a timer in its process; a test moves its clock, or parks it.
            { park: async () => undefined, skip }),
      },
      cwd,
      ...(deadline === undefined ? {} : { deadline }),
      signal: stopping.signal,
      // A test starts no other workflow's run: what it sends is recorded.
      emit: async (target, event) => {
        emits.push({
          ref: `${target.meta.name}/${event.run}`,
          name: event.name,
          data: event.data,
          ...(event.id === undefined ? {} : { eventId: event.id }),
        });
        return "accepted";
      },
      runtime: { aliases: { ...OPERATOR_ALIASES, ...options.runtimes }, host: host.factory },
      sandboxes: {
        providers: {
          installed: { srt: sandboxes.provider, docker: sandboxes.provider },
        },
        sandboxesDir: directory(),
        machineRoot: directory(),
        // An agent here launches nothing, so it needs no harness's executable or login.
        homes: SCRIPTED_HOMES,
      },
      decisions: {
        providers: { scripted: decisions.provider },
        aliases: { jev: { provider: "scripted", model: "jev" } },
      },
      allowance: async (harness) => {
        return (
          options.allowance?.find((given) => given.harness === harness) ?? {
            harness,
            read: "none",
            reason: "the test gave no allowance for it",
          }
        );
      },
      onLog: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
      coordinators: [coordinators],
    });
    settled = { value: result.value };
    finished = { result };
    sandboxOf = sandboxesOf(result.sandboxes);
    stages = await recordedStages(result);
  } catch (caught) {
    finished = { error: caught };
    settled = { error: caught instanceof WorkflowRunError ? caught.cause : caught };
    if (caught instanceof WorkflowRunError) {
      sandboxOf = sandboxesOf(caught.sandboxes);
      stages = await recordedStages(caught);
    }
  } finally {
    clearTimeout(stall);
    if (waitedOut) {
      settled = returned ?? { error: new Error(WAITED_OUT) };
    }
    host.settle(await readTurns(run.dir));
    messages = await messagesIn(run.dir);
    inLines = await readIn(run.dir);
    runLines = (await readRunLines(run.dir)).lines;
    timers = timersOf((await readWaits(run.dir, now())).timers);
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
  }
  if (problems.length === 0 && scripted) problems.push(...scripted.unsent(host.inFlight()));
  if (problems.length === 0) {
    const leftovers = [
      ...scripts.leftovers(),
      ...compactionScripts.leftovers(),
      ...messageScripts.leftovers(),
    ];
    // What the workflow threw may be why a list went unfinished.
    if (leftovers.length > 0 && "error" in settled) {
      leftovers.push(`the workflow threw: ${messageOf(settled.error)}`);
    }
    problems.push(...leftovers);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const agents = host.agents.map((agent) => {
    const sandbox = sandboxOf.get(agent.key);
    return sandbox === undefined ? agent : { ...agent, sandbox };
  });
  const goOn = (stop: WorkflowStopped | undefined, entered: readonly { stage: string }[]) =>
    continueCommand(
      {
        shellCwd: cwd,
        cwd,
        cwdGiven: false,
        runRoot,
        runRootGiven: false,
        workflowFile: withEvents?.file ?? definition.meta.name,
        ...(options.fromStage === undefined ? {} : { fromStage: options.fromStage }),
      },
      run.record.id,
      stop,
      entered,
    );
  const decided = decideEnding(finished, deadline, goOn).ending;
  // What waited on a participant the test cancelled, not an operator; after a return, nothing.
  const ending: Ending<Result> =
    "value" in settled
      ? { kind: "completed", value: settled.value, stages: decided.stages }
      : waitedOut || decided.kind === "completed"
        ? {
            kind: "cancelled",
            ...("stage" in decided && decided.stage !== undefined ? { stage: decided.stage } : {}),
            reason: WAITED_OUT,
            stages: decided.stages,
            continue: goOn(undefined, decided.stages),
          }
        : decided;
  return {
    get value() {
      if ("value" in settled) return settled.value;
      if (primaryFailure(settled.error) instanceof RunParked)
        throw new Error(
          stoppedSkipping && maxTimers > 0
            ? `the run parked after the clock skipped to ${maxTimers} timers (maxTimers): a loop of timers that nothing answers?`
            : "the run parked, and returned nothing: run.ending says at which wait",
        );
      throw new Error(`the workflow threw: ${messageOf(settled.error)}`, { cause: settled.error });
    },
    turns: host.turns,
    emits,
    events: inLines,
    run: runLines,
    turnsOf: (agent) => host.turns.filter((turn) => turn.agent === agent),
    compactions: host.compactions,
    compactionsOf: (agent) => host.compactions.filter((compaction) => compaction.agent === agent),
    sets: host.sets,
    setsOf: (agent) => host.sets.filter((set) => set.agent === agent),
    messagesOf: (recipient) =>
      messages.flatMap(({ to, ...each }) => (to === recipient ? [each] : [])),
    agents,
    agentOf(key) {
      const agent = agents.find((opened) => opened.key === key);
      if (agent) return agent;
      const opened = agents.map((known) => `"${known.key}"`).join(", ") || "none";
      throw new Error(`no agent "${key}" was opened; opened: ${opened}`);
    },
    decisions: decisions.asked,
    logs,
    stages,
    timers,
    ending,
  };
}

/** Each timer: taken, or due by the run's clock and not cancelled, is `fired`. */
function timersOf(timers: ReadonlyMap<string, TimerState>): TestRun<unknown>["timers"] {
  return [...timers.values()].map(({ name, due, taken, fired, cancelled }) => ({
    name,
    due,
    state: taken ? "fired" : cancelled ? "cancelled" : fired ? "fired" : "pending",
  }));
}

/**
 * A message as `messagesOf` gives it. A question ends `replied` or `failed`, `reason` saying why it
 * failed (`timed-out`, `withdrawn`, `released`, `cancelled`, `attempt-ended`, or how its peer
 * failed); any other message ends `delivered` once shown, or `undelivered` with the reason.
 * `pending` until then. A message to a coordinator is shown once recorded.
 */
export type MessageRecord = {
  from: string;
  awaitReply: boolean;
  end: "replied" | "failed" | "delivered" | "undelivered" | "pending";
  reason?: string;
};

/** The attempt's messages, read from the run's event log. */
async function messagesIn(dir: string): Promise<(MessageRecord & { to: string })[]> {
  const found = new Map<number, MessageRecord & { to: string }>();
  const outside = new Set<string>();
  for (const event of await readEvents(dir)) {
    if (event.kind === "participant-connected") outside.add(event.participant);
    if (event.kind === "message-sent") {
      const awaitReply = event.awaitsReply !== undefined;
      found.set(event.message, {
        from: event.from,
        to: event.to,
        awaitReply,
        // A coordinator reads the run log: what it is sent is shown once recorded.
        end: outside.has(event.to) && !awaitReply ? "delivered" : "pending",
      });
      continue;
    }
    const message =
      "message" in event && typeof event.message === "number"
        ? found.get(event.message)
        : undefined;
    if (!message) continue;
    if (event.kind === "request-ended") {
      message.end = event.end === "replied" ? "replied" : "failed";
      const reason =
        event.end === "failed" ? event.reason : event.end === "replied" ? undefined : event.end;
      if (reason !== undefined) message.reason = reason;
    } else if (!message.awaitReply && event.kind === "message-delivery") {
      message.end = "delivered";
    } else if (!message.awaitReply && event.kind === "message-undelivered") {
      message.end = "undelivered";
      message.reason = event.reason;
    }
  }
  return [...found.values()];
}

/**
 * Writes `recorded` as attempt 1's succeeded stage lines into a run's `run.jsonl`, after attempt 1's
 * claim, a second apart in the order given: a continue orders what is recorded by when each stage
 * started.
 */
async function recordEarlierAttempt(
  dir: string,
  recorded: Readonly<Record<string, JsonValue | undefined>>,
): Promise<void> {
  let at = Date.now() - Object.keys(recorded).length * 1_000;
  const lines = await claimRunLines(dir, 1, new Date(at - 1_000).toISOString());
  for (const [name, value] of Object.entries(recorded)) {
    const time = new Date(at).toISOString();
    at += 1_000;
    await lines.append({
      kind: "stage",
      attempt: 1,
      at: time,
      name,
      outcome: "succeeded",
      started: time,
      ...(value === undefined ? {} : { value }),
    });
  }
}

/**
 * Writes `lines`, what an earlier attempt settled, into the run's `run.jsonl` as given, once
 * `readRun` takes them: the test's claim comes after them.
 */
async function writeEarlierLines(dir: string, lines: readonly RunLine[]): Promise<void> {
  try {
    readRun(lines);
  } catch (error) {
    throw new Error(`earlier.run: ${messageOf(error)}`);
  }
  await appendFile(runLinesFile(dir), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
    mode: 0o600,
  });
}

/** An event a test sends while its run goes on, once its turn begins. */
type PendingEvent = {
  at: string;
  after: boolean;
  name: string;
  record: EventLine;
  /** Its turn, once begun: an `after` event waits for it to end. */
  turn?: TestTurn;
};

/** The events a test sends while its run goes on, each once its turn begins. */
class ScriptedEvents {
  readonly #pending: PendingEvent[];

  constructor(
    workflow: EventWorkflow,
    options: AnyTestOptions,
    /** The events the earlier attempt left, whose ids are taken. */
    earlier: readonly EventLine[],
    /** The run's clock, which stamps what is sent. */
    private readonly now: () => number,
  ) {
    const ids = new Set<string>();
    const idOf = (given: string | undefined, made: string) => {
      const id = given ?? made;
      const problem = given === undefined ? undefined : eventIdProblem(given);
      if (problem) throw new Error(`the eventId ${JSON.stringify(given)}: ${problem}`);
      // A repeated id would be appended and then dropped: the test says so instead.
      if (ids.has(id))
        throw new Error(`the eventId ${id} is given twice; an eventId names one event`);
      ids.add(id);
      return id;
    };
    for (const line of earlier) ids.add(line.id);
    if (options.event) idOf(options.event.eventId, `${AWF_ID_PREFIX}start`);
    this.#pending = (options.events ?? []).map((event, index) => {
      if ((event.during === undefined) === (event.after === undefined))
        throw new Error("a scripted event gives during or after, one of them");
      const after = event.after !== undefined;
      const at = event.after ?? event.during;
      if (typeof at !== "string" || !/^[^#]+#[1-9]\d*$/.test(at))
        throw new Error(
          `a scripted event's ${after ? "after" : "during"} is "{agent}#{n}", an agent's nth turn, not ${at}`,
        );
      const id = idOf(event.eventId, `${AWF_ID_PREFIX}test.${index + 1}`);
      // A participant's reply is recorded as `awf emit` records one, whatever name it is sent by.
      const stamped = new Date().toISOString();
      let sent = {
        id,
        name: event.name,
        data: event.data as JsonValue,
        from: "operator",
        at: stamped,
      };
      const reply = awfEventOf(event.name);
      if (reply?.kind === "reply") {
        checkEvent(workflow, event, true);
        sent = replyRecord(reply.key, id, event.data, stamped);
      } else checkEvent(workflow, event);
      return {
        at,
        after,
        name: event.name,
        record: sent,
      };
    });
  }

  /** The events due during `turn`, taken off the list, stamped now; those after it wait for it. */
  due(turn: TestTurn): EventLine[] {
    const at = `${turn.agent}#${turn.n}`;
    for (const each of this.#pending) if (each.after && each.at === at) each.turn = turn;
    return this.#take((each) => !each.after && each.at === at);
  }

  /** The run waits live: the events after a turn that has ended, taken off the list. */
  ended(inFlight: readonly TestTurn[]): EventLine[] {
    return this.#take((each) => each.turn !== undefined && !inFlight.includes(each.turn));
  }

  #take(which: (each: PendingEvent) => boolean): EventLine[] {
    const due = this.#pending.filter(which);
    for (const each of due) this.#pending.splice(this.#pending.indexOf(each), 1);
    return due.map((each) => ({ ...each.record, at: new Date(this.now()).toISOString() }));
  }

  /** What was never sent: the test fails. */
  unsent(inFlight: readonly TestTurn[]): string[] {
    return this.#pending.map(
      (each) =>
        `the scripted ${each.name} ${each.after ? "after" : "during"} ${each.at} was never sent: ${
          each.turn !== undefined && !inFlight.includes(each.turn)
            ? "the run never waited live after that turn, in an agent's keepAlive window"
            : "that turn never ran"
        }`,
    );
  }
}

/** Lays out `files` before the run, each path under `cwd`. */
async function layOut(
  files: Readonly<Record<string, FileTree>> | undefined,
  cwd: string,
): Promise<void> {
  const write = async (path: string, tree: FileTree): Promise<void> => {
    if (typeof tree === "string") {
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, tree);
      return;
    }
    await mkdir(path, { recursive: true });
    for (const [name, inner] of Object.entries(tree)) await write(join(path, name), inner);
  };
  for (const [path, tree] of Object.entries(files ?? {})) {
    // Under the test's own directory, which it removes: a path outside would be left behind.
    const target = resolve(cwd, path);
    if (isAbsolute(path) || (relative(cwd, target) !== "" && !isInside(cwd, target)))
      throw new Error(`files lays out under the run's directory; ${path} is outside it`);
    await write(target, tree);
  }
}

/**
 * The run a test starts: its id, and the event it starts with, as `awf emit` would append it, or
 * none, as `awf run --id` starts one.
 */
function startOf(
  workflow: EventWorkflow | undefined,
  options: AnyTestOptions,
): { id: string; record?: EventLine } {
  const { event, id = "test" } = options;
  if (typeof id !== "string") throw new Error(`a run's id is a string, not ${JSON.stringify(id)}`);
  const problem = idProblem(id);
  if (problem) throw new Error(problem);
  if (workflow === undefined || event === undefined) return { id };
  checkEvent(workflow, { name: event.name, data: event.data });
  const { starts } = workflow;
  if (starts && !starts.includes(event.name))
    throw new Error(
      `${event.name} doesn't start a run of ${workflow.meta.name}: its starts are ${starts.join(", ")}`,
    );
  const record: EventLine = {
    at: new Date().toISOString(),
    id: event.eventId ?? `${AWF_ID_PREFIX}start`,
    name: event.name,
    data: event.data,
    from: "operator",
    starts: true as const,
  };
  return { id, record };
}

/** What the earlier attempt left; `continues` when `earlier` is given: the test's is a continue. */
function earlierOf(options: AnyTestOptions): EarlierAttempt & { continues: boolean } {
  return { ...options.earlier, continues: options.earlier !== undefined };
}

/**
 * The args the run is given: the test's, or what `prepare` makes of no argv, as `awf run` given
 * none, or a run an event starts, has. A workflow of the engine's own tests, without `prepare`,
 * gets `null`.
 */
function argsOf(
  workflow: { readonly meta: { name: string }; prepare?: Workflow["prepare"] },
  options: AnyTestOptions,
  cwd: string,
): JsonValue {
  if (options.args !== undefined) return options.args;
  if (workflow.prepare === undefined) return null;
  try {
    const args: unknown = workflow.prepare({ argv: [], cwd });
    assertJsonValue(args, `${workflow.meta.name} arguments`);
    return args;
  } catch (error) {
    throw new Error(
      `${workflow.meta.name} was given no args, and its prepare of none failed: ${messageOf(error)}; give args`,
      { cause: error },
    );
  }
}

function sandboxesOf(sandboxes: readonly SandboxRecord[] | undefined): Map<string, AgentSandbox> {
  return new Map(
    (sandboxes ?? []).flatMap(({ key, provider, spec, domains, agents }) =>
      agents.map(({ agent }) => [agent, { key, provider, spec, domains }] as const),
    ),
  );
}
