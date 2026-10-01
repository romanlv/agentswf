import {
  type AbsoluteDeadline,
  type AgentPlacement,
  type AgentStructuredTurnSpec,
  type AgentTextTurnSpec,
  DeadlineExceededError,
  type HarnessKind,
  type JsonValue,
  placementOf,
} from "@agentswf/contract/workflow";
import type {
  AgentSessionAdapter,
  AuthoredTurn,
  HarnessActivation,
  HarnessAuthored,
  HarnessNudgeSpec,
  HarnessOperationBinding,
  HarnessReleaseDisposition,
  HarnessSession,
  HarnessSessionStatus,
  HarnessTurn,
  HarnessTurnOutcome,
} from "./adapter";

export type NativeTurnRequest = {
  id: string;
  prompt: string;
  deadline: AbsoluteDeadline;
  binding?: HarnessOperationBinding;
  previousSessionRef?: string;
  kind: "turn" | "nudge" | "compact";
  /** Only a backend that answers as the agent reads it; see `HarnessAuthored`. */
  authored?: AuthoredTurn;
};

export type NativeTurnOutcome = HarnessTurnOutcome & { sessionRef?: string };

/** An outcome the backend decided on its own, with no native evidence behind it. */
export function localOutcome(state: "failed" | "timed-out" | "cancelled", detail: string) {
  return {
    state,
    detail,
    resultEvidence: { kind: "unavailable" } as const,
    chargesUsd: [],
  };
}

type NativeSessionIdentity = {
  sessionId: string;
  cwd: string;
};

export type ActivatedSessionBackend = {
  readonly identity: NativeSessionIdentity;
  execute(request: NativeTurnRequest): Promise<NativeTurnOutcome>;
  close(reason?: string): Promise<void>;
} & (
  | { cancel?(reason?: string): Promise<boolean>; readonly finishesAnswered?: false }
  | {
      cancel(reason?: string): Promise<boolean>;
      /**
       * The next turn resumes this session, so an answered turn is left to end on its own:
       * stopping it would cut the conversation off after the answering tool call. A turn left
       * finishing must be stoppable, or a follow-up could wait on it forever.
       */
      readonly finishesAnswered: true;
      /**
       * Stops a turn left finishing without ending the session, where `cancel` would: a pane's
       * agent lives on in its pane, and only the wait on it stops. Absent, `cancel` stops it.
       */
      stopFinishing?(reason: string): Promise<boolean>;
      /** The active turn was answered and is left to end on its own. */
      leftFinishing?(): void;
    }
);

/**
 * How long an answered turn may go on before it is stopped. A closing message takes a few seconds
 * (story 002); an agent still working after answering would otherwise keep spending, and keep
 * changing files the rest of the workflow reads, until the run ends. When the run ends first, the
 * engine's own shorter wait bounds it instead, since closing the host ends the turn.
 */
const DEFAULT_FINISH_GRACE_MS = 30_000;

export type SessionAdapterOptions = {
  harnesses: readonly [HarnessKind, ...HarnessKind[]];
  /** The one placement this adapter provides; an agent asking for the other is refused. */
  placement?: AgentPlacement;
  /** It launches through an occupant; without this, a sandboxed agent is refused. */
  launchesInSandbox?: true;
  /** It launches with `request.skills`; without this, an agent given skills is refused. */
  givesSkills?: true;
  finishGraceMs?: number;
  activate(request: HarnessActivation): Promise<ActivatedSessionBackend>;
  now?: () => number;
};

export function createSessionAdapter(options: SessionAdapterOptions): AgentSessionAdapter {
  const now = options.now ?? Date.now;
  return {
    harnesses: options.harnesses,
    capabilities: { outsideWake: false },
    async activate(request) {
      assertDeadline(request.deadline, now);
      if (!options.harnesses.includes(request.execution.harness)) {
        throw new Error(`adapter does not support harness ${request.execution.harness}`);
      }
      const placement = placementOf(request.execution);
      if (options.placement && placement !== options.placement) {
        throw new Error(`adapter runs ${options.placement} agents, not ${placement}`);
      }
      if (request.occupant && !options.launchesInSandbox) {
        throw new Error(`${placement} agents cannot run in a sandbox yet`);
      }
      if (request.skills && !options.givesSkills) {
        throw new Error(`${placement} agents cannot be given skills by this adapter`);
      }
      const native = await options.activate(request);
      if (expired(request.deadline, now)) {
        await native.close("activation deadline exceeded");
        throw new DeadlineExceededError(request.deadline);
      }
      return createSession(native, now, options.finishGraceMs ?? DEFAULT_FINISH_GRACE_MS);
    },
  };
}

