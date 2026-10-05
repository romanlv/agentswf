import { expect, test } from "bun:test";
import type { HarnessTurn, HarnessTurnOutcome } from "@agentswf/harness/adapter";
import { type LivenessPolicy, superviseOperation } from "./operation-liveness";
import { createResultSlotRegistry } from "./result-slots";

const completed: HarnessTurnOutcome = {
  state: "completed",
  resultEvidence: { kind: "unavailable" },
  chargesUsd: [],
};
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
function setup(
  overrides: {
    write?: () => Promise<boolean>;
    nudge?: boolean;
    start?: (turn: HarnessTurn) => Promise<HarnessTurn>;
    release?: HarnessTurn["release"];
  } = {},
) {
  let time = 0;
  let next = 0;
  const timers = new Map<number, { at: number; action: () => void }>();
  const schedule = (at: number, action: () => void) => {
    const id = ++next;
    timers.set(id, { at, action });
    return () => {
      timers.delete(id);
    };
  };
  const advance = async (ms: number) => {
    time += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= time) {
        timers.delete(id);
        timer.action();
      }
    }
    await flush();
  };
  const policy: LivenessPolicy = { quietMs: 10, responseMs: 20, deliveryMs: 15, releaseMs: 25 };
  const slots = createResultSlotRegistry({
    runDir: "/unused",
    now: () => time,
    schedule: (ms, fn) => schedule(time + ms, fn),
    waitMinimumMs: 10,
    waitDefaultMs: 20,
    persistenceMs: 20,
    auditMs: 5,
    persistence: {
      writeCall: async () => {},
      writeAcceptedExclusive: overrides.write ?? (async () => true),
      recordCandidate: async () => {},
    },
  });
  const native: ReturnType<typeof Promise.withResolvers<HarnessTurnOutcome>>[] = [];
  const receipts: {
    dispatch: ReturnType<typeof Promise.withResolvers<number>>;
    accepted: ReturnType<typeof Promise.withResolvers<number>>;
    received: ReturnType<typeof Promise.withResolvers<number>>;
  }[] = [];
  let releases = 0;
  let stops: (reason: string) => void = () => {};
  const events: string[] = [];
  const make = () => {
    const end = Promise.withResolvers<HarnessTurnOutcome>();
    native.push(end);
    const delivery = {
      dispatch: Promise.withResolvers<number>(),
      accepted: Promise.withResolvers<number>(),
      received: Promise.withResolvers<number>(),
    };
    receipts.push(delivery);
    const turn: HarnessTurn = {
      settled: end.promise,
      delivery: {
        dispatched: delivery.dispatch.promise,
        accepted: delivery.accepted.promise,
        received: delivery.received.promise,
      },
      deliver: async () => {},
      nudge: async () => make(),
      release:
        overrides.release ??
        (async () => {
          releases++;
          return { kind: "released", outcome: completed };
        }),
    };
    return turn;
  };
  const run = superviseOperation({
    operationId: "op",
    agentId: "agent",
    question: "go",
    schema: { type: "string" },
    deadline: { unixMilliseconds: 100 },
    slots,
    nudge: overrides.nudge ?? true,
    now: () => time,
    schedule,
    policy,
    start: () => {
      const turn = make();
      return overrides.start?.(turn) ?? Promise.resolve(turn);
    },
    successor: async () => make(),
    onStop: (cancel) => {
      stops = cancel;
      return () => {
        stops = () => {};
      };
    },
    event: (e) => events.push(e.kind),
  });
  const receive = (n: number) => {
    receipts[n]!.dispatch.resolve(time);
    receipts[n]!.accepted.resolve(time);
    receipts[n]!.received.resolve(time);
  };
  const waiting = (timeoutMs = 20) =>
    slots.waiting({ operationId: "op", agentId: "agent", reason: "job", timeoutMs });
  const answer = () =>
    slots.submit({ operationId: "op", agentId: "agent", raw: '"done"', source: "wf" });
  return {
    run,
    slots,
    advance,
    receive,
    waiting,
    answer,
    native,
    receipts,
    events,
    stop: (why = "stop") => stops(why),
    releases: () => releases,
  };
}

