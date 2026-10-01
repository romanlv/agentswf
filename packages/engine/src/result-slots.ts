import { acceptAny, type SemanticCheck } from "@agentswf/contract";
import type { AttemptSource } from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
import type { ResultSubmitCode } from "@agentswf/contract/wire";
import type { AbsoluteDeadline } from "@agentswf/contract/workflow";
import { scheduleAt } from "./deadlines";
import { evaluateResult } from "./result-validation";
import { recordAttempt, writeAcceptedExclusive, writeCall } from "./run-dir";

export type ResultRejectionCode = Exclude<
  ResultSubmitCode,
  "invalid-request" | "unsupported-version" | "request-too-large" | "internal-error"
>;

export type ResultSlotAccepted = {
  kind: "accepted";
  value: unknown;
  /** False only when atomic result persistence won but audit append failed. */
  attemptRecorded: boolean;
  /** Unix milliseconds the result was taken, before the agent was told. */
  acceptedAt: number;
};

export type ResultSubmission =
  | ResultSlotAccepted
  | { kind: "rejected"; code: ResultRejectionCode; error: string };

export type ResultSlotSettlement = ResultSlotAccepted | { kind: "closed" } | { kind: "expired" };

export type ResultSlotBinding = {
  operationId: string;
  settled: Promise<ResultSlotSettlement>;
};

export type ResultSlotSpec = {
  operationId: string;
  /** The only agent allowed to answer this call. Its socket is what proves which agent asked. */
  agentId: string;
  question: string;
  schema?: JsonSchema;
  semantic?: SemanticCheck;
  deadline: AbsoluteDeadline;
};

export type ResultSlotRegistryOptions = {
  runDir: string;
  now?: () => number;
  schedule?: (delayMilliseconds: number, expire: () => void) => () => void;
  persistence?: ResultSlotPersistence;
};

interface ResultSlotPersistence {
  writeCall: typeof writeCall;
  recordAttempt: typeof recordAttempt;
  writeAcceptedExclusive: typeof writeAcceptedExclusive;
}

export interface ResultSlotRegistry {
  open(spec: ResultSlotSpec): Promise<ResultSlotBinding>;
  submit(input: {
    operationId: string;
    /** Taken from the socket the request arrived on, never from the request itself. */
    agentId: string;
    raw: string;
    source: AttemptSource;
  }): Promise<ResultSubmission>;
  close(operationId: string): Promise<boolean>;
}

/** A settled slot is kept for the rest of the run so a late submission is told why the call is
 *  unusable rather than that it never existed. */
type SlotState = "open" | "accepted" | "closed" | "expired";

type Slot = ResultSlotSpec & {
  state: SlotState;
  settle(value: ResultSlotSettlement): void;
  cancelExpiry(): void;
  tail: Promise<void>;
};