function createSession(
  native: ActivatedSessionBackend,
  now: () => number,
  finishGraceMs: number,
): HarnessSession {
  let closed = false;
  let active = false;
  let quarantined = false;
  let closeAttempt: Promise<void> | undefined;
  let lastStatus: HarnessSessionStatus = { state: "idle" };
  let sessionRef: string | undefined;
  /** An answered turn left to end on its own; the next start waits for it. */
  let finishing: { settled: Promise<unknown>; stop(reason: string): Promise<boolean> } | undefined;
  /** Only the newest turn's end may set the session's status. */
  let turns = 0;
  /** Starts waiting for a finishing turn to end: the session is working on their behalf. */
  let waiting = 0;
  const seen = new Set<string>();
  const usedOperationIds = new Set<string>();

  /**
   * Waits out a turn left finishing, for half the new operation's time at most so it can still run
   * once the old turn is stopped, then opens the new one.
   */
  const afterFinishing = async (
    deadline: AbsoluteDeadline,
    open: () => HarnessTurn,
  ): Promise<HarnessTurn> => {
    const pending = finishing;
    if (!pending) return open();
    waiting += 1;
    try {
      const wait = (deadline.unixMilliseconds - now()) / 2;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = await Promise.race([
        pending.settled.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, wait));
        }),
      ]);
      clearTimeout(timer);
      if (!ended) {
        await pending.stop("the previous turn did not end after its answer");
        await pending.settled;
      }
    } finally {
      waiting -= 1;
    }
    return open();
  };

  const start = (request: NativeTurnRequest): HarnessTurn => {
    if (closed) throw new Error("harness session is closed");
    if (quarantined) throw new Error("harness session is quarantined");
    if (closeAttempt) throw new Error("harness session is closing");
    if (active) throw new Error("harness session already has an active operation");
    assertDeadline(request.deadline, now);
    if (request.binding && request.kind !== "nudge") {
      if (usedOperationIds.has(request.binding.operationId)) {
        throw new Error("harness operation id has already been used in this session");
      }
      usedOperationIds.add(request.binding.operationId);
    }
    active = true;
    lastStatus = { state: "working" };
    const generation = ++turns;
    /** Set once this turn is answered and left to end on its own. */
    let leftFinishing = false;
    const settled = native
      .execute({ ...request, ...(sessionRef ? { previousSessionRef: sessionRef } : {}) })
      .catch(
        (error): NativeTurnOutcome => ({
          state: "failed",
          detail: reasonOf(error),
          resultEvidence: { kind: "unavailable" },
          chargesUsd: [],
        }),
      )
      .then(
        (outcome): NativeTurnOutcome =>
          // Its answer was taken in time; ending after the deadline is not a timeout.
          !leftFinishing &&
          expired(request.deadline, now) &&
          outcome.state !== "cancelled" &&
          outcome.state !== "timed-out"
            ? {
                ...outcome,
                state: "timed-out",
                detail: "operation completed after its deadline",
              }
            : outcome,
      )
      .then((outcome) => {
        // Whatever ended the turn, the native session it names is the one to continue.
        if (outcome.sessionRef) {
          seen.add(outcome.sessionRef);
          sessionRef = outcome.sessionRef;
        }
        const reported = withoutSessionRef(outcome);
        if (!quarantined && generation === turns) {
          // An answered turn ending leaves the agent ready for the next operation.
          lastStatus = leftFinishing ? { state: "idle" } : outcomeStatus(reported);
        }
        return reported;
      })
      .finally(() => {
        active = false;
      });

    let nudged = false;
    return {
      settled,
      async deliver() {
        throw new Error("harness delivery is unavailable until messaging acknowledgement exists");
      },
      async nudge(spec: HarnessNudgeSpec) {
        if (request.kind === "nudge") throw new Error("harness turn permits at most one nudge");
        if (nudged) throw new Error("harness turn has already been nudged");
        if (!request.binding) throw new Error("harness turn has no result authority to reuse");
        nudged = true;
        await settled;
        return start({
          id: spec.id,
          prompt: spec.prompt ?? "Provide the requested result now.",
          deadline: spec.deadline,
          binding: request.binding,
          kind: "nudge",
          ...(spec.authored ? { authored: spec.authored } : {}),
        });
      },
      async release(reason, deadline, options): Promise<HarnessReleaseDisposition> {
        if (options?.answered && native.finishesAnswered) {
          // Already ended: there is nothing to stop, and stopping a pane would close it.
          if (!active) return { kind: "released", outcome: await settled };
          leftFinishing = true;
          native.leftFinishing?.();
          const stop = native.stopFinishing ?? native.cancel;
          const left = { settled, stop: (why: string) => stop.call(native, why) };
          finishing = left;
          const limit = setTimeout(() => {
            void left.stop("the answered turn did not end within its grace");
          }, finishGraceMs);
          void settled.finally(() => {
            clearTimeout(limit);
            if (finishing === left) finishing = undefined;
          });
          return { kind: "finishing" };
        }
        const releasing = Promise.resolve()
          .then(() => native.cancel?.(reason))
          .then(() => settled);
        const disposition = await releaseBefore(releasing, deadline, now);
        if (disposition.kind === "quarantined") {
          quarantined = true;
          lastStatus = { state: "quarantined", detail: disposition.reason };
        }
        return disposition;
      },
    };
  };

  const session: HarnessSession = {
    async status() {
      if (closed) return { state: "missing" };
      if (quarantined) return lastStatus;
      return active || waiting > 0 ? { state: "working" } : lastStatus;
    },
    async start(
      turn: (AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>) & HarnessAuthored,
      binding: HarnessOperationBinding,
    ) {
      return afterFinishing(turn.deadline, () =>
        start({
          id: turn.id,
          prompt: turn.prompt,
          deadline: turn.deadline,
          binding,
          kind: "turn",
          ...(turn.authored ? { authored: turn.authored } : {}),
        }),
      );
    },
    compact: (id, prompt, deadline) =>
      afterFinishing(deadline, () => start({ id, prompt, deadline, kind: "compact" })),
    sessions: () => [...seen],
    async close(reason?: string) {
      if (closed) return;
      closeAttempt ??= native
        .close(reason)
        .catch((error: unknown) => {
          throw new Error(reasonOf(error));
        })
        .then(() => {
          closed = true;
        });
      try {
        await closeAttempt;
      } finally {
        if (!closed) closeAttempt = undefined;
      }
    },
  };
  return session;
}

