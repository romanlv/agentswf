import type { JsonSchema } from "@agentswf/contract/schema";
import type { AbsoluteDeadline } from "@agentswf/contract/workflow";
import type { HarnessTurn, HarnessTurnOutcome } from "@agentswf/harness/adapter";
import { scheduleAt } from "./deadlines";
import type { ResultSlotEvent, ResultSlotRegistry, ResultSlotSettlement } from "./result-slots";

export type LivenessPolicy = {
  quietMs: number;
  responseMs: number;
  deliveryMs: number;
  releaseMs: number;
};
export const DEFAULT_LIVENESS_POLICY: LivenessPolicy = {
  quietMs: 30_000,
  responseMs: 120_000,
  deliveryMs: 30_000,
  releaseMs: 30_000,
};
export type OperationPhase =
  | "working"
  | "waiting"
  | "check-in-pending"
  | "awaiting-reply"
  | "releasing";
export type LivenessEvent = {
  kind: string;
  at: number;
  sequence: number;
  reason?: string;
  until?: number;
};
export type SupervisedOutcome = {
  kind: "answered" | "unanswered" | "timed-out" | "cancelled" | "blocked" | "failed";
  value?: unknown;
  reason: string;
  cleanupUnresolved: boolean;
  charges: number[];
  deliveredAt?: number;
  settledAt: number;
};

type Options = {
  operationId: string;
  agentId: string;
  question: string;
  schema: JsonSchema;
  deadline: AbsoluteDeadline;
  slots: ResultSlotRegistry;
  nudge: boolean;
  waitingSupported?: boolean;
  start(): Promise<HarnessTurn>;
  successor(turn: HarnessTurn, sequence: number, signal: AbortSignal): Promise<HarnessTurn>;
  onStop(cancel: (reason: string) => void): () => void;
  event?(event: LivenessEvent): void;
  phase?(phase: OperationPhase, reason?: string, until?: number): void;
  policy?: LivenessPolicy;
  now?: () => number;
  schedule?: (at: number, action: () => void) => () => void;
};

