import { randomBytes } from "node:crypto";
import { acceptAny, type SemanticCheck } from "@wf/contract";
import type { AttemptSource } from "@wf/contract/records";
import type { JsonSchema } from "@wf/contract/schema";
import type { AbsoluteDeadline } from "@wf/contract/workflow";
import type { ResultSubmitCode } from "@wf/contract/wire";
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
};

export type ResultSubmission =
  | ResultSlotAccepted
  | { kind: "rejected"; code: ResultRejectionCode; error: string };

export type ResultSlotSettlement =
  | ResultSlotAccepted
  | { kind: "closed" }
  | { kind: "expired" };

export type ResultSlotBinding = {
  operationId: string;
  capability: string;
  settled: Promise<ResultSlotSettlement>;
};

export type ResultSlotSpec = {
  operationId: string;
  question: string;
  schema?: JsonSchema;
  semantic?: SemanticCheck;
  deadline: AbsoluteDeadline;
};

export type ResultSlotRegistryOptions = {
  runDir: string;
  generateCapability?: () => string;
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
    capability: string;
    raw: string;
    source: AttemptSource;
  }): Promise<ResultSubmission>;
  close(capability: string): Promise<boolean>;
}

/** A settled slot is kept for the rest of the run so a late submission is told why its capability
 *  is unusable rather than that it never existed. */
type SlotState = "open" | "accepted" | "closed" | "expired";

type Slot = ResultSlotSpec & {
  capability: string;
  state: SlotState;
  settle(value: ResultSlotSettlement): void;
  cancelExpiry(): void;
  tail: Promise<void>;
};

