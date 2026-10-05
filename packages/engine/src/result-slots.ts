import { acceptAny, type SemanticCheck } from "@agentswf/contract";
import type { CandidateSource } from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
import type { ResultSubmitCode } from "@agentswf/contract/wire";
import type { AbsoluteDeadline } from "@agentswf/contract/workflow";
import { scheduleAt } from "./deadlines";
import { evaluateResult } from "./result-validation";
import { recordCandidate, writeAcceptedExclusive, writeCall } from "./runs";

export type ResultRejectionCode = ResultSubmitCode;
export type ResultSlotAccepted = {
  kind: "accepted";
  value: unknown;
  candidateRecorded: boolean;
  /** Eligibility was reserved at this time, before persistence began. */
  admittedAt: number;
  /** The exclusive result write completed at this time. */
  acceptedAt: number;
};
type Rejected = { kind: "rejected"; code: ResultRejectionCode; error: string };
export type ResultSubmission = ResultSlotAccepted | Rejected;
export type WaitingGrant = { kind: "waiting"; waitUntil: number; deadline: number };
export type ResultSlotSettlement =
  | ResultSlotAccepted
  | { kind: "closed" }
  | { kind: "expired" }
  | { kind: "failed"; reason: string };
export type ResultSlotEvent =
  | { kind: "waiting"; reason: string; waitUntil: number; at: number; revision: number }
  | { kind: "admitted"; admittedAt: number; revision: number }
  | { kind: "persisted"; accepted: ResultSlotAccepted; revision: number };
export type ResultSlotBinding = { operationId: string; settled: Promise<ResultSlotSettlement> };
export type ResultSlotSpec = {
  operationId: string;
  agentId: string;
  question: string;
  schema?: JsonSchema;
  semantic?: SemanticCheck;
  deadline: AbsoluteDeadline;
  allowWaiting?: boolean;
  onEvent?(event: ResultSlotEvent): void;
};
export type ResultSlotRegistryOptions = {
  runDir: string;
  now?: () => number;
  schedule?: (delayMilliseconds: number, expire: () => void) => () => void;
  persistence?: ResultSlotPersistence;
  persistenceMs?: number;
  auditMs?: number;
  waitDefaultMs?: number;
  waitMinimumMs?: number;
};
interface ResultSlotPersistence {
  writeCall: typeof writeCall;
  recordCandidate: typeof recordCandidate;
  writeAcceptedExclusive: typeof writeAcceptedExclusive;
}
type SubmissionInput = {
  operationId: string;
  agentId: string;
  raw: string;
  source: CandidateSource;
};
export interface ResultSlotRegistry {
  open(spec: ResultSlotSpec): Promise<ResultSlotBinding>;
  submit(input: SubmissionInput): Promise<ResultSubmission>;
  waiting(input: {
    operationId: string;
    agentId: string;
    reason: string;
    timeoutMs?: number;
  }): Promise<WaitingGrant | Rejected>;
  close(operationId: string): Promise<boolean>;
}
type Slot = ResultSlotSpec & {
  state: "open" | "committing" | "accepted" | "closed" | "expired" | "failed";
  settle(value: ResultSlotSettlement): void;
  cancelExpiry(): void;
  revision: number;
};

