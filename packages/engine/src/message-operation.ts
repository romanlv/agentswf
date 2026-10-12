import type { HarnessTurn, HarnessTurnOutcome } from "@agentswf/harness/adapter";
import { scheduleAt } from "./deadlines";
import { messageOf } from "./errors";
import {
  DEFAULT_LIVENESS_POLICY,
  type LivenessEvent,
  type LivenessPolicy,
  type OperationMessages,
  type OperationPhase,
  type OperationStop,
  type SupervisedOutcome,
} from "./operation-liveness";

/**
 * A message operation: no result slot and no check-in. Its turn's end goes on to what continues it,
 * a wait for an answer it asked for, the one reminder of an answer it owes, or its end, which is
 * not a failure. A timeout or the harness failing is, and stops the agent as any operation's does.
 * A stop or the deadline ends it whatever it is doing, a turn being started or delivered included.
 */
export async function superviseMessageOperation(options: {
  /** Moves only later, as the operation takes questions whose askers wait longer. */
  deadline(): number;
  start(): Promise<HarnessTurn>;
  messages: OperationMessages;
  onStop(cancel: (stop: OperationStop) => Promise<void>): () => void;
  event?(event: LivenessEvent): void;
  phase?(phase: OperationPhase, reason?: string, until?: number): void;
  delivered?(at: number): void;
  policy?: LivenessPolicy;
  now?: () => number;
}): Promise<SupervisedOutcome> {
  const now = options.now ?? Date.now;
  const policy = options.policy ?? DEFAULT_LIVENESS_POLICY;
  const charges: number[] = [];
  let sequence = 0;
  let deliveredAt: number | undefined;
  let stop: OperationStop | undefined;
  let wake = Promise.withResolvers<void>();
  const changed = () => wake.resolve();
  const released = Promise.withResolvers<void>();
  const removeStop = options.onStop((request) => {
    stop ??= request;
    acquisition?.abort();
    changed();
    return released.promise;
  });
  const unwatch = options.messages.onChange(changed);
  const emit = (kind: LivenessEvent["kind"], reason?: string, until?: number, peer?: string) =>
    options.event?.({
      kind,
      at: now(),
      sequence,
      ...(reason === undefined ? {} : { reason }),
      ...(until === undefined ? {} : { until }),
      ...(peer === undefined ? {} : { peer }),
    });
  const ended = (kind: SupervisedOutcome["kind"], reason: string): SupervisedOutcome => ({
    kind,
    reason,
    cleanupUnresolved: false,
    charges,
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    settledAt: kind === "timed-out" ? Math.min(now(), options.deadline()) : now(),
  });
  /** Until something changes, a stop, the deadline, or `until`, whichever comes first. */
  const nextChange = async (until = Number.POSITIVE_INFINITY) => {
    const cancel = scheduleAt({ unixMilliseconds: Math.min(options.deadline(), until) }, changed);
    try {
      await wake.promise;
    } finally {
      cancel();
      wake = Promise.withResolvers<void>();
    }
  };
  const stopped = () => stop !== undefined || now() >= options.deadline();
  /** Aborts a delivery not yet dispatched when the operation is stopped. */
  let acquisition: AbortController | undefined;

  /**
   * A turn being started or delivered, raced against a stop and the deadline. One that arrives
   * after the operation ended is released, bounded, so nothing is left running.
   */
  const acquire = async (opening: (signal: AbortSignal) => Promise<HarnessTurn>) => {
    acquisition = new AbortController();
    const pending = opening(acquisition.signal);
    let turn: HarnessTurn | undefined;
    let error: unknown;
    void pending.then(
      (value) => {
        turn = value;
        changed();
      },
      (reason: unknown) => {
        error = reason;
        changed();
      },
    );
    while (turn === undefined && error === undefined && !stopped()) await nextChange();
    acquisition = undefined;
    if (turn === undefined && error === undefined) {
      void pending.then(
        (late) => late.release("operation already ended", bound()).catch(() => undefined),
        () => undefined,
      );
      return undefined;
    }
    if (error !== undefined) throw error;
    return turn;
  };
  const bound = (answered = false) => ({
    unixMilliseconds: now() + (answered ? policy.releaseMs : Math.min(policy.releaseMs, 5_000)),
  });

  /**
   * The turn's end, or a failure: its settling rejected, its delivery failed, or its dispatch was
   * not confirmed in time.
   */
  const observe = async (
    turn: HarnessTurn,
    /** A reminder's response window: what it owes fails then, if still unanswered. */
    window?: number,
  ): Promise<HarnessTurnOutcome | "stopped"> => {
    let outcome: HarnessTurnOutcome | undefined;
    let failure: string | undefined;
    let deliveryUntil: number | undefined;
    void turn.settled.then(
      (value) => {
        outcome = value;
        charges.push(...value.chargesUsd);
        changed();
      },
      (error: unknown) => {
        failure = messageOf(error);
        changed();
      },
    );
    if (turn.delivery) {
      void turn.delivery.dispatched.then((at) => {
        deliveredAt ??= at;
        if (sequence === 0) options.delivered?.(at);
        deliveryUntil = at + policy.deliveryMs;
        changed();
      });
      void turn.delivery.accepted.then(() => {
        deliveryUntil = undefined;
        changed();
      });
      void turn.delivery.failed.then((reason) => {
        failure = `delivery observation failed: ${reason}`;
        changed();
      });
    } else if (deliveredAt === undefined) {
      deliveredAt = now();
      options.delivered?.(deliveredAt);
    }
    for (;;) {
      if (failure !== undefined) throw new Error(failure);
      if (outcome) return outcome;
      if (stopped()) return "stopped";
      if (deliveryUntil !== undefined && now() >= deliveryUntil) {
        throw new Error("prompt delivery could not be confirmed");
      }
      if (window !== undefined && now() >= window) {
        options.messages.reminderExpired();
        window = undefined;
      }
      await nextChange(Math.min(deliveryUntil ?? Infinity, window ?? Infinity));
    }
  };

  emit("opened", undefined, options.deadline());
  let turn: HarnessTurn | undefined;
  let result: SupervisedOutcome;
  try {
    result = await (async (): Promise<SupervisedOutcome> => {
      if (stopped()) {
        return stop ? ended(stop.kind, stop.reason) : ended("timed-out", "deadline before start");
      }
      options.phase?.("working");
      turn = await acquire(() => options.start());
      let reminded: number | undefined;
      for (;;) {
        if (!turn || stopped()) break;
        const native = await observe(turn, reminded);
        if (native === "stopped") break;
        if (native.state !== "completed") {
          return ended(
            native.state === "blocked" ? "failed" : native.state,
            native.detail ?? `native turn ${native.state}`,
          );
        }
        reminded = undefined;
        let next = options.messages.turnEnded();
        while (next.kind === "wait" && !stopped()) {
          options.phase?.("awaiting-reply", next.peer, next.until);
          emit("awaiting-reply", undefined, next.until, next.peer);
          // An answer, a failure or a question continues it; nothing else does.
          while (!stopped() && options.messages.pending() !== "continues") await nextChange();
          next = options.messages.turnEnded();
        }
        if (stopped()) break;
        if (next.kind === "settle" || next.kind === "check-in") {
          return ended("answered", "the message was handled");
        }
        if (next.kind === "wait") continue;
        sequence += 1;
        const reminder = next.kind === "remind" ? next.text : undefined;
        if (reminder !== undefined) {
          emit("reminder-due");
          // It has the check-in's response window to answer in.
          reminded = now() + policy.responseMs;
        }
        options.phase?.("working");
        const previous: HarnessTurn = turn;
        turn = await acquire((signal) =>
          options.messages.continueWith(previous, sequence, signal, reminder),
        );
      }
      if (stop) return ended(stop.kind, stop.reason);
      return ended("timed-out", "message operation deadline exceeded");
    })();
  } catch (error) {
    result = ended("failed", messageOf(error));
  } finally {
    unwatch();
  }
  options.phase?.("releasing");
  emit("releasing");
  if (turn) {
    const answered = result.kind === "answered";
    const until = bound(answered);
    const release = await Promise.race([
      turn.release(stop?.reason ?? result.reason, until, { answered }).catch(() => undefined),
      new Promise<undefined>((resolve) => scheduleAt(until, () => resolve(undefined))),
    ]);
    emit("release", release?.kind ?? "unresolved");
    if (release?.kind !== "released" && release?.kind !== "finishing") {
      result.cleanupUnresolved = true;
    }
  }
  emit("terminal", result.reason);
  removeStop();
  released.resolve();
  return result;
}
