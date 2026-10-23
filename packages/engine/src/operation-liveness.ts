import type { OperationLivenessKind } from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
import type { AbsoluteDeadline, TurnLogin } from "@agentswf/contract/workflow";
import type {
  HarnessReleaseDisposition,
  HarnessTurn,
  HarnessTurnOutcome,
} from "@agentswf/harness/adapter";
import { scheduleAt } from "./deadlines";
import { messageOf } from "./errors";
import type { Pending, TurnEnd } from "./messaging/messaging";
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
  | "awaiting-reply"
  | "check-in-pending"
  | "check-in-response"
  | "releasing";
export type LivenessEvent = {
  kind: OperationLivenessKind;
  at: number;
  sequence: number;
  reason?: string;
  until?: number;
  peer?: string;
};

/**
 * An operation's messages, which a turn that ends without a result goes on to before 021's
 * check-in: what continues it, a wait for an answer, or a reminder of one it owes.
 */
/**
 * How long past the deadlines around it a wait on an outside participant is ended here, should the
 * scope's own stop, which ends it with its reason, not have come.
 */
export const CEILING_GRACE_MS = 1_000;

export type OperationMessages = {
  /** What is held for it, deciding nothing. */
  pending(): Pending;
  /** The answer it awaits, while it does. */
  /**
   * The answer it awaits, while it does: until `until` when the wait has a limit; `outside` when an
   * outside participant owes it, a wait its deadline does not count.
   */
  awaiting(): { peer: string; until?: number; outside?: true } | undefined;
  turnEnded(): TurnEnd;
  /**
   * The turn that carries what is held, or the reminder, once `turn` has settled; it says why it
   * continued.
   */
  continueWith(
    turn: HarnessTurn,
    sequence: number,
    signal: AbortSignal,
    reminder?: string,
  ): Promise<HarnessTurn>;
  /** A reminder's response window passed: what it owed then fails, its askers told. */
  reminderExpired(): void;
  /** Wakes the supervisor when something arrives for it. */
  onChange(wake: () => void): () => void;
};
export type SupervisedOutcome = {
  kind: "answered" | "unanswered" | "timed-out" | "cancelled" | "blocked" | "failed";
  value?: unknown;
  reason: string;
  cleanupUnresolved: boolean;
  charges: number[];
  deliveredAt?: number;
  settledAt: number;
  /** A failed turn whose harness showed it cannot sign in. */
  login?: TurnLogin;
};

export type OperationStop = { kind: "cancelled" | "timed-out"; reason: string };

