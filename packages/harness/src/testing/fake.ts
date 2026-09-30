import type {
  AgentSessionAdapter,
  AuthoredTurn,
  HarnessActivation,
  HarnessOperationBinding,
} from "../adapter";
import { createSessionAdapter, type SessionAdapterOptions } from "../session-core";

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

export type FakeAdapterTurnContext = {
  activation: HarnessActivation;
  id: string;
  prompt: string;
  kind: "turn" | "nudge" | "compact";
  authored?: AuthoredTurn;
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
  chargesUsd?: readonly number[];
  durationMs?: number;
  act?: (context: FakeAdapterTurnContext) => void | Promise<void>;
};

export type FakeAgentSessionAdapter = AgentSessionAdapter & {
  activations: HarnessActivation[];
  turns: FakeAdapterTurnContext[];
  closed: string[];
};

/** `placement`, `launchesInSandbox` and `givesSkills` are passed on: it launches nothing itself. */
export function createFakeAdapter(
  options: {
    script: (context: FakeAdapterTurnContext) => FakeAdapterTurn | Promise<FakeAdapterTurn>;
    harnesses?: readonly [string, ...string[]];
    clock?: ManualClock;
    /** A reason to refuse this agent, as a real adapter refuses one it cannot run. */
    refuse?: (activation: HarnessActivation) => string | undefined;
  } & Pick<SessionAdapterOptions, "placement" | "launchesInSandbox" | "givesSkills">,
): FakeAgentSessionAdapter {
  const activations: HarnessActivation[] = [];
  const turns: FakeAdapterTurnContext[] = [];
  const closed: string[] = [];
  const adapter = createSessionAdapter({
    harnesses: options.harnesses ?? ["fake"],
    ...(options.clock ? { now: options.clock.now } : {}),
    ...(options.placement ? { placement: options.placement } : {}),
    ...(options.launchesInSandbox ? { launchesInSandbox: options.launchesInSandbox } : {}),
    ...(options.givesSkills ? { givesSkills: options.givesSkills } : {}),
    async activate(activation) {
      const refused = options.refuse?.(activation);
      if (refused) throw new Error(refused);
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
            ...(operation.authored ? { authored: operation.authored } : {}),
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
              state: controller.signal.aborted ? "cancelled" : (scripted.state ?? "completed"),
              ...(controller.signal.aborted
                ? { detail: "fake operation cancelled" }
                : scripted.detail
                  ? { detail: scripted.detail }
                  : {}),
              resultEvidence: scripted.transcript
                ? ({ kind: "transcript", text: scripted.transcript } as const)
                : ({ kind: "unavailable" } as const),
              ...(scripted.sessionRef ? { sessionRef: scripted.sessionRef } : {}),
              chargesUsd: scripted.chargesUsd ?? [],
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
