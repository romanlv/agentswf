import type { SandboxRecord } from "@agentswf/contract/records";
import { WIRE_VERSION } from "@agentswf/contract/wire";
import type { AgentExecution, AgentPlacement, JsonObject } from "@agentswf/contract/workflow";
import {
  createPlacementHostFactory,
  createSingleSessionHostFactory,
  headlessRefusal,
  PLACEMENT_HARNESSES,
} from "@agentswf/harness";
import type { AgentRunHostFactory } from "@agentswf/harness/adapter";
import {
  createFakeAdapter,
  type FakeAdapterTurn,
  type FakeAdapterTurnContext,
} from "@agentswf/harness/testing";
import { submitResult } from "@agentswf/wf/client";
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
};

/** The sandbox an agent ran in, as the run's record keeps it. */
export type AgentSandbox = Pick<SandboxRecord, "key" | "provider" | "spec" | "domains">;

export type ScriptedHost = {
  factory: AgentRunHostFactory;
  turns: TurnRecord[];
  compactions: CompactionRecord[];
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
): ScriptedHost {
  const turns: TurnRecord[] = [];
  const compactions: CompactionRecord[] = [];
  const compactionCounts = new Map<string, number>();
  const agents: OpenedAgent[] = [];
  const open = new Set<TurnRecord>();
  const counts = new Map<string, number>();
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
    if (ending.kind === "hang") {
      return {
        act: async (turn) => {
          await whenAborted(turn.signal);
          end(record, "hang");
        },
      };
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
    if (ending.kind === "hang") {
      return {
        act: async (turn) => {
          await whenAborted(turn.signal);
          done("hang");
        },
      };
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
      cwd: activation.cwd,
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
        placement,
        launchesInSandbox: true,
        givesSkills: true,
        ...(placement === "headless" ? { refuse: headlessRefusal } : {}),
        script,
      }),
    );
  const placed = createPlacementHostFactory({ pane: side("pane"), headless: side("headless") });

  return {
    factory: {
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
            });
            return session;
          },
        };
      },
    },
    turns,
    compactions,
    agents,
    inFlight: () => [...open],
  };
}

function whenAborted(signal: AbortSignal): Promise<"cancelled"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("cancelled");
    else signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });
}