export function createResultSlotRegistry(options: ResultSlotRegistryOptions): ResultSlotRegistry {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleExpiry;
  const persistence = options.persistence ?? {
    writeCall,
    recordAttempt,
    writeAcceptedExclusive,
  };
  const slots = new Map<string, Slot>();

  return {
    async open(spec) {
      if (slots.has(spec.operationId)) {
        throw new Error(`result slot already exists for operation ${spec.operationId}`);
      }

      let settle!: (value: ResultSlotSettlement) => void;
      const settled = new Promise<ResultSlotSettlement>((resolve) => {
        settle = resolve;
      });
      const slot: Slot = {
        ...spec,
        state: "open",
        settle,
        cancelExpiry: () => undefined,
        tail: Promise.resolve(),
      };
      slots.set(spec.operationId, slot);
      try {
        await persistence.writeCall(options.runDir, {
          callId: spec.operationId,
          question: spec.question,
          ...(spec.schema ? { schema: spec.schema } : {}),
        });
      } catch (error) {
        slots.delete(spec.operationId);
        throw error;
      }
      if (now() >= spec.deadline.unixMilliseconds) {
        closeSlot(slot, "expired");
      } else {
        slot.cancelExpiry = schedule(spec.deadline.unixMilliseconds - now(), () => {
          void serialize(slot, async () => {
            closeSlot(slot, "expired");
          });
        });
      }
      return { operationId: spec.operationId, settled };
    },

    async submit(input) {
      const slot = slots.get(input.operationId);
      if (!slot) return rejected("unknown-operation");
      // The agent id comes from the socket, so this refuses one agent answering another's call.
      // No attempt is recorded: the value came from somebody else, and this call's own log is
      // read as the history of the agent that owns it.
      if (input.agentId !== slot.agentId) return rejected("wrong-agent");

      const unavailable = await serialize(slot, async () => unavailableCode(slot, now()));
      if (unavailable) {
        return rejectKnown(persistence, options.runDir, slot, input, unavailable, now);
      }

      const evaluated = await evaluateResult(slot, input.raw, slot.semantic ?? acceptAny);

      return serialize(slot, async () => {
        const unavailable = unavailableCode(slot, now());
        if (unavailable) {
          return rejectKnown(persistence, options.runDir, slot, input, unavailable, now);
        }
        if (evaluated.kind === "rejected") {
          await recordRejected(
            persistence,
            options.runDir,
            slot.operationId,
            input.source,
            input.raw,
            evaluated.error,
            now,
          );
          return {
            kind: "rejected" as const,
            code: "invalid-result" as const,
            error: evaluated.error,
          };
        }
        const won = await persistence.writeAcceptedExclusive(
          options.runDir,
          slot.operationId,
          evaluated.value,
        );
        if (!won) {
          closeSlot(slot, "closed");
          return rejectKnown(persistence, options.runDir, slot, input, "closed-operation", now);
        }

        slot.state = "accepted";
        slot.cancelExpiry();
        const acceptedAt = now();
        let attemptRecorded = true;
        try {
          await persistence.recordAttempt(options.runDir, slot.operationId, {
            at: new Date(acceptedAt).toISOString(),
            source: input.source,
            accepted: true,
            raw: input.raw,
          });
        } catch {
          // result.json is already the authoritative atomic settlement and cannot be reported lost.
          attemptRecorded = false;
        }
        const accepted: ResultSlotAccepted = {
          kind: "accepted",
          value: evaluated.value,
          attemptRecorded,
          acceptedAt,
        };
        slot.settle(accepted);
        return accepted;
      });
    },

    async close(operationId) {
      const slot = slots.get(operationId);
      if (!slot) return false;
      return serialize(slot, async () => {
        if (slot.state !== "open") return false;
        closeSlot(slot, now() >= slot.deadline.unixMilliseconds ? "expired" : "closed");
        return true;
      });
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
  if (slot.state !== "open") return;
  slot.state = state;
  slot.cancelExpiry();
  slot.settle({ kind: state });
}

async function rejectKnown(
  persistence: ResultSlotPersistence,
  runDir: string,
  slot: Slot,
  input: { raw: string; source: AttemptSource },
  code: ResultRejectionCode,
  now: () => number,
): Promise<ResultSubmission> {
  await recordRejected(persistence, runDir, slot.operationId, input.source, input.raw, code, now);
  return rejected(code);
}

async function recordRejected(
  persistence: ResultSlotPersistence,
  runDir: string,
  operationId: string,
  source: AttemptSource,
  raw: string,
  error: string,
  now: () => number,
): Promise<void> {
  await persistence.recordAttempt(runDir, operationId, {
    at: new Date(now()).toISOString(),
    source,
    accepted: false,
    raw,
    error,
  });
}

function rejected(code: ResultRejectionCode): ResultSubmission {
  return { kind: "rejected", code, error: code };
}

function serialize<T>(slot: Slot, operation: () => Promise<T>): Promise<T> {
  const result = slot.tail.then(operation);
  slot.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function scheduleExpiry(delayMilliseconds: number, expire: () => void): () => void {
  return scheduleAt({ unixMilliseconds: Date.now() + delayMilliseconds }, expire);
}
