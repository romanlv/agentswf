import { expect, test } from "bun:test";
import type {
  HarnessReleaseDisposition,
  HarnessTurn,
  HarnessTurnOutcome,
} from "@agentswf/harness/adapter";
import { type OperationStop, superviseOperation } from "./operation-liveness";
import { createResultSlotRegistry } from "./result-slots";

const completed: HarnessTurnOutcome = {
  state: "completed",
  resultEvidence: { kind: "unavailable" },
  chargesUsd: [],
};
const cancelled: HarnessTurnOutcome = { ...completed, state: "cancelled" };
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

function clock() {
  let at = 0;
  const timers = new Set<{ at: number; action(): void }>();
  const schedule = (when: number, action: () => void) => {
    const timer = { at: when, action };
    timers.add(timer);
    return () => {
      timers.delete(timer);
    };
  };
  return {
    now: () => at,
    schedule,
    jump(when: number) {
      at = when;
    },
    async advance(when: number) {
      at = when;
      for (;;) {
        const ready = [...timers].filter((timer) => timer.at <= at);
        if (!ready.length) {
          await flush();
          if (![...timers].some((timer) => timer.at <= at)) return;
        }
        for (const timer of ready) {
          timers.delete(timer);
          timer.action();
        }
        await flush();
      }
    },
  };
}

function turn(release?: HarnessTurn["release"]) {
  const end = Promise.withResolvers<HarnessTurnOutcome>();
  const dispatched = Promise.withResolvers<number>();
  const accepted = Promise.withResolvers<number>();
  const received = Promise.withResolvers<number>();
  const releases: { answered: boolean; reason: string }[] = [];
  const handle: HarnessTurn = {
    settled: end.promise,
    delivery: {
      dispatched: dispatched.promise,
      accepted: accepted.promise,
      received: received.promise,
      failed: new Promise(() => {}),
    },
    deliver: async () => {},
    nudge: async () => {
      throw new Error("fixture must supply successor");
    },
    async release(reason, deadline, options) {
      releases.push({ answered: options?.answered === true, reason });
      return release
        ? release(reason, deadline, options)
        : { kind: "released", outcome: completed };
    },
  };
  return {
    handle,
    end,
    dispatched,
    accepted,
    received,
    releases,
    receive(at: number) {
      dispatched.resolve(at);
      accepted.resolve(at);
      received.resolve(at);
    },
  };
}

function fixture(
  options: {
    first?: ReturnType<typeof turn>;
    start?: () => Promise<HarnessTurn>;
    successor?: (sequence: number, signal: AbortSignal) => Promise<HarnessTurn>;
    write?: () => Promise<boolean>;
  } = {},
) {
  const time = clock();
  const first = options.first ?? turn();
  const turns = [first];
  const events: string[] = [];
  const phases: string[] = [];
  let stop: (stop: OperationStop) => Promise<void> = async () => {};
  const slots = createResultSlotRegistry({
    runDir: "/unused",
    now: time.now,
    schedule: (ms, action) => time.schedule(time.now() + ms, action),
    persistenceMs: 15,
    auditMs: 5,
    waitDefaultMs: 20,
    waitMinimumMs: 10,
    persistence: {
      writeCall: async () => {},
      recordCandidate: async () => {},
      writeAcceptedExclusive: options.write ?? (async () => true),
    },
  });
  const run = superviseOperation({
    operationId: "op",
    agentId: "agent",
    question: "go",
    schema: { type: "string" },
    deadline: { unixMilliseconds: 100 },
    slots,
    nudge: true,
    now: time.now,
    schedule: time.schedule,
    policy: { quietMs: 10, responseMs: 20, deliveryMs: 15, releaseMs: 25 },
    start: options.start ?? (async () => first.handle),
    successor: async (_prior, sequence, signal) => {
      if (options.successor) return options.successor(sequence, signal);
      const next = turn();
      turns.push(next);
      return next.handle;
    },
    onStop(cancel) {
      stop = cancel;
      return () => {
        stop = async () => {};
      };
    },
    event(event) {
      events.push(event.kind);
    },
    phase(phase) {
      phases.push(phase);
    },
  });
  return {
    run,
    time,
    turns,
    first,
    slots,
    events,
    phases,
    stop: () => stop({ kind: "cancelled", reason: "operator stopped" }),
    answer: () =>
      slots.submit({ operationId: "op", agentId: "agent", raw: '"done"', source: "control-plane" }),
    wait: (timeoutMs = 20) =>
      slots.waiting({ operationId: "op", agentId: "agent", reason: "deploy", timeoutMs }),
  };
}

