import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type {
  AgentSessionAdapter,
  AuthoredTurn,
  HarnessActivation,
  HarnessOperationBinding,
  NativeFork,
  SessionCopy,
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
  /** A compaction's summary: set, the harness confirmed it compacted. */
  summary?: string;
  durationMs?: number;
  act?: (context: FakeAdapterTurnContext) => void | Promise<void>;
};

/** A fork the fake made: the agent it copied, the new session, and that agent's turns so far. */
export type FakeFork = { activation: HarnessActivation; sessionRef: string; turns: number };

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
    /**
     * Whether this agent forks, as its real host would; absent, none does. A forked session is
     * continued wherever `continues` is passed on.
     */
    forks?: (activation: HarnessActivation) => boolean;
    onFork?: (fork: FakeFork) => void;
  } & Pick<SessionAdapterOptions, "placement" | "launchesInSandbox" | "givesSkills" | "continues">,
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
    ...(options.continues ? { continues: options.continues } : {}),
    async activate(activation) {
      const refused = options.refuse?.(activation);
      if (refused) throw new Error(refused);
      activations.push(activation);
      let turn = 0;
      let isClosed = false;
      let activeController: AbortController | undefined;
      let activeCompletion: Promise<void> | undefined;
      let firstPrompt: number | undefined;
      // A copied session is forked in the new agent's home as it is activated.
      const sessionId = activation.continues
        ? `${activation.continues.sessionRef}${activation.continues.copied ? "/forked" : ""}`
        : `fake-${activation.key}`;
      const forks = options.forks?.(activation) ?? false;
      return {
        identity: { sessionId, cwd: activation.cwd },
        ...(forks
          ? {
              async fork(sessionRef: string, _deadline, into?: SessionCopy): Promise<NativeFork> {
                if (isClosed) throw new Error("fake session is closed");
                // A real harness copies its session's files there.
                if (into) await mkdir(into.directory, { recursive: true });
                const fork = {
                  harness: activation.execution.harness,
                  sessionRef: `${sessionRef}/${into ? "copy" : "fork"}-${randomUUID()}`,
                  ...(into ? { copied: true as const } : {}),
                };
                options.onFork?.({ activation, sessionRef: fork.sessionRef, turns: turn });
                return fork;
              },
            }
          : {}),
        promptedAt: () => firstPrompt,
        async execute(operation) {
          if (isClosed) throw new Error("fake session is closed");
          firstPrompt ??= options.clock?.now() ?? Date.now();
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
              // Every turn names its session, as a real harness's output does.
              sessionRef: scripted.sessionRef ?? sessionId,
              chargesUsd: scripted.chargesUsd ?? [],
              ...(scripted.summary === undefined || controller.signal.aborted
                ? {}
                : { summary: scripted.summary }),
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
