import type { SandboxRecord } from "@agentswf/contract/records";
import { WIRE_VERSION } from "@agentswf/contract/wire";
import {
  type AgentExecution,
  type AgentPlacement,
  type Effort,
  type JsonObject,
  placementOf,
} from "@agentswf/contract/workflow";
import {
  createPlacementHostFactory,
  createSingleSessionHostFactory,
  findHarness,
  headlessRefusal,
  PLACEMENT_HARNESSES,
  settingsRefusal,
} from "@agentswf/harness";
import type { AgentRunHostFactory, HarnessActivation } from "@agentswf/harness/adapter";
import {
  createFakeAdapter,
  type FakeAdapterTurn,
  type FakeAdapterTurnContext,
  type FakeFork,
  type FakeSet,
} from "@agentswf/harness/testing";
import { submitResult, submitWaiting } from "@agentswf/wf/client";
import type { Scripts, Step, Turn, TurnOutcome } from "./script";

/** A turn as the workflow wrote it, and how it ended. */
export type TurnRecord = Omit<Turn, "signal"> & { outcome: TurnOutcome };

/** A compaction as the workflow asked for it, and how it ended. */
export type CompactionRecord = {
  agent: string;
  /** 1-based among the agent's compactions. */
  n: number;
  id: string;
  /** The spec's prompt: what the harness is to keep and drop. */
  focus: string;
  outcome: TurnOutcome;
};

/** A switch of an agent's model or effort, as the host was asked for it. */
export type SetRecord = {
  agent: string;
  /** 1-based among the agent's switches. */
  n: number;
  /** The settings switched to, whole. */
  model: string;
  effort?: Effort;
};

/** An agent the workflow opened, as it opened it. */
export type OpenedAgent = {
  key: string;
  execution: AgentExecution;
  instructions?: string;
  labels?: JsonObject;
  /** The skills it was given by name; absent when the workflow named none. */
  skills?: readonly string[];
  /** The sandbox it ran in; absent on the host. */
  sandbox?: AgentSandbox;
  /** The agent it was forked from, and how many of that agent's turns its copy holds. */
  forkedFrom?: { key: string; turns: number };
};

/** The sandbox an agent ran in, as the run's record keeps it. */
export type AgentSandbox = Pick<SandboxRecord, "key" | "provider" | "spec" | "domains">;

export type ScriptedHost = {
  factory: AgentRunHostFactory;
  turns: TurnRecord[];
  compactions: CompactionRecord[];
  sets: SetRecord[];
  agents: OpenedAgent[];
  /** Turns started and not yet ended, for a stalled run's message. */
  inFlight(): TurnRecord[];
};

/**
 * The run host a workflow's test runs on: the production session core behind each placement,
 * over a fake adapter that answers from the scripts. It refuses the harnesses each real host
 * refuses; the fake sandbox provider hosts panes, so no sandbox is refused one.
 */