export function createResultSlotRegistry(
  options: ResultSlotRegistryOptions,
): ResultSlotRegistry {
  const generateCapability = options.generateCapability ?? defaultCapability;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? scheduleExpiry;
  const persistence = options.persistence ?? {
    writeCall,
    recordAttempt,
    writeAcceptedExclusive,
  };
  const slots = new Map<string, Slot>();
  const operations = new Set<string>();
  /** Every issued capability stays protected for the run lifetime because a closed pane, delayed
   * child, or diagnostic can still echo authority after its slot settles. */
  const protectedCapabilities = (own?: string): string[] => {
    const protectedValues = own === undefined ? [] : [own];
    for (const slot of slots.values()) {
      if (slot.capability !== own) protectedValues.push(slot.capability);
    }
    return protectedValues;
  };

  return {
    async open(spec) {
      if (operations.has(spec.operationId)) {
        throw new Error(`result slot already exists for operation ${spec.operationId}`);
      }
      const capability = generateCapability();
      if (slots.has(capability)) throw new Error("result capability generator produced a collision");
      const forbiddenCapabilities = [capability, ...protectedCapabilities()];
      if (forbiddenCapabilities.some((item) => containsString(spec, item))) {
        throw new Error("result slot metadata contains protected operation authority");
      }

      let settle!: (value: ResultSlotSettlement) => void;
      const settled = new Promise<ResultSlotSettlement>((resolve) => {
        settle = resolve;
      });
      const slot: Slot = {
        ...spec,
        capability,
        state: "open",
        settle,
        cancelExpiry: () => undefined,
        tail: Promise.resolve(),
      };
      slots.set(capability, slot);
      operations.add(spec.operationId);
      try {
        await persistence.writeCall(options.runDir, {
          callId: spec.operationId,
          question: spec.question,
          ...(spec.schema ? { schema: spec.schema } : {}),
        });
      } catch (error) {
        slots.delete(capability);
        operations.delete(spec.operationId);
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
      return { operationId: spec.operationId, capability, settled };
    },

    async submit(input) {
      const slot = slots.get(input.capability);
      if (!slot) return rejected("unknown-capability");
      if (input.operationId !== slot.operationId) {
        return rejectKnown(
          persistence,
          options.runDir,
          slot,
          input,
          "wrong-operation",
          now,
          protectedCapabilities(slot.capability),
        );
      }

      const unavailable = await serialize(slot, async () => unavailableCode(slot, now()));
      if (unavailable) {
        return rejectKnown(
          persistence,
          options.runDir,
          slot,
          input,
          unavailable,
          now,
          protectedCapabilities(slot.capability),
        );
      }

      const validationCapabilities = protectedCapabilities(slot.capability);
      const evaluated = await evaluateResult(
        slot,
        input.raw,
        slot.semantic ?? acceptAny,
        validationCapabilities,
      );

      return serialize(slot, async () => {
        const currentCapabilities = protectedCapabilities(slot.capability);
        const unavailable = unavailableCode(slot, now());
        if (unavailable) {
          return rejectKnown(
            persistence,
            options.runDir,
            slot,
            input,
            unavailable,
            now,
            currentCapabilities,
          );
        }
        const safeRaw = redactCapabilities(input.raw, currentCapabilities);
        const safeSource = redactCapabilities(input.source, currentCapabilities);
        const validationError = evaluated.kind === "rejected"
          ? evaluated.error
          : currentCapabilities.some((capability) => containsString(evaluated.value, capability))
            ? "the value contains protected operation authority"
            : undefined;
        if (validationError) {
          const safeError = redactCapabilities(validationError, currentCapabilities);
          await recordRejected(
            persistence,
            options.runDir,
            slot.operationId,
            safeSource,
            safeRaw,
            safeError,
            now,
          );
          return { kind: "rejected" as const, code: "invalid-result" as const, error: safeError };
        }
        if (evaluated.kind === "rejected") throw new Error("unreachable rejected result");

        const won = await persistence.writeAcceptedExclusive(
          options.runDir,
          slot.operationId,
          evaluated.value,
        );
        if (!won) {
          closeSlot(slot, "closed");
          return rejectKnown(
            persistence,
            options.runDir,
            slot,
            input,
            "closed-capability",
            now,
            currentCapabilities,
          );
        }

        slot.state = "accepted";
        slot.cancelExpiry();
        let attemptRecorded = true;
        try {
          await persistence.recordAttempt(options.runDir, slot.operationId, {
            at: new Date(now()).toISOString(),
            source: safeSource,
            accepted: true,
            raw: safeRaw,
          });
        } catch {
          // result.json is already the authoritative atomic settlement and cannot be reported lost.
          attemptRecorded = false;
        }
        const accepted: ResultSlotAccepted = {
          kind: "accepted",
          value: evaluated.value,
          attemptRecorded,
        };
        slot.settle(accepted);
        return accepted;
      });
    },

    async close(capability) {
      const slot = slots.get(capability);
      if (!slot) return false;
      return serialize(slot, async () => {
        if (slot.state !== "open") return false;
        closeSlot(slot, now() >= slot.deadline.unixMilliseconds ? "expired" : "closed");
        return true;
      });
    },
  };
}

function defaultCapability(): string {
  return randomBytes(32).toString("base64url");
}

function unavailableCode(slot: Slot, now: number): ResultRejectionCode | null {
  if (slot.state === "expired") return "expired-capability";
  if (slot.state !== "open") return "closed-capability";
  if (now >= slot.deadline.unixMilliseconds) {
    closeSlot(slot, "expired");
    return "expired-capability";
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
  input: { raw: string; source: AttemptSource; capability: string },
  code: ResultRejectionCode,
  now: () => number,
  protectedCapabilities: readonly string[],
): Promise<ResultSubmission> {
  await recordRejected(
    persistence,
    runDir,
    slot.operationId,
    redactCapabilities(input.source, protectedCapabilities),
    redactCapabilities(input.raw, protectedCapabilities),
    code,
    now,
  );
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

function redactCapabilities(text: string, capabilities: readonly string[]): string {
  const decoded = decodeAsciiEscapes(text);
  return capabilities.some((capability) => text.includes(capability) || decoded.includes(capability))
    ? "[redacted-capability-bearing-text]"
    : text;
}

function decodeAsciiEscapes(text: string): string {
  return text
    .replace(/\\u([0-9a-f]{4})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_match, code: string) =>
      String.fromCharCode(Number.parseInt(code, 16)),
    );
}

function containsString(value: unknown, target: string): boolean {
  if (typeof value === "string") return containsCapability(value, target);
  if (Array.isArray(value)) return value.some((item) => containsString(item, target));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => containsCapability(key, target) || containsString(item, target),
  );
}

function containsCapability(text: string, capability: string): boolean {
  return text.includes(capability) || decodeAsciiEscapes(text).includes(capability);
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
  const target = Date.now() + delayMilliseconds;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = target - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    const delay = Math.min(remaining, 2_147_483_647);
    timer = setTimeout(() => {
      schedule();
    }, delay);
    timer.unref();
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
