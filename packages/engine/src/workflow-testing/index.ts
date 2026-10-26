import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SandboxRecord,
  STAGE_RECORD_VERSION,
  type StageNeed,
  type StageRecord,
} from "@agentswf/contract/records";
import {
  type EventSchemas,
  EXECUTABLE_WORKFLOW_KIND,
  type ExecutableEventWorkflow,
  type ExecutableWorkflow,
  type JsonObject,
  type JsonValue,
  type OutputOf,
  type ParticipantReply,
  type RuntimeAliases,
  type WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { type Harness, sandboxTokens } from "@agentswf/harness";
import { createFakeSandboxProvider } from "@agentswf/sandbox/testing/fake";
import { messageOf } from "../errors";
import { OPERATOR_ALIASES } from "../operator-aliases";
import { createRun, readEvents, readStageRecords, writeStageRecord } from "../runs";
import { primaryFailure, WorkflowStopped } from "../stopped";
import { runWorkflow, type SettledRun, WorkflowRunError } from "../workflow-runner";
import { CoordinatorScripts } from "./coordinators";
import { createScriptedDecisions, type DecisionRequest, type DecisionScript } from "./decisions";
import {
  type AgentSandbox,
  type CompactionRecord,
  createScriptedHost,
  type OpenedAgent,
  type SetRecord,
  type TurnRecord,
} from "./host";
import {
  type CoordinatorScript,
  type MessageScript,
  MessageScripts,
  type Script,
  Scripts,
} from "./script";

export type { DecisionRequest, DecisionScript } from "./decisions";
export {
  answer,
  type CoordinatorMessage,
  type CoordinatorRoute,
  type CoordinatorScript,
  type HolderOutcome,
  type Message,
  type MessageOutcome,
  type MessageScript,
  type ReceivedMessage,
  reply,
  type Script,
  type SendOptions,
  type Turn,
} from "./script";

export type TestOptions = {
  /** Each agent's script, by its key or a pattern such as `"review:*"`. */
  agents?: Readonly<Record<string, Script>>;
  /**
   * Each agent's compactions, apart from its turns: `answer("summary")` or a `reply`, a list one
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
   * Each coordinator's script, by the key the workflow connects it under. When no turn runs, no
   * script is still working, and everything left waits on a coordinator with no `until`, the attempt
   * ends: its open questions expire `attempt-ended` and, unless the workflow returned, `run.value`
   * throws. While a question has an `until`, the test waits for the earliest, and `stallMs` does not
   * count that wait. A route
   * or message reaching a coordinator with none here fails the test.
   */
  coordinators?: Readonly<Record<string, CoordinatorScript>>;
  /**
   * Where an agent may `--await-reply`: `listed`, where the engine's list allows it for the
   * agent's harness and placement, as a run would; `anywhere`, to test a workflow's messaging on a
   * harness not listed yet.
   */
  awaitReply?: "listed" | "anywhere";
  /** Each decision's answers, by its key or a pattern. */
  decisions?: Readonly<Record<string, DecisionScript>>;
  /** Runtime aliases beside the ones `awf run` installs, `claude` and `codex`; the same name replaces one. */
  runtimes?: RuntimeAliases;
  /** The run's deadline; none unless given, as `awf run` has none unless `--timeout` gives one. */
  timeoutMs?: number;
  /** Real time with no turn or decision starting or ending before the test fails; 2 s. */
  stallMs?: number;
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
   * Stages an earlier attempt recorded, by name: each value, or `undefined` for a stage that
   * returns nothing. Given, the run is that run's continue, reusing them without calling their
   * work, as `awf run --continue` would.
   */
  recorded?: Readonly<Record<string, JsonValue | undefined>>;
  /**
   * The stage the attempt starts at, as `--from-stage`: a continue of `recorded`, or a new run
   * started there.
   */
  fromStage?: string;
  /** Values of stages before `fromStage` with no record to reuse, as `awf run --values` gives them. */
  values?: Readonly<Record<string, JsonValue>>;
};

/** A file's contents, or a directory of them by name. */
export type FileTree = string | { readonly [name: string]: FileTree };

/** An event a test sends while the run goes on: while an agent's `n`th turn runs, `"{agent}#{n}"`. */
export type ScriptedEvent<Events extends EventSchemas> = { during: string; id?: string } & (
  | { [Name in keyof Events & string]: { name: Name; data: OutputOf<Events[Name]> } }[keyof Events &
      string]
  /** A reply on a participant routed to the code; awf fills its author and id when absent. */
  | { name: "participant:reply"; from: string; data: ParticipantReply }
);

/**
 * A test of a workflow with `events`: what a run is started with, then sends while it goes on.
 * `recorded`, `fromStage` and `values` have no meaning for it.
 */
export type EventTestOptions<Events extends EventSchemas> = Omit<
  TestOptions,
  "recorded" | "fromStage" | "values"
> & {
  /** The event that starts the run, whose `key` is the run's key. */
  event: {
    [Name in keyof Events & string]: { name: Name; data: OutputOf<Events[Name]>; id?: string };
  }[keyof Events & string];
  /** Laid out before the run, by path: absolute, or under `cwd`. */
  files?: Readonly<Record<string, FileTree>>;
  /** Sent at points in the run, each once its point is reached. */
  events?: readonly ScriptedEvent<Events>[];
  /** More turns started than this fails the test, so a loop that never parks doesn't hang it; 20. */
  maxTurns?: number;
};

/** An event the run sent another workflow, which a test doesn't start. */
export type EmittedEvent = { target: string; name: string; data: JsonValue; id?: string };

/** What the run did. Under `parallel`, what started first is scheduling: read by key. */
export type TestRun<Result> = {
  /**
   * What the workflow returned. When it threw instead, reading this throws, with the workflow's
   * error as the cause: `expect(() => run.value).toThrow(…)`. So does spreading or serialising the
   * run.
   */
  readonly value: Result;
  /** Every turn, nudges included, in the order they started. */
  turns: TurnRecord[];
  /** One agent's turns, in its session's order. */
  turnsOf(agent: string): TurnRecord[];
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
   * Each stage's record in the order entered, as the run wrote it to disk: sessions, times and
   * reason included, which the run's own summaries leave out.
   */
  stages: StageRecord[];
  /** How the attempt stopped, apart from a failure, and the value it stopped for; absent when it didn't. */
  stopped?: { reason: string; stage?: string; needs?: readonly StageNeed[] };
  /** Every event the run sent to another workflow, in order. */
  emits: EmittedEvent[];
  /** A run of a workflow with `events` that parked, and its last wait; absent when it returned. */
  parked?: { label?: string; until?: string };
};

/**
 * Runs `workflow` through the real engine, answering each agent from its script and each decision
 * from its own. It rejects when a script cannot meet what the workflow asked, or leaves a list
 * unfinished, or the run stalls: those fail the test, never the workflow.
 */
export async function testWorkflow<Events extends EventSchemas, Result extends JsonValue>(
  workflow: ExecutableEventWorkflow<Events, Result>,
  options: EventTestOptions<NoInfer<Events>>,
): Promise<TestRun<Result>>;
export async function testWorkflow<Args extends JsonValue, Result extends JsonValue>(
  workflow: WorkflowDefinition<Args, Result> | ExecutableWorkflow<Args, Result>,
  args: NoInfer<Args>,
  options?: TestOptions,
): Promise<TestRun<Result>>;
export async function testWorkflow<Args extends JsonValue, Result extends JsonValue>(
  workflow:
    | WorkflowDefinition<Args, Result>
    | ExecutableWorkflow<Args, Result>
    | ExecutableEventWorkflow<EventSchemas, Result>,
  args: NoInfer<Args>,
  options: TestOptions = {},
): Promise<TestRun<Result>> {
  if ("definition" in workflow && "events" in workflow.definition)
    throw new Error("testing a workflow with events is not built yet");
  const given = workflow as WorkflowDefinition<Args, Result> | ExecutableWorkflow<Args, Result>;
  const definition = isExecutable(given) ? given.definition : given;
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
  const stallMs = options.stallMs ?? 2_000;
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
      stopping.abort(new Error("everything left waits on a coordinator"));
      return;
    }
    const waiting = host
      .inFlight()
      .map((turn) => `"${turn.agent}" turn ${turn.n}${turn.nudge ? " (nudge)" : ""}`);
    stopWith(
      `the run stalled: nothing started or ended for ${stallMs} ms; ${
        waiting.length > 0 ? `in flight: ${waiting.join(", ")}` : "no turn in flight"
      }`,
    );
  };
  const events = {
    onActivity: () => arm(stallMs),
    onScriptError: (message: string) => stopWith(message),
  };
  const attempt = options.recorded ? 2 : 1;
  const coordinators = new CoordinatorScripts(options.coordinators, attempt, events);
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
  const cwd = options.cwd ?? directory();
  const host = createScriptedHost(
    scripts,
    compactionScripts,
    messageScripts,
    events,
    options.caller ? { ...options.caller, cwd } : undefined,
  );
  const decisions = createScriptedDecisions(options.decisions ?? {}, events);
  const logs: TestRun<Result>["logs"] = [];
  // Sandboxes are opened by a provider that confines nothing and hosts panes.
  const sandboxes = createFakeSandboxProvider({ panes: { prelude: "true", ready: "ready" } });

  let settled: { value: Result } | { error: unknown };
  /** What the workflow returned, before the run settled: a test that waits out a question keeps it. */
  let returned: { value: Result } | undefined;
  const watched: WorkflowDefinition<Args, Result> = {
    ...definition,
    run: async (context, given) => {
      const value = await definition.run(context, given);
      if (!waitedOut) returned = { value };
      return value;
    },
  };
  let sandboxOf = new Map<string, AgentSandbox>();
  let stages: StageRecord[] = [];
  let messages: (MessageRecord & { to: string })[] = [];
  const runRoot = directory();
  const run = await createRun(runRoot, {
    id: "test",
    workflow: definition.meta.name,
    argv: [],
    cwd,
    sandbox: null,
  }).catch((error: unknown) => {
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
    throw error;
  });
  if (options.recorded) await recordEarlierAttempt(run.dir, options.recorded);
  const recordedStages = async ({ stages: entered = [] }: SettledRun) => {
    const records = await readStageRecords(run.dir);
    // A stage the plan stopped has no record of this attempt's: the one there is an earlier one's.
    return entered.flatMap(({ stage, attempt }) => {
      const record = records.get(stage);
      return record?.attempt === attempt ? [record] : [];
    });
  };
  events.onActivity();
  try {
    const result = await runWorkflow(watched, args, {
      runRoot,
      livenessPolicy: { quietMs: 1, responseMs: 25, deliveryMs: 100, releaseMs: 1000 },
      ...(options.awaitReply === "anywhere" ? { awaitReply: () => true } : {}),
      run: {
        dir: run.dir,
        id: run.record.id,
        attempt,
        ...(options.fromStage === undefined ? {} : { fromStage: options.fromStage }),
        ...(options.values === undefined
          ? {}
          : { values: new Map(Object.entries(options.values)) }),
      },
      cwd,
      ...(options.timeoutMs === undefined
        ? {}
        : { deadline: { unixMilliseconds: Date.now() + options.timeoutMs } }),
      signal: stopping.signal,
      runtime: { aliases: { ...OPERATOR_ALIASES, ...options.runtimes }, host: host.factory },
      sandboxes: {
        providers: {
          installed: { srt: sandboxes.provider, docker: sandboxes.provider },
          default: "srt",
        },
        sandboxesDir: directory(),
        machineRoot: directory(),
        // A sandbox here launches nothing, so no harness's login is needed: a stand-in for each.
        environment: {
          ...process.env,
          ...Object.fromEntries(sandboxTokens().map((name) => [name, "workflow-test"])),
        },
      },
      decisions: {
        providers: { scripted: decisions.provider },
        aliases: { jev: { provider: "scripted", model: "jev" } },
      },
      onLog: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
      coordinators: [coordinators],
    });
    settled = { value: result.value };
    sandboxOf = sandboxesOf(result.sandboxes);
    stages = await recordedStages(result);
  } catch (caught) {
    settled = { error: caught instanceof WorkflowRunError ? caught.cause : caught };
    if (caught instanceof WorkflowRunError) {
      sandboxOf = sandboxesOf(caught.sandboxes);
      stages = await recordedStages(caught);
    }
  } finally {
    clearTimeout(stall);
    if (waitedOut) {
      settled = returned ?? {
        error: new Error("the test ended the attempt: everything left waited on a coordinator"),
      };
    }
    messages = await messagesIn(run.dir);
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
  }
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
  return {
    get value() {
      if ("value" in settled) return settled.value;
      throw new Error(`the workflow threw: ${messageOf(settled.error)}`, { cause: settled.error });
    },
    turns: host.turns,
    emits: [],
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
    ...stoppedOf(settled),
  };
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
 * Writes `recorded` as attempt 1's succeeded stages into a run's folder, a second apart in the order
 * given: a continue orders what is recorded by when each stage started.
 */