test("several waiting renewals share a fixed operation and end with one answer", async () => {
  const s = setup();
  await flush();
  s.receive(0);
  await s.waiting();
  s.native[0]!.resolve(completed);
  await flush();
  for (let i = 1; i <= 3; i++) {
    await s.advance(20);
    expect(s.native).toHaveLength(i + 1);
    s.receive(i);
    await flush();
    await s.waiting();
    s.native[i]!.resolve(completed);
    await flush();
  }
  await s.answer();
  const result = await s.run;
  expect(result).toMatchObject({ kind: "answered", value: "done", cleanupUnresolved: false });
  expect(s.releases()).toBe(1);
});
test("a received silent check-in gets one response window, not another prompt", async () => {
  const s = setup();
  await flush();
  s.receive(0);
  s.native[0]!.resolve(completed);
  await flush();
  await s.advance(10);
  s.receive(1);
  s.native[1]!.resolve(completed);
  await flush();
  await s.advance(20);
  expect((await s.run).kind).toBe("unanswered");
  expect(s.native).toHaveLength(2);
});
test("confirmed native queue acceptance waits beyond transport grace for receipt", async () => {
  const s = setup();
  await flush();
  s.receive(0);
  s.native[0]!.resolve(completed);
  await flush();
  await s.advance(10);
  s.receipts[1]!.dispatch.resolve(10);
  s.receipts[1]!.accepted.resolve(10);
  await flush();
  await s.advance(40);
  expect(s.events).not.toContain("terminal");
  s.receipts[1]!.received.resolve(50);
  await flush();
  await s.answer();
  expect((await s.run).kind).toBe("answered");
});
test("unconfirmed dispatch fails within delivery bound", async () => {
  const s = setup();
  await flush();
  s.native[0]!.resolve(completed);
  await flush();
  await s.advance(10);
  s.receipts[1]!.dispatch.resolve(10);
  await flush();
  await s.advance(15);
  expect(await s.run).toMatchObject({
    kind: "failed",
    reason: "prompt delivery could not be confirmed",
  });
});
test("responsive waiting cannot move the hard deadline", async () => {
  const s = setup();
  await flush();
  s.receive(0);
  await s.waiting(1000);
  await s.advance(100);
  expect((await s.run).kind).toBe("timed-out");
  expect((await s.answer()).kind).toBe("rejected");
});
test("nudge false honours a proactive grant then ends idle unanswered", async () => {
  const s = setup({ nudge: false });
  await flush();
  s.receive(0);
  await s.waiting();
  s.native[0]!.resolve(completed);
  await flush();
  await s.advance(20);
  expect((await s.run).kind).toBe("unanswered");
  expect(s.native).toHaveLength(1);
});
test("admission starts native release and cancels answer deadline while persistence finishes", async () => {
  const writing = Promise.withResolvers<boolean>();
  const s = setup({ write: () => writing.promise });
  await flush();
  s.receive(0);
  await s.advance(99);
  const submitted = s.answer();
  await flush();
  expect(s.releases()).toBe(1);
  await s.advance(2);
  writing.resolve(true);
  await submitted;
  expect((await s.run).kind).toBe("answered");
});
test("stop fences a queued validation continuation and cannot return answered", async () => {
  const s = setup();
  await flush();
  s.receive(0);
  const submitted = s.answer();
  s.stop();
  await flush();
  expect((await submitted).kind).toBe("rejected");
  expect((await s.run).kind).toBe("cancelled");
});
test("cancellation during persistence prevents success even if the value is saved", async () => {
  const writing = Promise.withResolvers<boolean>();
  const s = setup({ write: () => writing.promise });
  await flush();
  s.receive(0);
  const submitted = s.answer();
  await flush();
  s.stop();
  writing.resolve(true);
  await submitted;
  expect((await s.run).kind).toBe("cancelled");
});
test("unresolved native release preserves failure rather than returning the answer", async () => {
  const s = setup({ release: async () => ({ kind: "quarantined", reason: "still working" }) });
  await flush();
  s.receive(0);
  await s.answer();
  expect(await s.run).toMatchObject({
    kind: "failed",
    reason: "cleanup-unresolved",
    cleanupUnresolved: true,
  });
});
test("late receipt cannot re-arm the response timer after a newer waiting declaration", async () => {
  const s = setup();
  await flush();
  s.receive(0);
  s.native[0]!.resolve(completed);
  await flush();
  await s.advance(10);
  await s.waiting(50);
  s.receive(1);
  s.native[1]!.resolve(completed);
  await flush();
  await s.advance(21);
  expect(s.events).not.toContain("terminal");
  await s.answer();
  expect((await s.run).kind).toBe("answered");
});

test("cancellation interrupts natural answer release and performs bounded stop", async () => {
  const calls: boolean[] = [];
  const s = setup({
    release: async (_reason, _deadline, options) => {
      calls.push(options?.awaitCompletion === true);
      if (options?.awaitCompletion) return new Promise(() => {});
      return { kind: "released", outcome: { ...completed, state: "cancelled" } };
    },
  });
  await flush();
  s.receive(0);
  await s.answer();
  await flush();
  expect(calls).toEqual([true]);
  s.stop();
  await flush();
  expect(await s.run).toMatchObject({ kind: "cancelled", cleanupUnresolved: false });
  expect(calls).toEqual([true, false]);
});

test("unconfirmed initial dispatch fails before another prompt is sent", async () => {
  const s = setup();
  await flush();
  s.receipts[0]!.dispatch.resolve(0);
  await flush();
  await s.advance(15);
  expect(await s.run).toMatchObject({
    kind: "failed",
    reason: "prompt delivery could not be confirmed",
  });
  expect(s.native).toHaveLength(1);
});