test("acquisition after the cleanup deadline is released once without resurrecting the outcome", async () => {
  const acquisition = Promise.withResolvers<HarnessTurn>();
  const late = turn();
  const s = fixture({ start: () => acquisition.promise });
  await flush();
  await s.time.advance(100);
  await s.time.advance(125);
  const result = await s.run;
  expect(result).toMatchObject({ kind: "timed-out", cleanupUnresolved: true });
  acquisition.resolve(late.handle);
  await flush();
  late.receive(126);
  late.end.resolve(completed);
  await flush();
  expect(late.releases).toHaveLength(1);
  expect(s.events.filter((event) => event === "terminal")).toHaveLength(1);
  expect(result.kind).toBe("timed-out");
});

test("acquisition during cleanup is retained and released before cancellation returns", async () => {
  const acquisition = Promise.withResolvers<HarnessTurn>();
  const acquired = turn();
  const s = fixture({ start: () => acquisition.promise });
  await flush();
  s.stop();
  await flush();
  acquisition.resolve(acquired.handle);
  await flush();
  expect(await s.run).toMatchObject({ kind: "cancelled", cleanupUnresolved: false });
  expect(acquired.releases).toHaveLength(1);
});

test("renewed waiting cancels an undispatched successor and keeps the operation open", async () => {
  const next = turn();
  let signal: AbortSignal | undefined;
  const s = fixture({
    successor: async (_sequence, pending) => {
      signal = pending;
      return next.handle;
    },
  });
  await flush();
  s.first.receive(0);
  s.first.end.resolve(completed);
  await flush();
  await s.time.advance(10);
  await s.wait(40);
  expect(signal?.aborted).toBe(true);
  next.end.resolve(cancelled);
  await flush();
  await s.time.advance(30);
  expect(s.events).not.toContain("terminal");
  await s.answer();
  expect((await s.run).kind).toBe("answered");
});

test("a cancelled successor alone is not proof of native release", async () => {
  const pending = turn(async () => ({ kind: "released", outcome: cancelled }));
  let signal: AbortSignal | undefined;
  const s = fixture({
    successor: async (_sequence, next) => {
      signal = next;
      return pending.handle;
    },
  });
  await flush();
  s.first.receive(0);
  s.first.end.resolve(completed);
  await flush();
  await s.time.advance(10);
  await s.answer();
  expect(signal?.aborted).toBe(true);
  pending.end.resolve(cancelled);
  expect(await s.run).toMatchObject({
    kind: "failed",
    reason: "cleanup-unresolved",
    cleanupUnresolved: true,
  });
});

test("exact deadline rejects a result even before the scheduled expiry callback runs", async () => {
  const s = fixture();
  await flush();
  s.first.receive(0);
  s.time.jump(100);
  await expect(s.answer()).resolves.toMatchObject({ kind: "rejected", code: "expired-operation" });
  expect((await s.run).kind).toBe("timed-out");
});

test("admission stops answer clocks but hung persistence still fails at its own bound", async () => {
  const write = Promise.withResolvers<boolean>();
  const s = fixture({ write: () => write.promise });
  await flush();
  s.first.receive(0);
  await s.time.advance(99);
  const submission = s.answer().catch((error) => error);
  await flush();
  expect(s.first.releases).toHaveLength(1);
  await s.time.advance(101);
  expect(s.events).not.toContain("terminal");
  await s.time.advance(114);
  expect(await submission).toMatchObject({ message: "result persistence timed out" });
  const result = await s.run;
  expect(result).toMatchObject({ kind: "failed", reason: "result persistence timed out" });
  write.resolve(true);
  await flush();
  expect(result.kind).toBe("failed");
});