async function recordEarlierAttempt(
  dir: string,
  recorded: Readonly<Record<string, JsonValue | undefined>>,
): Promise<void> {
  let at = Date.now() - Object.keys(recorded).length * 1_000;
  for (const [stage, value] of Object.entries(recorded)) {
    const time = new Date(at).toISOString();
    at += 1_000;
    await writeStageRecord(dir, {
      version: STAGE_RECORD_VERSION,
      stage,
      attempt: 1,
      outcome: "succeeded",
      started: time,
      ended: time,
      sessions: [],
      ...(value === undefined ? {} : { value }),
    });
  }
}

function isExecutable<Args extends JsonValue, Result extends JsonValue>(
  workflow: WorkflowDefinition<Args, Result> | ExecutableWorkflow<Args, Result>,
): workflow is ExecutableWorkflow<Args, Result> {
  return (workflow as { kind?: unknown }).kind === EXECUTABLE_WORKFLOW_KIND;
}

function sandboxesOf(sandboxes: readonly SandboxRecord[] | undefined): Map<string, AgentSandbox> {
  return new Map(
    (sandboxes ?? []).flatMap(({ key, provider, spec, domains, agents }) =>
      agents.map(({ agent }) => [agent, { key, provider, spec, domains }] as const),
    ),
  );
}

/** Decided as `awf run` decides it: a stop is the run's first failure, whatever failed beside it. */
function stoppedOf(
  settled: { value: unknown } | { error: unknown },
): Partial<Pick<TestRun<unknown>, "stopped">> {
  if (!("error" in settled)) return {};
  const stop = primaryFailure(settled.error);
  if (!(stop instanceof WorkflowStopped)) return {};
  return {
    stopped: {
      reason: stop.reason,
      ...(stop.stage === undefined ? {} : { stage: stop.stage }),
      ...(stop.needs === undefined ? {} : { needs: stop.needs }),
    },
  };
}
