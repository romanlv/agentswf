import type {
  AgentSession,
  AgentSessionBackend,
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
  /** What the agent writes to its terminal. A blind backend keeps it and shows nobody. */
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

export type FakeBackend = AgentSessionBackend & {
  opened: { callId: string; step: Step }[];
  prompts: { callId: string; turn: number; text: string }[];
  closed: string[];
};

export function createFakeBackend(options: {
  script: FakeScript;
  kind?: BackendKind;
  clock?: ManualClock;
  /** A pane cannot be read back reliably; `true` models that. */
  blind?: boolean;
  /** Throws instead of opening, the way a busy Herdr server does. */
  openError?: string;
}): FakeBackend {
  const backend: FakeBackend = {
    kind: options.kind ?? "headless",
    opened: [],
    prompts: [],
    closed: [],
    async open(step: Step, call: CallIdentity): Promise<AgentSession> {
      if (options.openError) throw new Error(options.openError);
      backend.opened.push({ callId: call.callId, step });
      let turn = 0;
      let transcript = "";

      return {
        async prompt(text: string) {
          turn += 1;
          backend.prompts.push({ callId: call.callId, turn, text });
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
          backend.closed.push(call.callId);
        },
      };
    },
  };
  return backend;
}