test("late delivery facts from a superseded native handle cannot re-arm a newer response window", async () => {
  const s = fixture();
  await flush();
  s.first.end.resolve(completed);
  await flush();
  await s.time.advance(10);
  const successor = s.turns[1]!;
  successor.receive(10);
  await flush();
  await s.wait(60);
  successor.end.resolve(completed);
  await flush();
  s.first.receive(25);
  await flush();
  await s.time.advance(45);
  expect(s.events).not.toContain("terminal");
  expect(s.turns).toHaveLength(2);
  await s.answer();
  expect((await s.run).kind).toBe("answered");
});

test("stop while successful release is pending prevents workflow success", async () => {
  const release = Promise.withResolvers<HarnessReleaseDisposition>();
  const first = turn(() => release.promise);
  const s = fixture({ first });
  await flush();
  first.receive(0);
  await s.answer();
  await flush();
  s.stop();
  release.resolve({ kind: "released", outcome: completed });
  await flush();
  expect(await s.run).toMatchObject({ kind: "cancelled", reason: "operator stopped" });
});

test("answering during undispatched cancellation waits for fresh native release evidence", async () => {
  const freshRelease = Promise.withResolvers<HarnessReleaseDisposition>();
  const pending = turn(() => freshRelease.promise);
  let signal: AbortSignal | undefined;
  const s = fixture({
    successor: async (_sequence, next) => {
      signal = next;
      return pending.handle;
    },
  });
  await flush();
  s.first.receive(0);
  s.first.end.resolve(completed);
  await flush();
  await s.time.advance(10);
  await s.answer();
  expect(signal?.aborted).toBe(true);
  pending.end.resolve(cancelled);
  await flush();
  expect(s.events).not.toContain("terminal");
  freshRelease.resolve({ kind: "released", outcome: completed });
  expect(await s.run).toMatchObject({ kind: "answered", value: "done", cleanupUnresolved: false });
});

test("stop during answered acquisition releases the acquired turn as stopped, never naturally", async () => {
  const acquisition = Promise.withResolvers<HarnessTurn>();
  const acquired = turn((_reason, _deadline, options) =>
    options?.answered
      ? new Promise(() => {})
      : Promise.resolve({ kind: "released", outcome: cancelled }),
  );
  const s = fixture({ start: () => acquisition.promise });
  await flush();
  await s.answer();
  await flush();
  s.stop();
  acquisition.resolve(acquired.handle);
  await flush();
  expect(acquired.releases).toEqual([{ answered: false, reason: "operator stopped" }]);
  expect(await s.run).toMatchObject({ kind: "cancelled", cleanupUnresolved: false });
});

test("owner closure during timeout cleanup cannot rename the terminal timeout", async () => {
  const released = Promise.withResolvers<HarnessReleaseDisposition>();
  const first = turn(() => released.promise);
  const s = fixture({ first });
  await flush();
  first.receive(0);
  await s.time.advance(100);
  expect(first.releases).toHaveLength(1);
  s.stop();
  released.resolve({ kind: "released", outcome: cancelled });
  await flush();
  expect(await s.run).toMatchObject({
    kind: "timed-out",
    settledAt: 100,
    cleanupUnresolved: false,
  });
});

test("owner closure during failed native cleanup preserves the failure cause", async () => {
  const released = Promise.withResolvers<HarnessReleaseDisposition>();
  const first = turn(() => released.promise);
  const s = fixture({ first });
  await flush();
  first.receive(0);
  first.end.resolve({ ...completed, state: "failed", detail: "native transport failed" });
  await flush();
  expect(first.releases).toHaveLength(1);
  s.stop();
  released.resolve({ kind: "released", outcome: cancelled });
  await flush();
  expect(await s.run).toMatchObject({
    kind: "failed",
    reason: "native transport failed",
    cleanupUnresolved: false,
  });
});

