import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AbsoluteDeadline, HarnessKind, TurnLogin } from "@agentswf/contract/workflow";
import type {
  AgentSessionAdapter,
  AuthoredTurn,
  CallingSession,
  HarnessActivation,
  HarnessOperationBinding,
  NativeFork,
  SessionCopy,
  SessionSettings,
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
  /** The model and effort the session is at: as activated, then as the last `set` left them. */
  settings: SessionSettings;
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
  /** On a failed turn: its harness showed it cannot sign in. */
  login?: TurnLogin;
  durationMs?: number;
  act?: (context: FakeAdapterTurnContext) => void | Promise<void>;
};

/** A switch the fake was asked for: the agent, the settings it was at, and those asked for. */
export type FakeSet = {
  activation: HarnessActivation;
  previous: SessionSettings;
  settings: SessionSettings;
  signal: AbortSignal;
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
    supportsWaiting?: boolean | ((activation: HarnessActivation) => boolean);
    /** A reason to refuse this agent, as a real adapter refuses one it cannot run. */
    refuse?: (activation: HarnessActivation) => string | undefined;
    /**
     * Whether this agent forks, as its real host would; absent, none does. A forked session is
     * continued wherever `continues` is passed on.
     */
    forks?: (activation: HarnessActivation) => boolean;
    onFork?: (fork: FakeFork) => void;
    /**
     * Its session is found, not opened, as a handed-over calling session's is: forked by `found`'s
     * own fork, before any turn.
     */
    found?: CallingSession;
    /**
     * Whether this agent switches its model and effort, as its real host would; absent, none
     * does. Given, it is asked for each switch and refuses with the reason it returns.
     */
    sets?: (activation: HarnessActivation) => boolean;
    onSet?: (set: FakeSet) => string | undefined | Promise<string | undefined>;
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
      const { found } = options;
      const forks = options.forks?.(activation) ?? false;
      const { model, effort } = activation.execution;
      let settings: SessionSettings = { model, ...(effort === undefined ? {} : { effort }) };
      return {
        ...((
          typeof options.supportsWaiting === "function"
            ? options.supportsWaiting(activation)
            : options.supportsWaiting
        )
          ? { confirmsDelivery: true as const }
          : {}),
        identity: { sessionId, cwd: activation.cwd },
        ...(found
          ? {
              found: found.session,
              fork: (_session: string, deadline: AbsoluteDeadline, into?: SessionCopy) =>
                found.fork(deadline, into),
            }
          : {}),
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
        ...(options.sets?.(activation)
          ? {
              async set(next: SessionSettings) {
                if (isClosed) throw new Error("fake session is closed");
                const controller = new AbortController();
                activeController = controller;
                try {
                  const refused = await options.onSet?.({
                    activation,
                    previous: settings,
                    settings: next,
                    signal: controller.signal,
                  });
                  if (refused) throw new Error(refused);
                  settings = next;
                } finally {
                  if (activeController === controller) activeController = undefined;
                }
              },
            }
          : {}),
        promptedAt: () => firstPrompt,
        async execute(operation) {
          if (isClosed) throw new Error("fake session is closed");
          if (operation.deliverySignal?.aborted) {
            return { state: "cancelled", resultEvidence: { kind: "unavailable" }, chargesUsd: [] };
          }
          operation.onDispatched?.();
          operation.onAccepted?.();
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
            settings,
            signal: controller.signal,
          };
          turns.push(context);
          try {
            const scripted = await options.script(context);
            await scripted.act?.(context);
            // Script preparation and its response are one synthetic agent action.
            operation.onReceived?.();
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
              ...(scripted.login && !controller.signal.aborted ? { login: scripted.login } : {}),
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

/**
 * A session a run was started from, as the fake has it: its fork carries `model`, the model its
 * files show; without one it rejects, as a real one does where they name none (story 027).
 */
export function createFakeCallingSession(options: {
  harness: HarnessKind;
  cwd: string;
  model?: string;
  session?: string;
  onFork?: (sessionRef: string) => void;
}): CallingSession {
  const session = options.session ?? "fake-calling";
  return {
    harness: options.harness,
    session,
    cwd: options.cwd,
    async fork(_deadline, into) {
      if (!options.model) throw new Error("the calling session's files name no model it ran on");
      if (into) await mkdir(into.directory, { recursive: true });
      const sessionRef = `${session}/${into ? "copy" : "fork"}-${randomUUID()}`;
      options.onFork?.(sessionRef);
      return {
        harness: options.harness,
        sessionRef,
        ...(into ? { copied: true as const } : {}),
        model: options.model,
      };
    },
  };
}
