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
  EXECUTABLE_WORKFLOW_KIND,
  type ExecutableWorkflow,
  type JsonObject,
  type JsonValue,
  type RuntimeAliases,
  type WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { type Harness, sandboxTokens } from "@agentswf/harness";
import { createFakeSandboxProvider } from "@agentswf/sandbox/testing/fake";
import { messageOf } from "../errors";
import { OPERATOR_ALIASES } from "../operator-aliases";
import { createRun, readStageRecords, writeStageRecord } from "../runs";
import { primaryFailure, WorkflowStopped } from "../stopped";
import { runWorkflow, type SettledRun, WorkflowRunError } from "../workflow-runner";
import { createScriptedDecisions, type DecisionRequest, type DecisionScript } from "./decisions";
import {
  type AgentSandbox,
  type CompactionRecord,
  createScriptedHost,
  type OpenedAgent,
  type SetRecord,
  type TurnRecord,
} from "./host";
import { type Script, Scripts } from "./script";

export type { DecisionRequest, DecisionScript } from "./decisions";
export { answer, reply, type Script, type Turn } from "./script";

export type TestOptions = {
  /** Each agent's script, by its key or a pattern such as `"review:*"`. */
  agents?: Readonly<Record<string, Script>>;
  /**
   * Each agent's compactions, apart from its turns: `answer("summary")` or a `reply`, a list one
   * entry per compaction. An agent with none here has every compaction answer `""`.
   */
  compactions?: Readonly<Record<string, Script>>;
  /** Each decision's answers, by its key or a pattern. */
  decisions?: Readonly<Record<string, DecisionScript>>;
  /** Runtime aliases beside the ones `awf run` installs, `claude` and `codex`; the same name replaces one. */
  runtimes?: RuntimeAliases;
  /** The run's deadline; 30 minutes, as `awf run`'s. */
  timeoutMs?: number;
  /** Real time with no turn or decision starting or ending before the test fails; 2 s. */
  stallMs?: number;
  /** Where the agents work; by default a temporary directory, removed afterwards. */
  cwd?: string;
  /**
   * The session the run is started from, as `awf run --here` finds one, by its harness; absent,
   * `agents.caller` answers `null`. Its turns are answered from the script under the key the
   * workflow gives it.
   */
  caller?: { harness: Harness };
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
};

/**
 * Runs `workflow` through the real engine, answering each agent from its script and each decision
 * from its own. It rejects when a script cannot meet what the workflow asked, or leaves a list
 * unfinished, or the run stalls: those fail the test, never the workflow.
 */
export async function testWorkflow<Args extends JsonValue, Result extends JsonValue>(
  workflow: WorkflowDefinition<Args, Result> | ExecutableWorkflow<Args, Result>,
  args: NoInfer<Args>,
  options: TestOptions = {},
): Promise<TestRun<Result>> {
  const definition = isExecutable(workflow) ? workflow.definition : workflow;
  const scripts = new Scripts(options.agents);
  const compactionScripts = new Scripts(options.compactions, {
    noun: "compaction",
    option: "compactions",
  });
  if (options.values !== undefined && options.fromStage === undefined) {
    throw new Error("values give the stages before fromStage: give fromStage too");
  }
  const stopping = new AbortController();
  const problems: string[] = [];
  const stallMs = options.stallMs ?? 2_000;
  let stall: ReturnType<typeof setTimeout> | undefined;
  const events = {
    onActivity() {
      clearTimeout(stall);
      stall = setTimeout(() => {
        const waiting = host
          .inFlight()
          .map((turn) => `"${turn.agent}" turn ${turn.n}${turn.nudge ? " (nudge)" : ""}`);
        stopWith(
          `the run stalled: nothing started or ended for ${stallMs} ms; ${
            waiting.length > 0 ? `in flight: ${waiting.join(", ")}` : "no turn in flight"
          }`,
        );
      }, stallMs);
    },
    onScriptError: (message: string) => stopWith(message),
  };
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
    events,
    options.caller ? { harness: options.caller.harness, cwd } : undefined,
  );
  const decisions = createScriptedDecisions(options.decisions ?? {}, events);
  const logs: TestRun<Result>["logs"] = [];
  // Sandboxes are opened by a provider that confines nothing and hosts panes.
  const sandboxes = createFakeSandboxProvider({ panes: { prelude: "true", ready: "ready" } });

  let settled: { value: Result } | { error: unknown };
  let sandboxOf = new Map<string, AgentSandbox>();
  let stages: StageRecord[] = [];
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
    const result = await runWorkflow(definition, args, {
      runRoot,
      livenessPolicy: { quietMs: 1, responseMs: 25, deliveryMs: 100, releaseMs: 1000 },
      run: {
        dir: run.dir,
        id: run.record.id,
        attempt: options.recorded ? 2 : 1,
        ...(options.fromStage === undefined ? {} : { fromStage: options.fromStage }),
        ...(options.values === undefined
          ? {}
          : { values: new Map(Object.entries(options.values)) }),
      },
      cwd,
      deadline: { unixMilliseconds: Date.now() + (options.timeoutMs ?? 30 * 60_000) },
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
    for (const path of temporary) rmSync(path, { recursive: true, force: true });
  }
  if (problems.length === 0) {
    const leftovers = [...scripts.leftovers(), ...compactionScripts.leftovers()];
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
    turnsOf: (agent) => host.turns.filter((turn) => turn.agent === agent),
    compactions: host.compactions,
    compactionsOf: (agent) => host.compactions.filter((compaction) => compaction.agent === agent),
    sets: host.sets,
    setsOf: (agent) => host.sets.filter((set) => set.agent === agent),
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