/** One operation owns its slot and native handles until bounded release completes. */
export async function superviseOperation(options: Options): Promise<SupervisedOutcome> {
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ?? ((at, action) => scheduleAt({ unixMilliseconds: at }, action));
  const policy = options.policy ?? DEFAULT_LIVENESS_POLICY;
  const waitingSupported = options.waitingSupported !== false;
  const deadline = options.deadline.unixMilliseconds;
  let wake = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const changed = () => wake.resolve();
  let sequence = 0;
  let revision = 0;
  let admitted = false;
  let settlement: ResultSlotSettlement | undefined;
  let stop: { kind: SupervisedOutcome["kind"]; reason: string } | undefined;
  let waitUntil: number | undefined;
  let quietUntil: number | undefined;
  let responseUntil: number | undefined;
  let deliveryUntil: number | undefined;
  let dispatched = false;
  let receiptSatisfied = false;
  let deliveredAt: number | undefined;
  let dispatchStartedAt: number | undefined;
  let held: HarnessTurn | undefined;
  let acquiring: Promise<HarnessTurn> | undefined;
  let acquisitionError: unknown;
  let native: HarnessTurnOutcome | undefined;
  let ignoredCancellation = false;
  let controller: AbortController | undefined;
  let finished = false;
  let abandonedAcquisition = false;
  let answerRelease:
    | Promise<import("@agentswf/harness/adapter").HarnessReleaseDisposition>
    | undefined;
  let answerReleaseDeadline: number | undefined;
  const charges: number[] = [];
  const emit = (kind: string, reason?: string, until?: number, at = now()) =>
    options.event?.({
      kind,
      at,
      sequence,
      ...(reason === undefined ? {} : { reason }),
      ...(until === undefined ? {} : { until }),
    });
  const clearAnswerTimers = () => {
    quietUntil = responseUntil = deliveryUntil = undefined;
  };
  const cancelPending = () => {
    if (!dispatched && controller) {
      ignoredCancellation = true;
      controller.abort();
    }
  };
  const onSlot = (event: ResultSlotEvent) => {
    if (finished) return;
    if (event.kind === "waiting") {
      revision += 1;
      waitUntil = event.waitUntil;
      receiptSatisfied = true;
      clearAnswerTimers();
      cancelPending();
      options.phase?.("waiting", event.reason, event.waitUntil);
      emit("waiting", event.reason, event.waitUntil);
    } else if (event.kind === "admitted") {
      admitted = true;
      deliveredAt ??= dispatchStartedAt ?? event.admittedAt;
      waitUntil = undefined;
      clearAnswerTimers();
      cancelPending();
      beginAnswerRelease();
      emit("admitted", undefined, undefined, event.admittedAt);
    } else if (event.kind === "persisted") {
      emit("persisted", undefined, undefined, event.accepted.acceptedAt);
    }
    changed();
  };
  const removeStop = options.onStop((reason) => {
    if (finished) return;
    stop = {
      kind:
        reason.includes("deadline") || (!admitted && now() >= deadline) ? "timed-out" : "cancelled",
      reason,
    };
    stopped.resolve();
    void options.slots.close(options.operationId);
    cancelPending();
    changed();
  });
  let slot: Awaited<ReturnType<ResultSlotRegistry["open"]>>;
  try {
    slot = await options.slots.open({
      operationId: options.operationId,
      agentId: options.agentId,
      question: options.question,
      schema: options.schema,
      deadline: options.deadline,
      allowWaiting: waitingSupported,
      onEvent: onSlot,
    });
  } catch (error) {
    removeStop();
    throw error;
  }
  emit("opened", undefined, deadline);
  if (stop) void options.slots.close(options.operationId);
  void slot.settled.then((value) => {
    settlement = value;
    changed();
  });
  const observe = (opening: Promise<HarnessTurn>, check: boolean) => {
    acquiring = opening;
    const current = sequence;
    const grantRevision = revision;
    native = undefined;
    dispatched = false;
    receiptSatisfied = false;
    ignoredCancellation = false;
    void opening.then(
      (turn) => {
        if (finished || abandonedAcquisition) {
          void turn
            .release("operation already ended", { unixMilliseconds: now() + policy.releaseMs })
            .catch(() => undefined);
          return;
        }
        held = turn;
        acquiring = undefined;
        if (admitted) beginAnswerRelease();
        const valid = () => !finished && current === sequence;
        void turn.settled.then(
          (outcome) => {
            if (!valid()) return;
            native = outcome;
            charges.push(...outcome.chargesUsd);
            if (
              outcome.state === "completed" &&
              !admitted &&
              waitUntil === undefined &&
              responseUntil === undefined &&
              !check
            )
              quietUntil = now() + (waitingSupported ? policy.quietMs : 0);
            if (!waitingSupported && check && outcome.state === "completed") responseUntil = now();
            changed();
          },
          (error) => {
            if (valid()) {
              acquisitionError = error;
              changed();
            }
          },
        );
        if (turn.delivery) {
          void turn.delivery.dispatched.then((at) => {
            if (!valid()) return;
            dispatched = true;
            deliveredAt ??= at;
            if (!admitted && !receiptSatisfied && grantRevision === revision)
              deliveryUntil = Math.min(deadline, at + policy.deliveryMs);
            emit("dispatched", undefined, deliveryUntil);
            changed();
          });
          void turn.delivery.accepted.then(() => {
            if (!valid()) return;
            deliveryUntil = undefined;
            emit("queue-accepted");
            changed();
          });
          void turn.delivery.received.then((at) => {
            if (!valid()) return;
            deliveryUntil = undefined;
            if (check && !admitted && !receiptSatisfied && grantRevision === revision) {
              responseUntil = Math.min(deadline, at + policy.responseMs);
              options.phase?.("awaiting-reply", undefined, responseUntil);
            }
            emit("received", undefined, responseUntil);
            changed();
          });
        } else if (waitingSupported) {
          acquisitionError = new Error("waiting operation has no delivery evidence");
          changed();
        } else {
          deliveredAt ??= now();
        }
        changed();
      },
      (error) => {
        acquiring = undefined;
        acquisitionError = error;
        changed();
      },
    );
  };
  let result: SupervisedOutcome | undefined;
  try {
    if (!stop && now() < deadline) {
      options.phase?.("working");
      observe(
        Promise.resolve().then(() => {
          if (stop || now() >= deadline) throw new Error("operation stopped before dispatch");
          dispatchStartedAt = now();
          return options.start();
        }),
        false,
      );
    }
    for (;;) {
      const at = now();
      if (stop) {
        result = terminal(stop.kind, stop.reason);
        break;
      }
      if (settlement?.kind === "failed") {
        result = terminal("failed", settlement.reason);
        break;
      }
      if (settlement?.kind === "accepted") {
        result = { ...terminal("answered", "answer saved"), value: settlement.value };
        break;
      }
      if (!admitted && (at >= deadline || settlement?.kind === "expired")) {
        result = terminal("timed-out", "operation deadline exceeded");
        break;
      }
      if (settlement?.kind === "closed") {
        result = terminal("cancelled", "operation closed");
        break;
      }
      if (acquisitionError) {
        result = terminal("failed", String(acquisitionError));
        break;
      }
      if (!admitted) {
        if (
          native &&
          native.state !== "completed" &&
          !(ignoredCancellation && native.state === "cancelled")
        ) {
          result = terminal(
            native.state === "timed-out" ? "timed-out" : native.state,
            native.detail ?? `native turn ${native.state}`,
          );
          break;
        }
        if (deliveryUntil !== undefined && at >= deliveryUntil) {
          result = terminal("failed", "prompt delivery could not be confirmed");
          break;
        }
        if (responseUntil !== undefined && at >= responseUntil) {
          result = terminal("unanswered", "check-in received no waiting declaration or result");
          break;
        }
        const idle = native !== undefined && !acquiring;
        const due =
          waitUntil !== undefined ? at >= waitUntil : quietUntil !== undefined && at >= quietUntil;
        if (idle && due && responseUntil === undefined && deliveryUntil === undefined) {
          if (!options.nudge) {
            result = terminal("unanswered", "agent settled without an accepted result");
            break;
          }
          waitUntil = quietUntil = undefined;
          sequence += 1;
          controller = new AbortController();
          options.phase?.("check-in-pending");
          emit("check-in-due");
          observe(
            Promise.resolve().then(() => options.successor(held!, sequence, controller!.signal)),
            true,
          );
        }
        // Without nudges, a normal completion retains the existing immediate no-answer rule.
        if (idle && !options.nudge && waitUntil === undefined) {
          result = terminal("unanswered", "agent settled without an accepted result");
          break;
        }
      }
      const candidates = admitted
        ? []
        : [deadline, waitUntil, quietUntil, responseUntil, deliveryUntil].filter(
            (v): v is number => v !== undefined && v > now(),
          );
      const signal = wake.promise;
      const cancelTimer = candidates.length ? schedule(Math.min(...candidates), changed) : () => {};
      await signal;
      cancelTimer();
      wake = Promise.withResolvers<void>();
    }
    clearAnswerTimers();
    waitUntil = undefined;
    cancelPending();
    await options.slots.close(options.operationId);
    options.phase?.("releasing");
    emit("releasing");
    let releaseDeadline =
      now() +
      (result.kind === "answered" && !stop ? policy.releaseMs : Math.min(policy.releaseMs, 5000));
    if (acquiring) {
      const acquisition = acquiring;
      let acquired = await bounded(acquisition, releaseDeadline, result.kind === "answered");
      if (!acquired && stop && result.kind === "answered") {
        releaseDeadline = now() + Math.min(policy.releaseMs, 5000);
        acquired = await bounded(acquisition, releaseDeadline);
      }
      if (acquired) held = acquired;
      else {
        abandonedAcquisition = true;
        result.cleanupUnresolved = true;
      }
    }
    if (held) {
      const stopping = stop !== undefined;
      if (stopping)
        releaseDeadline = Math.min(releaseDeadline, now() + Math.min(policy.releaseMs, 5000));
      let release =
        !stopping && result.kind === "answered" && answerRelease
          ? await bounded(answerRelease, answerReleaseDeadline!, true)
          : await bounded(
              held.release(
                stop?.reason ?? result.reason,
                { unixMilliseconds: releaseDeadline },
                !stopping && result.kind === "answered"
                  ? { answered: true, awaitCompletion: true }
                  : undefined,
              ),
              releaseDeadline,
            );
      if (stop && !stopping && result.kind === "answered") {
        const stopDeadline = now() + Math.min(policy.releaseMs, 5000);
        release = await bounded(
          held.release(stop.reason, { unixMilliseconds: stopDeadline }),
          stopDeadline,
        );
      }
      emit("release", release?.kind ?? "unresolved");
      if (
        release?.kind !== "released" ||
        (!stop && result.kind === "answered" && release.outcome.state !== "completed")
      )
        result.cleanupUnresolved = true;
    }
    if (stop && result.kind === "answered") {
      result.kind = stop.kind;
      result.reason = stop.reason;
      delete result.value;
    }
    if (result.cleanupUnresolved && result.kind !== "cancelled" && result.kind !== "timed-out") {
      result.kind = "failed";
      result.reason = "cleanup-unresolved";
      delete result.value;
    }
    if (result.kind === "answered") result.settledAt = now();
    if (deliveredAt !== undefined) result.deliveredAt = deliveredAt;
    emit("terminal", result.reason);
    return result;
  } finally {
    finished = true;
    removeStop();
  }
  function beginAnswerRelease() {
    if (!held || acquiring || answerRelease || stop) return;
    answerReleaseDeadline = now() + policy.releaseMs;
    answerRelease = held.release(
      "answer admitted",
      { unixMilliseconds: answerReleaseDeadline },
      { answered: true, awaitCompletion: true },
    );
    void answerRelease.catch(() => undefined);
  }
  function terminal(kind: SupervisedOutcome["kind"], reason: string): SupervisedOutcome {
    return {
      kind,
      reason,
      cleanupUnresolved: false,
      charges,
      ...(deliveredAt === undefined ? {} : { deliveredAt }),
      settledAt: kind === "timed-out" ? Math.min(now(), deadline) : now(),
    };
  }
  async function bounded<T>(
    promise: Promise<T>,
    until: number,
    interruptOnStop = false,
  ): Promise<T | undefined> {
    let cancel = () => {};
    const expired = new Promise<undefined>((resolve) => {
      cancel = schedule(until, () => resolve(undefined));
    });
    try {
      return await Promise.race([
        promise.catch(() => undefined),
        expired,
        ...(interruptOnStop ? [stopped.promise.then(() => undefined)] : []),
      ]);
    } finally {
      cancel();
    }
  }
}