export function createResultSlotRegistry(options: ResultSlotRegistryOptions): ResultSlotRegistry {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleExpiry;
  const persistence = options.persistence ?? { writeCall, recordCandidate, writeAcceptedExclusive };
  const persistenceMs = duration(options.persistenceMs, 5_000);
  const auditMs = duration(options.auditMs, 1_000);
  const waitDefaultMs = duration(options.waitDefaultMs, 120_000);
  const waitMinimumMs = duration(options.waitMinimumMs, 30_000);
  const slots = new Map<string, Slot>();
  const bounded = <T>(pending: Promise<T>, milliseconds: number, reason: string): Promise<T> => {
    let cancel = () => {};
    const expiry = new Promise<never>((_resolve, reject) => {
      cancel = schedule(milliseconds, () => reject(new SlotTimeoutError(reason)));
    });
    return Promise.race([pending, expiry]).finally(() => cancel());
  };
  const audit = async (
    slot: Slot,
    input: SubmissionInput,
    accepted: boolean,
    error?: string,
  ): Promise<boolean> => {
    try {
      await bounded(
        Promise.resolve().then(() =>
          persistence.recordCandidate(options.runDir, slot.operationId, {
            at: new Date(now()).toISOString(),
            source: input.source,
            raw: input.raw,
            accepted,
            ...(error === undefined ? {} : { error }),
          }),
        ),
        auditMs,
        "candidate recording timed out",
      );
      return true;
    } catch {
      return false;
    }
  };
  const rejectKnown = async (
    slot: Slot,
    input: SubmissionInput,
    code: ResultRejectionCode,
    error: string = code,
  ): Promise<Rejected> => {
    await audit(slot, input, false, error);
    return rejected(code, error);
  };

  return {
    async open(spec) {
      if (slots.has(spec.operationId))
        throw new Error(`result slot already exists for operation ${spec.operationId}`);
      let settle!: (value: ResultSlotSettlement) => void;
      const settled = new Promise<ResultSlotSettlement>((resolve) => {
        settle = resolve;
      });
      const slot: Slot = { ...spec, state: "open", settle, cancelExpiry: () => {}, revision: 0 };
      slots.set(spec.operationId, slot);
      try {
        await bounded(
          Promise.resolve().then(() =>
            persistence.writeCall(options.runDir, {
              callId: spec.operationId,
              question: spec.question,
              ...(spec.schema ? { schema: spec.schema } : {}),
            }),
          ),
          persistenceMs,
          "call persistence timed out",
        );
      } catch (error) {
        if (error instanceof SlotTimeoutError) {
          // The old write may still publish; its operation ID must never be reused.
          slot.state = "failed";
          slot.settle({ kind: "failed", reason: error.message });
        } else slots.delete(spec.operationId);
        throw error;
      }
      if (now() >= spec.deadline.unixMilliseconds) closeSlot(slot, "expired");
      else
        slot.cancelExpiry = schedule(spec.deadline.unixMilliseconds - now(), () => {
          if (slot.state === "open") closeSlot(slot, "expired");
        });
      return { operationId: spec.operationId, settled };
    },

    async waiting(input) {
      const slot = slots.get(input.operationId);
      if (!slot) return rejected("unknown-operation");
      if (input.agentId !== slot.agentId) return rejected("wrong-agent");
      const unavailable = unavailableCode(slot, now());
      if (unavailable) return rejected(unavailable);
      if (!slot.allowWaiting)
        return rejected("unsupported-command", "waiting is unavailable for this operation");
      if (
        typeof input.reason !== "string" ||
        input.reason.trim() === "" ||
        new TextEncoder().encode(input.reason).byteLength > 2048
      )
        return rejected("invalid-request", "waiting reason must contain 1 to 2048 UTF-8 bytes");
      if (
        input.timeoutMs !== undefined &&
        (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
      )
        return rejected("invalid-request", "waiting timeout must be a positive safe integer");
      const at = now();
      const remaining = slot.deadline.unixMilliseconds - at;
      if (remaining <= 0) {
        closeSlot(slot, "expired");
        return rejected("expired-operation");
      }
      const waitUntil =
        at + Math.min(Math.max(input.timeoutMs ?? waitDefaultMs, waitMinimumMs), remaining);
      notify(slot, {
        kind: "waiting",
        reason: input.reason,
        waitUntil,
        at,
        revision: ++slot.revision,
      });
      return { kind: "waiting", waitUntil, deadline: slot.deadline.unixMilliseconds };
    },

    async submit(input) {
      const slot = slots.get(input.operationId);
      if (!slot) return rejected("unknown-operation");
      if (input.agentId !== slot.agentId) return rejected("wrong-agent");
      const unavailable = unavailableCode(slot, now());
      if (unavailable) return rejectKnown(slot, input, unavailable);
      const evaluated = await evaluateResult(slot, input.raw, slot.semantic ?? acceptAny);
      const admittedAt = now();
      const late = unavailableCode(slot, admittedAt);
      if (late) return rejectKnown(slot, input, late);
      if (evaluated.kind === "rejected")
        return rejectKnown(slot, input, "invalid-result", evaluated.error);

      // No await crosses admission: other commands observe the reservation before I/O starts.
      slot.state = "committing";
      slot.cancelExpiry();
      notify(slot, { kind: "admitted", admittedAt, revision: ++slot.revision });
      const writing = Promise.resolve().then(() =>
        persistence.writeAcceptedExclusive(options.runDir, slot.operationId, evaluated.value),
      );
      let acceptedAt: number | undefined;
      void writing.then(
        (won) => {
          if (won) acceptedAt = now();
        },
        () => {},
      );
      let won: boolean;
      try {
        won = await bounded(writing, persistenceMs, "result persistence timed out");
      } catch (error) {
        void writing.then(
          async (saved) => {
            if (!saved) return;
            const accepted: ResultSlotAccepted = {
              kind: "accepted",
              value: evaluated.value,
              admittedAt,
              acceptedAt: acceptedAt ?? now(),
              candidateRecorded: await audit(slot, input, true),
            };
            notify(slot, { kind: "persisted", accepted, revision: ++slot.revision });
          },
          () => {},
        );
        const reason = error instanceof Error ? error.message : String(error);
        if (slot.state === "committing") {
          slot.state = "failed";
          slot.settle({ kind: "failed", reason });
        }
        throw error;
      }
      if (!won) {
        closeSlot(slot, "closed");
        return rejectKnown(slot, input, "closed-operation");
      }
      const accepted: ResultSlotAccepted = {
        kind: "accepted",
        value: evaluated.value,
        admittedAt,
        acceptedAt: acceptedAt ?? now(),
        candidateRecorded: await audit(slot, input, true),
      };
      if (slot.state === "committing") {
        slot.state = "accepted";
        slot.settle(accepted);
      }
      notify(slot, { kind: "persisted", accepted, revision: ++slot.revision });
      return accepted;
    },

    async close(operationId) {
      const slot = slots.get(operationId);
      if (!slot || (slot.state !== "open" && slot.state !== "committing")) return false;
      closeSlot(slot, now() >= slot.deadline.unixMilliseconds ? "expired" : "closed");
      return true;
    },
  };
}

function unavailableCode(slot: Slot, now: number): ResultRejectionCode | null {
  if (slot.state === "expired") return "expired-operation";
  if (slot.state !== "open") return "closed-operation";
  if (now >= slot.deadline.unixMilliseconds) {
    closeSlot(slot, "expired");
    return "expired-operation";
  }
  return null;
}
function closeSlot(slot: Slot, state: "closed" | "expired"): void {
  if (slot.state !== "open" && slot.state !== "committing") return;
  slot.state = state;
  slot.cancelExpiry();
  slot.settle({ kind: state });
}
function notify(slot: Slot, event: ResultSlotEvent): void {
  try {
    slot.onEvent?.(event);
  } catch {
    /* An observer cannot undo admission. */
  }
}
function rejected(code: ResultRejectionCode, error: string = code): Rejected {
  return { kind: "rejected", code, error };
}
function duration(value: number | undefined, fallback: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual <= 0)
    throw new Error("slot durations must be positive safe integers");
  return actual;
}
function scheduleExpiry(delayMilliseconds: number, expire: () => void): () => void {
  return scheduleAt({ unixMilliseconds: Date.now() + delayMilliseconds }, expire);
}

class SlotTimeoutError extends Error {}
