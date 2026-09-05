import {
  DeadlineExceededError,
  type AgentStructuredTurnSpec,
  type AgentTextTurnSpec,
  type AbsoluteDeadline,
  type JsonValue,
} from "@wf/contract/workflow";
import type {
  AgentSessionAdapter,
  HarnessActivation,
  HarnessNudgeSpec,
  HarnessOperationBinding,
  HarnessReleaseDisposition,
  HarnessSession,
  HarnessSessionStatus,
  HarnessTurn,
  HarnessTurnOutcome,
} from "./adapter";
import type { HarnessKind } from "@wf/contract/workflow";

export type NativeTurnRequest = {
  id: string;
  prompt: string;
  deadline: AbsoluteDeadline;
  binding?: HarnessOperationBinding;
  previousSessionRef?: string;
  kind: "turn" | "nudge" | "compact";
};

type NativeTurnOutcome = HarnessTurnOutcome & { sessionRef?: string };

type NativeSessionIdentity = {
  sessionId: string;
  cwd: string;
};

export interface ActivatedSessionBackend {
  readonly identity: NativeSessionIdentity;
  execute(request: NativeTurnRequest): Promise<NativeTurnOutcome>;
  close(reason?: string): Promise<void>;
  cancel?(reason?: string): Promise<boolean>;
}

export function createSessionAdapter(options: {
  harnesses: readonly [HarnessKind, ...HarnessKind[]];
  activate(request: HarnessActivation): Promise<ActivatedSessionBackend>;
  observeSessionRef?: (sessionRef: string) => void;
  now?: () => number;
}): AgentSessionAdapter {
  const now = options.now ?? Date.now;
  return {
    harnesses: options.harnesses,
    capabilities: { outsideWake: false },
    async activate(request) {
      assertDeadline(request.deadline, now);
      if (!options.harnesses.includes(request.execution.harness)) {
        throw new Error(
          `adapter does not support harness ${request.execution.harness}`,
        );
      }
      const native = await options.activate(request);
      if (expired(request.deadline, now)) {
        await native.close("activation deadline exceeded");
        throw new DeadlineExceededError(request.deadline);
      }
      return createSession(native, now, options.observeSessionRef);
    },
  };
}

function createSession(
  native: ActivatedSessionBackend,
  now: () => number,
  observeSessionRef: ((sessionRef: string) => void) | undefined,
): HarnessSession {
  let closed = false;
  let active = false;
  let quarantined = false;
  let closeAttempt: Promise<void> | undefined;
  let lastStatus: HarnessSessionStatus = { state: "idle" };
  let sessionRef: string | undefined;
  const usedOperationIds = new Set<string>();
  const usedCapabilities = new Set<string>();

  const start = (
    request: NativeTurnRequest,
    bindingIsNew = true,
    canNudge = true,
  ): HarnessTurn => {
    if (closed) throw new Error("harness session is closed");
    if (quarantined) throw new Error("harness session is quarantined");
    if (closeAttempt) throw new Error("harness session is closing");
    if (active) throw new Error("harness session already has an active operation");
    assertDeadline(request.deadline, now);
    if (request.binding && bindingIsNew) {
      if (usedOperationIds.has(request.binding.operationId)) {
        throw new Error("harness operation id has already been used in this session");
      }
      if (usedCapabilities.has(request.binding.capability)) {
        throw new Error("harness operation capability has already been used in this session");
      }
      usedOperationIds.add(request.binding.operationId);
      usedCapabilities.add(request.binding.capability);
    }
    active = true;
    lastStatus = { state: "working" };
    const authorities = [...usedOperationIds, ...usedCapabilities];
    const settled = native
      .execute({ ...request, ...(sessionRef ? { previousSessionRef: sessionRef } : {}) })
      .catch((error): NativeTurnOutcome => ({
        state: "failed",
        detail: safeDetail(error, authorities),
        resultEvidence: { kind: "unavailable" },
        nativeUsage: [],
      }))
      .then((outcome): NativeTurnOutcome =>
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
        if (
          outcome.state === "completed" &&
          outcome.sessionRef &&
          !containsAuthority(outcome.sessionRef, authorities)
        ) {
          sessionRef = outcome.sessionRef;
          observeSessionRef?.(sessionRef);
        }
        const protectedOutcome = protectOutcome(outcome, authorities);
        if (!quarantined) lastStatus = outcomeStatus(protectedOutcome);
        return protectedOutcome;
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
        if (!canNudge) throw new Error("harness turn permits at most one nudge");
        if (nudged) throw new Error("harness turn has already been nudged");
        if (!request.binding) throw new Error("harness turn has no result authority to reuse");
        nudged = true;
        await settled;
        return start(
          {
            id: spec.id,
            prompt: spec.prompt ?? "Provide the requested result now.",
            deadline: spec.deadline,
            binding: request.binding,
            kind: "nudge",
          },
          false,
          false,
        );
      },
      async release(reason, deadline): Promise<HarnessReleaseDisposition> {
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
    capabilities: { nativeFork: false },
    async status() {
      if (closed) return { state: "missing" };
      if (quarantined) return lastStatus;
      return active ? { state: "working" } : lastStatus;
    },
    async start(
      turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
      binding: HarnessOperationBinding,
    ) {
      return start({
        id: turn.id,
        prompt: turn.prompt,
        deadline: turn.deadline,
        binding,
        kind: "turn",
      });
    },
    async compact(id, prompt, deadline) {
      return start({ id, prompt, deadline, kind: "compact" });
    },
    async close(reason?: string) {
      if (closed) return;
      closeAttempt ??= native
        .close(reason)
        .catch((error: unknown) => {
          throw new Error(
            safeDetail(error, [...usedOperationIds, ...usedCapabilities]),
          );
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

function outcomeStatus(outcome: HarnessTurnOutcome): HarnessSessionStatus {
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

function safeDetail(error: unknown, authorities: readonly string[]): string {
  const detail = error instanceof Error ? error.message : String(error);
  return containsAuthority(detail, authorities)
    ? "harness operation failed without safe diagnostic detail"
    : detail;
}

function protectOutcome(
  outcome: NativeTurnOutcome,
  authorities: readonly string[],
): HarnessTurnOutcome {
  const unsafe =
    (outcome.detail && containsAuthority(outcome.detail, authorities)) ||
    (outcome.sessionRef && containsAuthority(outcome.sessionRef, authorities)) ||
    (outcome.resultEvidence.kind === "transcript" &&
      containsAuthority(outcome.resultEvidence.text, authorities));
  const { sessionRef: _sessionRef, ...publicOutcome } = outcome;
  if (!unsafe) return publicOutcome;
  return {
    ...publicOutcome,
    ...(outcome.detail
      ? { detail: "harness operation produced no safe diagnostic detail" }
      : {}),
    resultEvidence: { kind: "unavailable" },
  };
}

function containsAuthority(text: string, authorities: readonly string[]): boolean {
  const decodedHex = text.replace(/\\x([0-9a-fA-F]{2})/g, (_match, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 16)),
  );
  const decodedEscapes = decodedHex.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_match, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)),
  );
  return authorities.some(
    (authority) => text.includes(authority) || decodedEscapes.includes(authority),
  );
}
