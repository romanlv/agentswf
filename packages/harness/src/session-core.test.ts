import { expect, test } from "bun:test";
import { createSessionAdapter, type NativeTurnRequest } from "./session-core";

test("successors preserve authority and permit only one successor per handle", async () => {
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const requests: NativeTurnRequest[] = [];
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        async execute(request) {
          requests.push(request);
          return {
            state: "completed",
            resultEvidence: { kind: "unavailable" },
            chargesUsd: [],
            sessionRef: "native",
          };
        },
        async close() {},
      };
    },
  });
  const session = await adapter.activate({
    key: "agent",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const binding = { endpoint: "/unused", operationId: "one" };
  const first = await session.start({ id: "first", prompt: "start", deadline }, binding);
  const second = await first.nudge({ id: "second", prompt: "check one", deadline });
  const third = await second.nudge({ id: "third", prompt: "check two", deadline });
  await third.settled;
  await expect(first.nudge({ id: "duplicate", deadline })).rejects.toThrow("already been nudged");
  await expect(second.nudge({ id: "duplicate", deadline })).rejects.toThrow("already been nudged");
  expect(requests.map((request) => request.id)).toEqual(["first", "second", "third"]);
  expect(requests.map((request) => request.binding)).toEqual([binding, binding, binding]);
  expect(requests.slice(1).every((request) => request.previousSessionRef === "native")).toBe(true);
  await session.close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const completed = {
  state: "completed" as const,
  resultEvidence: { kind: "unavailable" as const },
  chargesUsd: [],
};

test("delivery facts are distinct, clocked once and absent on unsupported backends", async () => {
  let clock = 10;
  let request!: NativeTurnRequest;
  const end = deferred<typeof completed>();
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    now: () => clock,
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        confirmsDelivery: true,
        async execute(next) {
          request = next;
          return end.promise;
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: 1000 };
  const session = await adapter.activate({
    key: "agent",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  expect(session.supportsWaiting).toBe(true);
  const turn = await session.start(
    { id: "one", prompt: "question", deadline },
    { endpoint: "/unused", operationId: "op" },
  );
  request.onReceived?.(); // A provider cannot claim receipt before it submitted anything.
  request.onDispatched?.();
  clock = 20;
  request.onDispatched?.();
  request.onAccepted?.();
  clock = 30;
  request.onReceived?.();
  expect(await turn.delivery!.dispatched).toBe(10);
  expect(await turn.delivery!.accepted).toBe(20);
  expect(await turn.delivery!.received).toBe(30);
  end.resolve(completed);
  await turn.settled;
  await turn.release("answered", deadline, { answered: true, awaitCompletion: true });
  expect(request.receiptSignal?.aborted).toBe(true);
  await session.close();
});

test("bounded answered release waits naturally past the answer deadline without interrupting", async () => {
  let clock = 10;
  let stops = 0;
  let handedBack = 0;
  const end = deferred<typeof completed>();
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    now: () => clock,
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        finishesAnswered: true,
        async execute() {
          return end.promise;
        },
        async cancel() {
          stops++;
          return true;
        },
        async stopFinishing() {
          stops++;
          return true;
        },
        leftFinishing() {
          handedBack++;
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: 100 };
  const session = await adapter.activate({
    key: "agent",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "one", prompt: "question", deadline },
    { endpoint: "/unused", operationId: "op" },
  );
  const releasing = turn.release(
    "answered",
    { unixMilliseconds: 1000 },
    { answered: true, awaitCompletion: true },
  );
  clock = 200;
  end.resolve(completed);
  expect((await releasing).kind).toBe("released");
  expect(stops).toBe(0);
  expect(handedBack).toBe(1);
  await session.close();
});

test("an expired natural release quarantines without stopping caller observation", async () => {
  let stops = 0;
  const end = deferred<typeof completed>();
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    now: () => 10,
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        finishesAnswered: true,
        async execute() {
          return end.promise;
        },
        async cancel() {
          stops++;
          return true;
        },
        async stopFinishing() {
          stops++;
          return true;
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: 1000 };
  const session = await adapter.activate({
    key: "agent",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "one", prompt: "question", deadline },
    { endpoint: "/unused", operationId: "op" },
  );
  expect(
    (
      await turn.release(
        "answered",
        { unixMilliseconds: 10 },
        { answered: true, awaitCompletion: true },
      )
    ).kind,
  ).toBe("quarantined");
  expect(stops).toBe(0);
  end.resolve(completed);
  await turn.settled;
  await expect(
    session.start(
      { id: "two", prompt: "later", deadline },
      { endpoint: "/unused", operationId: "two" },
    ),
  ).rejects.toThrow("quarantined");
  await session.close();
});

test("observer cancellation is not a confirmed natural release", async () => {
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        async execute() {
          return { ...completed, state: "cancelled" as const };
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: Date.now() + 1000 };
  const session = await adapter.activate({
    key: "agent",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  expect(session.supportsWaiting).toBeUndefined();
  const turn = await session.start(
    { id: "one", prompt: "question", deadline },
    { endpoint: "/unused", operationId: "op" },
  );
  expect(turn.delivery).toBeUndefined();
  await turn.settled;
  expect(
    (await turn.release("answered", deadline, { answered: true, awaitCompletion: true })).kind,
  ).toBe("quarantined");
  await session.close();
});

test("fresh answered observation outlives an expired prompt observer", async () => {
  let clock = 10;
  const original = deferred<{
    state: "timed-out";
    resultEvidence: { kind: "unavailable" };
    chargesUsd: never[];
  }>();
  const fresh = deferred<typeof completed>();
  let releaseDeadline = 0;
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    now: () => clock,
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        async execute() {
          return original.promise;
        },
        async finishAnswered(deadline) {
          releaseDeadline = deadline.unixMilliseconds;
          return fresh.promise;
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: 100 };
  const session = await adapter.activate({
    key: "agent",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "one", prompt: "question", deadline },
    { endpoint: "/unused", operationId: "op" },
  );
  const releasing = turn.release(
    "admitted",
    { unixMilliseconds: 1000 },
    { answered: true, awaitCompletion: true },
  );
  clock = 200;
  original.resolve({ ...completed, state: "timed-out" });
  await turn.settled;
  fresh.resolve(completed);
  expect((await releasing).kind).toBe("released");
  expect(releaseDeadline).toBe(1000);
  await session.close();
});

test("an earlier answer cannot release an unconsumed queued check-in", async () => {
  let clock = 10;
  let request!: NativeTurnRequest;
  let reobserved = false;
  const ended = deferred<typeof completed>();
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    now: () => clock,
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        confirmsDelivery: true,
        async execute(next) {
          request = next;
          next.onDispatched?.();
          next.onAccepted?.();
          return ended.promise;
        },
        async finishAnswered() {
          reobserved = true;
          return completed;
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: 100 };
  const session = await adapter.activate({
    key: "agent",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "check", prompt: "check", deadline },
    { endpoint: "/unused", operationId: "op" },
  );
  const releasing = turn.release(
    "earlier turn answered",
    { unixMilliseconds: 1000 },
    { answered: true, awaitCompletion: true },
  );
  expect(request.receiptSignal?.aborted).toBe(false);
  expect(request.receiptDeadline?.()).toBe(1000);
  expect(reobserved).toBe(false);
  clock = 200;
  request.onReceived?.();
  ended.resolve(completed);
  expect((await releasing).kind).toBe("released");
  expect(reobserved).toBe(true);
  expect(request.receiptSignal?.aborted).toBe(true);
  await session.close();
});

test("non-success release stops owned work even after native completion and receipt", async () => {
  for (const receipt of [true, false]) {
    let stopped = 0;
    const adapter = createSessionAdapter({
      harnesses: ["fake"],
      async activate() {
        return {
          identity: { sessionId: "native", cwd: "/tmp" },
          confirmsDelivery: true,
          finishesAnswered: true,
          async execute(request) {
            request.onDispatched?.();
            if (receipt) request.onReceived?.();
            return { ...completed, sessionRef: "native" };
          },
          async cancel() {
            stopped++;
            return true;
          },
          async close() {},
        };
      },
    });
    const deadline = { unixMilliseconds: Date.now() + 60_000 };
    const session = await adapter.activate({
      key: "a",
      cwd: "/tmp",
      deadline,
      execution: { harness: "fake", model: "fake" },
    });
    const turn = await session.start(
      { id: "one", prompt: "silent", deadline },
      { endpoint: "/unused", operationId: "op" },
    );
    await turn.settled;
    expect((await turn.release("unanswered", deadline)).kind).toBe("released");
    expect(stopped).toBe(1);
    if (receipt)
      expect(
        (
          await (
            await session.start(
              { id: "two", prompt: "followup", deadline },
              { endpoint: "/unused", operationId: "next" },
            )
          ).settled
        ).state,
      ).toBe("completed");
    await session.close();
  }
});

test("an abandoned natural release cannot quarantine a later operation", async () => {
  const fresh = deferred<{
    state: "failed";
    resultEvidence: { kind: "unavailable" };
    chargesUsd: never[];
  }>();
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        async execute() {
          return completed;
        },
        async finishAnswered() {
          return fresh.promise;
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const session = await adapter.activate({
    key: "a",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "one", prompt: "one", deadline },
    { endpoint: "/unused", operationId: "one" },
  );
  await turn.settled;
  const stale = turn.release("answer", deadline, { answered: true, awaitCompletion: true });
  expect((await turn.release("cancelled", deadline)).kind).toBe("released");
  const next = await session.start(
    { id: "two", prompt: "two", deadline },
    { endpoint: "/unused", operationId: "two" },
  );
  await next.settled;
  fresh.resolve({ ...completed, state: "failed" });
  expect((await stale).kind).toBe("quarantined");
  expect((await session.status()).state).not.toBe("quarantined");
  const third = await session.start(
    { id: "three", prompt: "three", deadline },
    { endpoint: "/unused", operationId: "three" },
  );
  expect((await third.settled).state).toBe("completed");
  await session.close();
});

test("a pre-aborted check-in does not change session state or consume the successor", async () => {
  let executions = 0;
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        async execute(request) {
          executions++;
          return request.deliverySignal?.aborted
            ? { ...completed, state: "cancelled" as const }
            : { ...completed, sessionRef: "native" };
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: Date.now() + 1000 };
  const session = await adapter.activate({
    key: "a",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "one", prompt: "one", deadline },
    { endpoint: "/unused", operationId: "op" },
  );
  await turn.settled;
  await expect(
    turn.nudge({ id: "cancelled", deadline, deliverySignal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: "AbortError", message: "check-in cancelled before dispatch" });
  expect(await session.status()).toEqual({ state: "idle" });
  expect(executions).toBe(1);
  await (await turn.nudge({ id: "two", deadline })).settled;
  expect(executions).toBe(2);
});

test("receipt observer failure is explicit and ends answered release promptly", async () => {
  let request!: NativeTurnRequest & { onDeliveryFailed?: (reason: string) => void };
  const adapter = createSessionAdapter({
    harnesses: ["fake"],
    async activate() {
      return {
        identity: { sessionId: "native", cwd: "/tmp" },
        confirmsDelivery: true,
        async execute(next) {
          request = next;
          next.onDispatched?.();
          next.onAccepted?.();
          return completed;
        },
        async close() {},
      };
    },
  });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const session = await adapter.activate({
    key: "a",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "one", prompt: "one", deadline },
    { endpoint: "/unused", operationId: "op" },
  );
  const delivery = turn.delivery as typeof turn.delivery & { failed?: Promise<string> };
  expect(delivery?.failed).toBeInstanceOf(Promise);
  request.onDeliveryFailed?.("Claude receipt transcript was replaced or truncated");
  expect(await delivery!.failed).toContain("truncated");
  expect(
    await turn.release("admitted", deadline, { answered: true, awaitCompletion: true }),
  ).toMatchObject({ kind: "quarantined", reason: expect.stringContaining("truncated") });
});

test.each([true, false])(
  "a check-in aborted during preparation restores only confirmed undispatched status (%s)",
  async (confirmsDelivery) => {
    const preparing = deferred<void>();
    const resume = deferred<void>();
    const adapter = createSessionAdapter({
      harnesses: ["fake"],
      async activate() {
        return {
          identity: { sessionId: "native", cwd: "/tmp" },
          ...(confirmsDelivery ? { confirmsDelivery: true as const } : {}),
          async execute(request) {
            if (request.kind === "nudge") {
              preparing.resolve();
              await resume.promise;
            }
            return request.deliverySignal?.aborted
              ? { ...completed, state: "cancelled" as const }
              : { ...completed, sessionRef: "native" };
          },
          async close() {},
        };
      },
    });
    const deadline = { unixMilliseconds: Date.now() + 1000 };
    const session = await adapter.activate({
      key: "a",
      cwd: "/tmp",
      deadline,
      execution: { harness: "fake", model: "fake" },
    });
    const turn = await session.start(
      { id: "one", prompt: "one", deadline },
      { endpoint: "/unused", operationId: "op" },
    );
    await turn.settled;
    const controller = new AbortController();
    const successor = await turn.nudge({ id: "two", deadline, deliverySignal: controller.signal });
    await preparing.promise;
    controller.abort();
    resume.resolve();
    expect((await successor.settled).state).toBe("cancelled");
    expect(await session.status()).toEqual({ state: confirmsDelivery ? "idle" : "dormant" });
    await session.close();
  },
);