function assertDeadline(deadline: AbsoluteDeadline, now: () => number): void {
  if (expired(deadline, now)) throw new DeadlineExceededError(deadline);
}

function expired(deadline: AbsoluteDeadline, now: () => number): boolean {
  return now() >= deadline.unixMilliseconds;
}

async function releaseBefore(
  releasing: Promise<HarnessTurnOutcome>,
  deadline: AbsoluteDeadline,
  now: () => number,
): Promise<HarnessReleaseDisposition> {
  const remaining = deadline.unixMilliseconds - now();
  if (remaining <= 0) return { kind: "quarantined", reason: "release deadline exceeded" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), remaining);
  });
  try {
    const outcome = await Promise.race([releasing, expiry]);
    return outcome === "expired"
      ? { kind: "quarantined", reason: "release deadline exceeded" }
      : { kind: "released", outcome };
  } catch {
    return { kind: "quarantined", reason: "native release failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function outcomeStatus(outcome: HarnessTurnOutcome): HarnessSessionStatus {
  switch (outcome.state) {
    case "completed":
      return { state: "idle" };
    case "blocked":
      return { state: "blocked", ...(outcome.detail ? { detail: outcome.detail } : {}) };
    case "cancelled":
      return { state: "dormant", ...(outcome.detail ? { detail: outcome.detail } : {}) };
    case "timed-out":
    case "failed":
      return { state: "unknown", ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `sessionRef` is the harness's own handle for resuming; the engine is given the rest. */
function withoutSessionRef(outcome: NativeTurnOutcome): HarnessTurnOutcome {
  const { sessionRef: _sessionRef, ...reported } = outcome;
  return reported;
}