for (const persistedFirst of [false, true]) {
  test(`an admitted answer survives successor rejection (persisted first: ${persistedFirst})`, async () => {
    const writing = Promise.withResolvers<boolean>();
    const successor = Promise.withResolvers<HarnessTurn>();
    const s = fixture({ write: () => writing.promise, successor: () => successor.promise });
    await flush();
    s.first.receive(0);
    s.first.end.resolve(completed);
    await flush();
    await s.time.advance(10);
    const answer = s.answer();
    await flush();
    if (persistedFirst) {
      writing.resolve(true);
      await answer;
      await flush();
    }
    successor.reject(new Error("successor cancelled after admission"));
    await flush();
    writing.resolve(true);
    expect((await answer).kind).toBe("accepted");
    expect(await s.run).toMatchObject({
      kind: "answered",
      value: "done",
      cleanupUnresolved: false,
    });
    expect(s.first.releases.some((release) => release.answered)).toBe(true);
  });
}

test("a renewed wait can cancel acquisition before dispatch without consuming its prior handle", async () => {
  let attempts = 0;
  const next = turn();
  const s = fixture({
    successor: async (_sequence, signal) => {
      attempts++;
      if (attempts > 1) return next.handle;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    },
  });
  await flush();
  s.first.receive(0);
  s.first.end.resolve(completed);
  await flush();
  await s.time.advance(10);
  await s.wait(20);
  await flush();
  expect(s.events).not.toContain("terminal");
  await s.time.advance(30);
  expect(attempts).toBe(2);
  next.receive(30);
  next.end.resolve(completed);
  await s.answer();
  expect((await s.run).kind).toBe("answered");
});

test("late successor rejection cannot restart release after cleanup is unresolved", async () => {
  const successor = Promise.withResolvers<HarnessTurn>();
  const s = fixture({ successor: () => successor.promise });
  await flush();
  s.first.receive(0);
  s.first.end.resolve(completed);
  await flush();
  await s.time.advance(10);
  await s.answer();
  await flush();
  await s.time.advance(35);
  expect(await s.run).toMatchObject({ kind: "failed", cleanupUnresolved: true });
  const releases = s.first.releases.length;
  successor.reject(new Error("late successor failure"));
  await flush();
  expect(s.first.releases).toHaveLength(releases);
});

test("late receipt during cancellation release preserves releasing progress and final charges", async () => {
  const release = Promise.withResolvers<HarnessReleaseDisposition>();
  const next = turn(() => release.promise);
  const s = fixture({ successor: async () => next.handle });
  await flush();
  s.first.receive(0);
  s.first.end.resolve(completed);
  await flush();
  await s.time.advance(10);
  const stopping = s.stop();
  await flush();
  expect(s.phases.at(-1)).toBe("releasing");
  next.receive(11);
  next.end.resolve({ ...completed, chargesUsd: [7] });
  await flush();
  expect(s.phases.at(-1)).toBe("releasing");
  expect(s.events).toContain("received");
  release.resolve({ kind: "released", outcome: completed });
  await stopping;
  expect(await s.run).toMatchObject({ kind: "cancelled", charges: [7] });
});

test("initial acquisition rejection before persistence completes cannot prove cleanup", async () => {
  const acquisition = Promise.withResolvers<HarnessTurn>();
  const write = Promise.withResolvers<boolean>();
  const s = fixture({ start: () => acquisition.promise, write: () => write.promise });
  await flush();
  const submission = s.answer();
  await flush();
  acquisition.reject(new Error("initial launch failed after admission"));
  await flush();
  write.resolve(true);
  await expect(submission).resolves.toMatchObject({ kind: "accepted" });
  expect(await s.run).toMatchObject({ kind: "failed", cleanupUnresolved: true });
  expect(s.first.releases).toHaveLength(0);
});