export function createScriptedHost(
  scripts: Scripts,
  /** Unscripted, an agent's compactions all answer `""`. */
  compactionScripts: Scripts,
  events: {
    /** A turn started or ended: the run is not stalled. */
    onActivity(): void;
    /** The script could not meet a turn: the test fails. */
    onScriptError(message: string): void;
  },
  /** The session the run is started from, as `awf run --here` finds one (ADR 0010). */
  caller?: { harness: string; cwd: string },
): ScriptedHost {
  const turns: TurnRecord[] = [];
  const compactions: CompactionRecord[] = [];
  const compactionCounts = new Map<string, number>();
  const sets: SetRecord[] = [];
  const agents: OpenedAgent[] = [];
  const open = new Set<TurnRecord>();
  const counts = new Map<string, number>();
  /** Each fork's session, by the agent it copied and that agent's turns so far. */
  const forks = new Map<string, { key: string; turns: number }>();
  const end = (record: TurnRecord, outcome: TurnOutcome) => {
    record.outcome = outcome;
    open.delete(record);
    events.onActivity();
  };
  const failTest = (message: string): FakeAdapterTurn => {
    events.onScriptError(message);
    return { state: "failed", detail: message };
  };

  const perform = (
    step: Step,
    context: FakeAdapterTurnContext,
    record: TurnRecord,
  ): FakeAdapterTurn => {
    if (step.kind === "script-error") {
      open.delete(record);
      return failTest(step.message);
    }
    if (step.kind === "answer") {
      return {
        act: async () => {
          // Submitted is answered, even though the engine then releases the turn.
          let outcome: TurnOutcome = "cancelled";
          try {
            const { endpoint, operationId } = context.binding!;
            const response = await submitResult(endpoint, {
              version: WIRE_VERSION,
              command: "result",
              operationId,
              raw: JSON.stringify(step.value),
            });
            outcome = "answered";
            if (response.kind === "rejected") {
              failTest(
                `agent "${record.agent}" turn ${record.n}: the schema refused its script's answer: ${response.error}`,
              );
            }
          } finally {
            end(record, outcome);
          }
        },
      };
    }
    const { ending } = step;
    if (ending.kind === "waiting") {
      return {
        act: async () => {
          const { endpoint, operationId } = context.binding!;
          const response = await submitWaiting(endpoint, {
            version: WIRE_VERSION,
            command: "waiting",
            operationId,
            reason: ending.reason,
            ...(ending.timeoutMs === undefined ? {} : { timeoutMs: ending.timeoutMs }),
          });
          if (response.kind === "rejected") failTest(`waiting rejected: ${response.error}`);
          end(record, "waiting");
        },
      };
    }
    if (ending.kind === "hang") {
      return {
        act: async (turn) => {
          await whenAborted(turn.signal);
          end(record, "hang");
        },
      };
    }
    if (ending.kind === "interrupted") {
      if (!context.activation.execution.caller) {
        open.delete(record);
        return failTest(
          `agent "${record.agent}" turn ${record.n}: only the calling session can be interrupted by the operator`,
        );
      }
      end(record, "interrupted");
      return { state: "cancelled", detail: "interrupted by the operator" };
    }
    end(record, ending.kind);
    return ending.kind === "silent" ? {} : { state: ending.kind, detail: ending.reason };
  };

  const compact = async (context: FakeAdapterTurnContext): Promise<FakeAdapterTurn> => {
    const { activation } = context;
    const n = (compactionCounts.get(activation.key) ?? 0) + 1;
    compactionCounts.set(activation.key, n);
    const record: CompactionRecord = {
      agent: activation.key,
      n,
      id: context.id,
      focus: context.prompt,
      outcome: "hang",
    };
    compactions.push(record);
    const done = (outcome: TurnOutcome) => {
      record.outcome = outcome;
      events.onActivity();
    };
    // What every real host refuses, so a test cannot pass where a run would fail.
    const refused = refusedCompaction(activation, (counts.get(activation.key) ?? 0) > 0);
    if (refused) {
      done("failed");
      return { state: "failed", detail: refused };
    }
    if (!compactionScripts.has(activation.key)) {
      done("answered");
      return { summary: "" };
    }
    const step = await Promise.race([
      compactionScripts.step({
        agent: activation.key,
        n,
        nudge: false,
        prompt: context.prompt,
        cwd: activation.cwd,
        model: context.settings.model,
        ...(context.settings.effort === undefined ? {} : { effort: context.settings.effort }),
        signal: context.signal,
      }),
      whenAborted(context.signal),
    ]);
    if (step === "cancelled") {
      done("cancelled");
      return {};
    }
    if (step.kind === "script-error") return failTest(step.message);
    if (step.kind === "answer") {
      if (typeof step.value !== "string") {
        return failTest(
          `agent "${activation.key}" compaction ${n}: its compaction script answers a summary, text, not ${JSON.stringify(step.value)}`,
        );
      }
      done("answered");
      return { summary: step.value };
    }
    const { ending } = step;
    if (ending.kind === "waiting") return failTest("compaction cannot report waiting");
    if (ending.kind === "hang") {
      return {
        act: async (turn) => {
          await whenAborted(turn.signal);
          done("hang");
        },
      };
    }
    if (ending.kind === "interrupted") {
      return failTest(
        `agent "${activation.key}" compaction ${n}: a compaction is not interrupted by the operator`,
      );
    }
    done(ending.kind);
    return ending.kind === "silent" ? {} : { state: ending.kind, detail: ending.reason };
  };

  const script = async (context: FakeAdapterTurnContext): Promise<FakeAdapterTurn> => {
    events.onActivity();
    if (context.kind === "compact") return compact(context);
    const { authored, activation } = context;
    // The engine hands every turn and nudge what the workflow wrote.
    if (!authored) {
      return failTest(
        `agent "${activation.key}" got a ${context.kind} without what the workflow wrote`,
      );
    }
    const nudge = context.kind === "nudge";
    const n = (counts.get(activation.key) ?? 0) + (nudge ? 0 : 1);
    counts.set(activation.key, n);
    const turn: Turn = {
      agent: activation.key,
      n,
      nudge,
      prompt: authored.prompt,
      ...(authored.schema === undefined ? {} : { schema: authored.schema }),
      ...(authored.label === undefined ? {} : { label: authored.label }),
      ...(authored.stage === undefined ? {} : { stage: authored.stage }),
      cwd: activation.cwd,
      model: context.settings.model,
      ...(context.settings.effort === undefined ? {} : { effort: context.settings.effort }),
      signal: context.signal,
    };
    const { signal: _signal, ...written } = turn;
    const record: TurnRecord = { ...written, outcome: "hang" };
    turns.push(record);
    open.add(record);
    // A script still deciding when the engine cancels the turn is let go.
    const step = await Promise.race([scripts.step(turn), whenAborted(context.signal)]);
    if (step === "cancelled") {
      end(record, "cancelled");
      return {};
    }
    return perform(step, context, record);
  };

  const side = (placement: AgentPlacement) =>
    createSingleSessionHostFactory(
      createFakeAdapter({
        harnesses: PLACEMENT_HARNESSES[placement],
        supportsWaiting: (activation) =>
          placement === "pane" &&
          activation.execution.harness === "claude" &&
          !activation.execution.caller,
        placement,
        launchesInSandbox: true,
        givesSkills: true,
        refuse: (activation: HarnessActivation) =>
          placement === "headless" ? headlessRefusal(activation) : paneRefusal(activation),
        // As the real hosts: each continues a forked session, and forks where the harness can.
        continues: true as const,
        forks: (activation: HarnessActivation) =>
          findHarness(activation.execution.harness)?.forkSession !== undefined,
        onFork: ({ activation, sessionRef }: FakeFork) =>
          forks.set(sessionRef, {
            key: activation.key,
            turns: counts.get(activation.key) ?? 0,
          }),
        // As the real hosts: each switches where the harness can, in its placement.
        sets: (activation: HarnessActivation) =>
          settingsRefusal(activation.execution) === undefined,
        onSet: ({ activation, settings }: FakeSet) => {
          sets.push({
            agent: activation.key,
            n: sets.filter((set) => set.agent === activation.key).length + 1,
            ...settings,
          });
          events.onActivity();
          return undefined;
        },
        script,
      }),
    );
  const placed = createPlacementHostFactory({
    pane: side("pane"),
    headless: side("headless"),
    ...(caller
      ? {
          caller: {
            caller,
            openRun: (spec) =>
              createSingleSessionHostFactory(
                createFakeAdapter({ harnesses: [caller.harness], placement: "pane", script }),
              ).openRun(spec),
          },
        }
      : {}),
  });

  return {
    factory: {
      ...(placed.caller ? { caller: placed.caller } : {}),
      async openRun(spec) {
        const run = await placed.openRun(spec);
        return {
          inspect: () => run.inspect(),
          close: (reason) => run.close(reason),
          async openAgent(request) {
            const session = await run.openAgent(request);
            agents.push({
              key: request.key,
              execution: request.execution,
              ...(request.instructions ? { instructions: request.instructions } : {}),
              ...(request.labels ? { labels: request.labels } : {}),
              ...(request.skills ? { skills: request.skills.names } : {}),
              ...(request.continues && forks.has(request.continues.sessionRef)
                ? { forkedFrom: forks.get(request.continues.sessionRef)! }
                : {}),
            });
            return session;
          },
        };
      },
    },
    turns,
    compactions,
    sets,
    agents,
    inFlight: () => [...open],
  };
}

/** What the pane host refuses before it opens a pane. */
function paneRefusal(activation: HarnessActivation): string | undefined {
  const { harness } = activation.execution;
  const spec = findHarness(harness);
  if (activation.continues && spec && !spec.interactiveResume) {
    return `${harness} panes cannot continue a forked session: ${spec.absent.interactiveResume}`;
  }
  return undefined;
}

function whenAborted(signal: AbortSignal): Promise<"cancelled"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("cancelled");
    else signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });
}

function refusedCompaction(activation: HarnessActivation, hasRun: boolean): string | undefined {
  if (activation.execution.caller) {
    return "the calling session's context is the operator's, so a run does not compact it";
  }
  const spec = findHarness(activation.execution.harness);
  const capability =
    placementOf(activation.execution) === "pane" ? "compactPane" : "compactHeadless";
  if (spec && !spec[capability]) {
    return `${activation.execution.harness} has no compaction of its own: ${spec.absent[capability]}`;
  }
  if (!hasRun) return "there is nothing to compact before the first turn";
  return undefined;
}