type Options = {
  operationId: string;
  agentId: string;
  question: string;
  schema: JsonSchema;
  /** Absent when nothing bounds it. */
  deadline?: AbsoluteDeadline;
  /** The deadlines around it, which a wait on an outside participant still ends at. */
  ceiling?: number;
  /**
   * Its deadline moved: to the ceiling while it waits on an outside participant (`waiting`), then
   * out by that wait's length once it ends, within the ceiling. Undefined is none.
   */
  extended?(deadline: number | undefined, waiting: boolean): void;
  slots: ResultSlotRegistry;
  nudge: boolean;
  waitingSupported?: boolean;
  start(): Promise<HarnessTurn>;
  successor(turn: HarnessTurn, sequence: number, signal: AbortSignal): Promise<HarnessTurn>;
  onStop(cancel: (stop: OperationStop) => Promise<void>): () => void;
  event?(event: LivenessEvent): void;
  phase?(phase: OperationPhase, reason?: string, until?: number): void;
  messages?: OperationMessages;
  /** Once, when the harness first accepts the operation. */
  delivered?(at: number): void;
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
  let deadline = options.deadline?.unixMilliseconds ?? Number.POSITIVE_INFINITY;
  const ceiling = options.ceiling ?? Number.POSITIVE_INFINITY;
  /** When its turn ended awaiting an outside participant: the wait its deadline does not count. */
  let outsideSince: number | undefined;
  const finite = (at: number) => (Number.isFinite(at) ? at : undefined);
  const waitedOutside = (at: number) => {
    if (outsideSince === undefined) return;
    deadline = Math.min(ceiling, deadline + (at - outsideSince));
    outsideSince = undefined;
    options.extended?.(finite(deadline), false);
  };
  let wake = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const changed = () => wake.resolve();
  let sequence = 0;
  let revision = 0;
  let admitted = false;
  let settlement: ResultSlotSettlement | undefined;
  let stop: OperationStop | undefined;
  let waitUntil: number | undefined;
  let quietUntil: number | undefined;
  let responseUntil: number | undefined;
  let deliveryUntil: number | undefined;
  let receiptUntil: number | undefined;
  let dispatched = false;
  let receiptSatisfied = false;
  /** The answer it waits on, once a turn has ended awaiting it: no check-in while it does. */
  let awaitingPeer: { peer: string; until?: number } | undefined;
  /** When a reminder's response window closes: what it owes fails then. */
  let reminderUntil: number | undefined;
  /** Deliveries not yet dispatched, which only a stop aborts. */
  const continuations = new Set<AbortController>();
  let deliveredAt: number | undefined;
  const deliver = (at: number | undefined) => {
    if (deliveredAt !== undefined || at === undefined) return;
    deliveredAt = at;
    options.delivered?.(at);
  };
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
  const emit = (
    kind: OperationLivenessKind,
    reason?: string,
    until?: number,
    at = now(),
    peer?: string,
  ) =>
    options.event?.({
      kind,
      at,
      sequence,
      ...(reason === undefined ? {} : { reason }),
      ...(until === undefined ? {} : { until }),
      ...(peer === undefined ? {} : { peer }),
    });
  /**
   * A delivery, or the reminder, as the turn after the one that ended: a working turn, no check-in.
   * Unlike a check-in it is not withdrawn when a result or a wait arrives first: what it carries is
   * already shown, and only a stop aborts it.
   */
  const continueWithMessages = (messages: OperationMessages, reminder?: string) => {
    waitUntil = quietUntil = undefined;
    awaitingPeer = undefined;
    waitedOutside(now());
    sequence += 1;
    const continuation = new AbortController();
    continuations.add(continuation);
    options.phase?.("working");
    if (reminder !== undefined) {
      emit("reminder-due");
      // It has the check-in's response window to answer in.
      reminderUntil = now() + policy.responseMs;
    }
    observe(
      Promise.resolve()
        .then(() => messages.continueWith(held!, sequence, continuation.signal, reminder))
        .finally(() => continuations.delete(continuation)),
      false,
    );
  };
  const clearAnswerTimers = () => {
    quietUntil = responseUntil = deliveryUntil = receiptUntil = undefined;
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
      deliver(dispatchStartedAt ?? event.admittedAt);
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
  const removeStop = options.onStop((request) => {
    if (finished) return released.promise;
    stop ??= request;
    stopped.resolve();
    void options.slots.close(options.operationId);
    cancelPending();
    for (const continuation of continuations) continuation.abort();
    changed();
    return released.promise;
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
    finished = true;
    removeStop();
    released.resolve();
    return terminal(stop?.kind ?? "failed", stop?.reason ?? messageOf(error));
  }
  emit("opened", undefined, finite(deadline));
  const unwatch = options.messages?.onChange(changed);
  if (stop) void options.slots.close(options.operationId);
  void slot.settled.then((value) => {
    settlement = value;
    changed();
  });
  const observe = (opening: Promise<HarnessTurn>, check: boolean) => {
    acquiring = opening;
    const current = sequence;
    const grantRevision = revision;
    let accepted = false;
    let received = false;
    receiptUntil = undefined;
    const boundMissingReceipt = () => {
      if (
        result === undefined &&
        check &&
        waitingSupported &&
        accepted &&
        !received &&
        native?.state === "completed" &&
        !admitted &&
        !receiptSatisfied &&
        grantRevision === revision &&
        receiptUntil === undefined
      )
        receiptUntil = Math.min(deadline, now() + policy.responseMs);
    };
    const priorNative = native;
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
              result === undefined &&
              outcome.state === "completed" &&
              !admitted &&
              waitUntil === undefined &&
              responseUntil === undefined &&
              !check
            )
              quietUntil = now() + (waitingSupported ? policy.quietMs : 0);
            if (result === undefined && !waitingSupported && check && outcome.state === "completed")
              responseUntil = now();
            boundMissingReceipt();
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
            deliver(at);
            if (
              result === undefined &&
              !admitted &&
              !receiptSatisfied &&
              grantRevision === revision
            )
              deliveryUntil = Math.min(deadline, at + policy.deliveryMs);
            emit("dispatched", undefined, deliveryUntil);
            changed();
          });
          void turn.delivery.accepted.then(() => {
            if (!valid()) return;
            accepted = true;
            boundMissingReceipt();
            deliveryUntil = undefined;
            emit("queue-accepted");
            changed();
          });
          void turn.delivery.received.then((at) => {
            if (!valid()) return;
            received = true;
            receiptUntil = undefined;
            deliveryUntil = undefined;
            if (
              result === undefined &&
              check &&
              !admitted &&
              !receiptSatisfied &&
              grantRevision === revision
            ) {
              responseUntil = Math.min(deadline, at + policy.responseMs);
              options.phase?.("check-in-response", undefined, responseUntil);
            }
            emit("received", undefined, responseUntil);
            changed();
          });
          void turn.delivery.failed.then((reason) => {
            if (!valid()) return;
            acquisitionError = new Error(`delivery observation failed: ${reason}`);
            changed();
          });
        } else if (waitingSupported) {
          acquisitionError = new Error("waiting operation has no delivery evidence");
          changed();
        } else {
          deliver(now());
        }
        changed();
      },
      (error) => {
        if (finished || abandonedAcquisition) return;
        acquiring = undefined;
        if (
          ignoredCancellation &&
          controller?.signal.aborted &&
          error instanceof Error &&
          error.name === "AbortError"
        ) {
          native = priorNative;
        } else {
          acquisitionError = error;
        }
        if (admitted) beginAnswerRelease();
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
      if (outsideSince !== undefined && !options.messages?.awaiting()?.outside) waitedOutside(at);
      // The scope's own stop ends the wait at the ceiling, with its reason; this is the backstop.
      if (!admitted && outsideSince !== undefined && at >= ceiling + CEILING_GRACE_MS) {
        result = terminal("timed-out", "a deadline around it passed while it waited");
        break;
      }
      if (
        !admitted &&
        ((outsideSince === undefined && at >= deadline) || settlement?.kind === "expired")
      ) {
        result = terminal("timed-out", "operation deadline exceeded");
        break;
      }
      if (settlement?.kind === "closed") {
        result = terminal("cancelled", "operation closed");
        break;
      }
      if (acquisitionError && !admitted) {
        result = terminal("failed", String(acquisitionError));
        break;
      }
      if (!admitted) {
        if (
          native &&
          native.state !== "completed" &&
          !(ignoredCancellation && native.state === "cancelled")
        ) {
          result = {
            ...terminal(
              native.state === "timed-out" ? "timed-out" : native.state,
              native.detail ?? `native turn ${native.state}`,
            ),
            ...(native.state === "failed" && native.login ? { login: native.login } : {}),
          };
          break;
        }
        if (deliveryUntil !== undefined && at >= deliveryUntil) {
          result = terminal("failed", "prompt delivery could not be confirmed");
          break;
        }
        if (receiptUntil !== undefined && at >= receiptUntil) {
          result = terminal(
            "failed",
            "check-in receipt could not be confirmed after native completion",
          );
          break;
        }
        if (responseUntil !== undefined && at >= responseUntil) {
          result = terminal("unanswered", "check-in received no waiting declaration or result");
          break;
        }
        const idle = native !== undefined && !acquiring;
        const settledTurn =
          idle &&
          responseUntil === undefined &&
          deliveryUntil === undefined &&
          receiptUntil === undefined;
        const messages = options.messages;
        // Before any check-in: what continues it goes now, cutting a `wf waiting` short, and an
        // operation awaiting an answer waits for it with no check-in.
        if (messages && settledTurn) {
          if (messages.pending() === "continues") {
            continueWithMessages(messages);
            continue;
          }
          const awaited = messages.awaiting();
          if (awaited) {
            if (awaitingPeer?.peer !== awaited.peer || awaitingPeer.until !== awaited.until) {
              awaitingPeer = awaited;
              options.phase?.("awaiting-reply", awaited.peer, awaited.until);
              emit("awaiting-reply", undefined, awaited.until, now(), awaited.peer);
            }
            if (awaited.outside && outsideSince === undefined) {
              outsideSince = at;
              // Its result stays open while it waits: only the deadlines around it end that.
              options.extended?.(finite(ceiling + CEILING_GRACE_MS), true);
            }
            waitUntil = quietUntil = undefined;
          } else awaitingPeer = undefined;
        }
        const due =
          waitUntil !== undefined ? at >= waitUntil : quietUntil !== undefined && at >= quietUntil;
        if (idle && due && responseUntil === undefined && deliveryUntil === undefined) {
          const next = messages?.turnEnded();
          if (next?.kind === "continue" || next?.kind === "remind") {
            continueWithMessages(messages!, next.kind === "remind" ? next.text : undefined);
            continue;
          }
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
        // Without nudges, a normal completion retains the existing immediate no-answer rule, after
        // what its messages go on to: a reminder of an answer it owes still comes.
        if (idle && !options.nudge && waitUntil === undefined && !awaitingPeer) {
          const next = settledTurn ? messages?.turnEnded() : undefined;
          if (next?.kind === "continue" || next?.kind === "remind") {
            continueWithMessages(messages!, next.kind === "remind" ? next.text : undefined);
            continue;
          }
          result = terminal("unanswered", "agent settled without an accepted result");
          break;
        }
        if (reminderUntil !== undefined && at >= reminderUntil) {
          reminderUntil = undefined;
          options.messages?.reminderExpired();
        }
      }
      // Timers against this pass's own clock: a time that came due while it ran fires at once,
      // where judging it by a later reading would leave it neither due nor timed.
      const candidates = admitted
        ? []
        : [
            outsideSince === undefined ? deadline : ceiling + CEILING_GRACE_MS,
            waitUntil,
            quietUntil,
            responseUntil,
            deliveryUntil,
            receiptUntil,
            reminderUntil,
          ].filter((v): v is number => v !== undefined && v > at);
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
      else if (acquiring === acquisition || !held) {
        abandonedAcquisition = true;
        result.cleanupUnresolved = true;
      }
    }
    if (result.kind === "answered" && !held) result.cleanupUnresolved = true;
    if (held) {
      const stopping = stop !== undefined;
      if (stopping)
        releaseDeadline = Math.min(releaseDeadline, now() + Math.min(policy.releaseMs, 5000));
      const natural = !stopping && result.kind === "answered";
      let release = await releaseHeld(natural, stop?.reason ?? result.reason, releaseDeadline);
      if (stop && natural) {
        release = await releaseHeld(false, stop.reason, now() + Math.min(policy.releaseMs, 5000));
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
  } catch (error) {
    clearAnswerTimers();
    cancelPending();
    try {
      await options.slots.close(options.operationId);
    } catch {
      // Cleanup is already unresolved; retain the original failure and observed usage.
    }
    return { ...terminal("failed", messageOf(error)), cleanupUnresolved: true };
  } finally {
    finished = true;
    unwatch?.();
    removeStop();
    released.resolve();
  }
  async function releaseHeld(
    answered: boolean,
    reason: string,
    until: number,
  ): Promise<HarnessReleaseDisposition | undefined> {
    if (!held) return undefined;
    if (answered) {
      if (abandonedAcquisition) {
        return bounded(
          held.release(
            reason,
            { unixMilliseconds: until },
            { answered: true, awaitCompletion: true },
          ),
          until,
        );
      }
      beginAnswerRelease();
      return answerRelease ? bounded(answerRelease, answerReleaseDeadline!, true) : undefined;
    }
    return bounded(held.release(reason, { unixMilliseconds: until }), until);
  }
  function beginAnswerRelease() {
    if (finished || abandonedAcquisition || !held || acquiring || answerRelease || stop) return;
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
      settledAt:
        kind === "timed-out"
          ? Math.min(now(), outsideSince === undefined ? deadline : ceiling)
          : now(),
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
