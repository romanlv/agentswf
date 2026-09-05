import type {
  AgentSessionAdapter,
  HarnessActivation,
  HarnessOperationBinding,
} from "../adapter";
import { createSessionAdapter } from "../session-core";
import type { TurnUsage } from "../spec";
import type {
  AgentSession,
  AgentSessionDriver,
  BackendKind,
  CallIdentity,
  SettledState,
  Step,
} from "../types";

/**
 * A scriptable stand-in for a real agent, so a nudge policy, a tally, or a result layer is
 * proven against recorded turns instead of tokens. The fake knows nothing about how a value
 * gets reported; a caller supplies that as an `act`, driving the same code path a live agent
 * would, so a passing test says the channel works rather than that the double works.
 */
export type FakeTurnContext = {
  runDir: string;
  callId: string;
  step: Step;
  prompt: string;
  /** 1 for the task, 2 for the nudge. */
  turn: number;
  /** What the agent writes to its terminal. A blind driver keeps it and shows nobody. */
  print(text: string): void;
};

export type FakeTurn = {
  act?: (context: FakeTurnContext) => void | Promise<void>;
  state?: SettledState;
  detail?: string;
  durationMs?: number;
};

export type FakeScript = (context: FakeTurnContext) => FakeTurn | Promise<FakeTurn>;

export type ManualClock = { now(): number; advance(ms: number): void };

export function createManualClock(start = 0): ManualClock {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

export type FakeSessionDriver = AgentSessionDriver & {
  opened: { callId: string; step: Step }[];
  prompts: { callId: string; turn: number; text: string }[];
  closed: string[];
};

export function createFakeSessionDriver(options: {
  script: FakeScript;
  kind?: BackendKind;
  clock?: ManualClock;
  /** A pane cannot be read back reliably; `true` models that. */
  blind?: boolean;
  /** Throws instead of opening, the way a busy Herdr server does. */
  openError?: string;
}): FakeSessionDriver {
  const driver: FakeSessionDriver = {
    kind: options.kind ?? "headless",
    opened: [],
    prompts: [],
    closed: [],
    async open(step: Step, call: CallIdentity): Promise<AgentSession> {
      if (options.openError) throw new Error(options.openError);
      driver.opened.push({ callId: call.callId, step });
      let turn = 0;
      let transcript = "";

      return {
        async prompt(text: string) {
          turn += 1;
          driver.prompts.push({ callId: call.callId, turn, text });
          const context: FakeTurnContext = {
            runDir: call.runDir,
            callId: call.callId,
            step,
            prompt: text,
            turn,
            print: (output) => {
              transcript += `${output}\n`;
            },
          };
          const scripted = await options.script(context);
          await scripted.act?.(context);
          options.clock?.advance(scripted.durationMs ?? 0);
          return {
            state: scripted.state ?? "idle",
            ...(scripted.detail ? { detail: scripted.detail } : {}),
          };
        },
        async transcript() {
          return options.blind ? null : transcript;
        },
        async close() {
          driver.closed.push(call.callId);
        },
      };
    },
  };
  return driver;
}

export type FakeAdapterTurnContext = {
  activation: HarnessActivation;
  id: string;
  prompt: string;
  kind: "turn" | "nudge" | "compact";
  binding?: HarnessOperationBinding;
  previousSessionRef?: string;
  turn: number;
  signal: AbortSignal;
};

export type FakeAdapterTurn = {
  state?: "completed" | "blocked" | "timed-out" | "failed" | "cancelled";
  detail?: string;
  transcript?: string;
  sessionRef?: string;
  nativeUsage?: readonly TurnUsage[];
  durationMs?: number;
  act?: (context: FakeAdapterTurnContext) => void | Promise<void>;
};

export type FakeAgentSessionAdapter = AgentSessionAdapter & {
  activations: HarnessActivation[];
  turns: FakeAdapterTurnContext[];
  closed: string[];
};

export function createFakeAdapter(options: {
  script: (context: FakeAdapterTurnContext) => FakeAdapterTurn | Promise<FakeAdapterTurn>;
  harnesses?: readonly [string, ...string[]];
  clock?: ManualClock;
}): FakeAgentSessionAdapter {
  const activations: HarnessActivation[] = [];
  const turns: FakeAdapterTurnContext[] = [];
  const closed: string[] = [];
  const adapter = createSessionAdapter({
    harnesses: options.harnesses ?? ["fake"],
    ...(options.clock ? { now: options.clock.now } : {}),
    async activate(activation) {
      activations.push(activation);
      let turn = 0;
      let isClosed = false;
      let activeController: AbortController | undefined;
      let activeCompletion: Promise<void> | undefined;
      return {
        identity: {
          sessionId: `fake-${activation.key}`,
          cwd: activation.cwd,
        },
        async execute(operation) {
          if (isClosed) throw new Error("fake session is closed");
          const controller = new AbortController();
          activeController = controller;
          let finish!: () => void;
          activeCompletion = new Promise<void>((resolve) => {
            finish = resolve;
          });
          turn += 1;
          const context: FakeAdapterTurnContext = {
            activation,
            id: operation.id,
            prompt: operation.prompt,
            kind: operation.kind,
            ...(operation.binding ? { binding: operation.binding } : {}),
            ...(operation.previousSessionRef
              ? { previousSessionRef: operation.previousSessionRef }
              : {}),
            turn,
            signal: controller.signal,
          };
          turns.push(context);
          try {
            const scripted = await options.script(context);
            await scripted.act?.(context);
            options.clock?.advance(scripted.durationMs ?? 0);
            return {
              state: controller.signal.aborted ? "cancelled" : scripted.state ?? "completed",
              ...(controller.signal.aborted
                ? { detail: "fake operation cancelled" }
                : scripted.detail
                  ? { detail: scripted.detail }
                  : {}),
              resultEvidence: scripted.transcript
                ? ({ kind: "transcript", text: scripted.transcript } as const)
                : ({ kind: "unavailable" } as const),
              ...(scripted.sessionRef ? { sessionRef: scripted.sessionRef } : {}),
              nativeUsage: scripted.nativeUsage ?? [],
            };
          } finally {
            if (activeController === controller) activeController = undefined;
            finish();
          }
        },
        async cancel() {
          if (!activeController) return false;
          activeController.abort();
          await activeCompletion;
          return true;
        },
        async close() {
          if (isClosed) return;
          activeController?.abort();
          await activeCompletion;
          isClosed = true;
          closed.push(activation.key);
        },
      };
    },
  });
  return Object.assign(adapter, { activations, turns, closed });
}
