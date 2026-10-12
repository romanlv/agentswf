import { describe, expect, test } from "bun:test";
import { createFakeAdapter, createManualClock } from "./fake";

const BINDING = {
  endpoint: "/private/engine.sock",
  operationId: "op-1",
};

describe("createFakeAdapter", () => {
  test("exercises the engine-facing adapter contract without tokens", async () => {
    const clock = createManualClock(1_000);
    const adapter = createFakeAdapter({
      clock,
      script: (context) => ({
        state: "completed",
        transcript: `turn ${context.turn}`,
        sessionRef: "fake-native-session",
        durationMs: 5,
      }),
    });
    const session = await adapter.activate({
      key: "reviewer",
      deadline: { unixMilliseconds: 2_000 },
      cwd: "/repo",
      execution: { harness: "fake", model: "fake" },
    });
    const first = await session.start(
      { id: "turn-1", prompt: "review", deadline: { unixMilliseconds: 2_000 } },
      BINDING,
    );
    await expect(first.settled).resolves.toMatchObject({
      state: "completed",
      resultEvidence: { kind: "transcript", text: "turn 1" },
    });
    const compact = await session.compact("compact-1", "summarize", { unixMilliseconds: 2_000 });
    await compact.settled;
    await session.close();

    expect(adapter.turns[0]?.binding).toEqual(BINDING);
    expect(adapter.turns[1]?.binding).toBeUndefined();
    expect(adapter.turns[1]?.previousSessionRef).toBe("fake-native-session");
    expect(adapter.closed).toEqual(["reviewer"]);
    expect(clock.now()).toBe(1_010);
  });

  test("activation and operation deadlines are enforced by the shared core", async () => {
    const clock = createManualClock(10);
    const adapter = createFakeAdapter({ clock, script: () => ({}) });
    await expect(
      adapter.activate({
        key: "late",
        deadline: { unixMilliseconds: 10 },
        cwd: "/repo",
        execution: { harness: "fake", model: "fake" },
      }),
    ).rejects.toMatchObject({ code: "deadline-exceeded" });

    const running = await createFakeAdapter({
      clock,
      script: () => ({ durationMs: 2 }),
    }).activate({
      key: "crosses-deadline",
      deadline: { unixMilliseconds: 11 },
      cwd: "/repo",
      execution: { harness: "fake", model: "fake" },
    });
    const late = await running.start(
      { id: "late", prompt: "work", deadline: { unixMilliseconds: 11 } },
      BINDING,
    );
    await expect(late.settled).resolves.toMatchObject({ state: "timed-out" });
  });

  test("the shared core keeps the backend's own session handle out of the outcome", async () => {
    const adapter = createFakeAdapter({
      script: () => ({
        detail: "reviewed",
        transcript: "reviewed",
        sessionRef: "native-session-7",
      }),
    });
    const deadline = { unixMilliseconds: Date.now() + 60_000 };
    const session = await adapter.activate({
      key: "reviewer",
      deadline,
      cwd: "/repo",
      execution: { harness: "fake", model: "fake" },
    });
    const turn = await session.start({ id: "turn-1", prompt: "review", deadline }, BINDING);
    const outcome = await turn.settled;

    // `sessionRef` is how the harness resumes; the engine is given evidence, not that handle.
    expect(outcome.resultEvidence).toEqual({ kind: "transcript", text: "reviewed" });
    expect(JSON.stringify(outcome)).not.toContain("native-session-7");
  });

  test("quarantine is observable and prevents continuation", async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const adapter = createFakeAdapter({
      script: async ({ signal }) => {
        began();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const deadline = { unixMilliseconds: Date.now() + 60_000 };
    const session = await adapter.activate({
      key: "reviewer",
      deadline,
      cwd: "/repo",
      execution: { harness: "fake", model: "fake" },
    });
    const turn = await session.start({ id: "one", prompt: "one", deadline }, BINDING);
    await started;

    await expect(turn.release("stop", { unixMilliseconds: Date.now() })).resolves.toEqual({
      kind: "quarantined",
      reason: "release deadline exceeded",
    });
    await expect(session.status()).resolves.toEqual({
      state: "quarantined",
      detail: "release deadline exceeded",
    });
    await expect(turn.nudge({ id: "nudge", deadline })).rejects.toThrow("quarantined");
    await expect(
      session.start({ id: "two", prompt: "two", deadline }, { ...BINDING, operationId: "op-2" }),
    ).rejects.toThrow("quarantined");
    await session.close();
  });

  test("cancellation interrupts a hanging fake and close waits for it", async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const adapter = createFakeAdapter({
      script: async ({ signal }) => {
        began();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const deadline = { unixMilliseconds: Date.now() + 60_000 };
    const session = await adapter.activate({
      key: "cancelled",
      deadline,
      cwd: "/repo",
      execution: { harness: "fake", model: "fake" },
    });
    const turn = await session.start({ id: "turn-1", prompt: "wait", deadline }, BINDING);
    await started;

    await expect(turn.release("stop", deadline)).resolves.toMatchObject({ kind: "released" });
    await expect(turn.settled).resolves.toMatchObject({ state: "cancelled" });
    await session.close();

    expect(adapter.closed).toEqual(["cancelled"]);
  });
});

test("deliver continues an operation once its turn settles, and may repeat", async () => {
  const adapter = createFakeAdapter({
    script: (context) => {
      if (context.kind === "deliver") context.nameSession(`resumed-${context.id}`);
      return {};
    },
    supportsWaiting: true,
  });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const session = await adapter.activate({
    key: "asker",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const binding = { endpoint: "/unused", operationId: "op-1" };
  const first = await session.start({ id: "t1", prompt: "Ask the architect.", deadline }, binding);
  const named: string[] = [];
  const reply = await first.deliver({
    id: "t2",
    prompt: "The reply you were waiting for, from architect.",
    deadline,
    authored: {
      prompt: "Ask the architect.",
      messages: [{ kind: "message", from: "architect", text: "In the queue.", answers: true }],
    },
    onSession: (ref) => named.push(ref),
  });
  expect(await reply.delivery?.received).toBeNumber();
  const failure = await reply.deliver({ id: "t3", prompt: "No reply from tester.", deadline });
  await failure.settled;
  expect(adapter.turns.map(({ kind, binding }) => [kind, binding?.operationId])).toEqual([
    ["turn", "op-1"],
    ["deliver", "op-1"],
    ["deliver", "op-1"],
  ]);
  expect(adapter.turns[1]?.authored?.messages).toEqual([
    { kind: "message", from: "architect", text: "In the queue.", answers: true },
  ]);
  expect(adapter.turns[1]?.previousSessionRef).toBe("fake-asker");
  // The hook reaches the native turn that carries the delivery.
  expect(named).toEqual(["resumed-t2"]);
  // One successor per turn: a check-in or a delivery, never both.
  await expect(first.deliver({ id: "again", prompt: "x", deadline })).rejects.toThrow(
    "already been continued",
  );
  await expect(first.nudge({ id: "again", deadline })).rejects.toThrow("already been continued");
  const checked = await failure.nudge({ id: "t4", deadline });
  await checked.settled;
  await expect(failure.deliver({ id: "again", prompt: "x", deadline })).rejects.toThrow(
    "already been nudged",
  );
  await session.close();
});

test("deliver needs an operation and stops before dispatch when cancelled", async () => {
  const adapter = createFakeAdapter({ script: () => ({}) });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const session = await adapter.activate({
    key: "a",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const compaction = await session.compact("c1", "keep the plan", deadline);
  await expect(compaction.deliver({ id: "d", prompt: "x", deadline })).rejects.toThrow(
    "no operation to continue",
  );
  await compaction.settled;
  const turn = await session.start(
    { id: "t1", prompt: "go", deadline },
    {
      endpoint: "/unused",
      operationId: "op-1",
    },
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    turn.deliver({ id: "d", prompt: "x", deadline, deliverySignal: cancelled.signal }),
  ).rejects.toThrow("cancelled before dispatch");
  await session.close();
});

test("a delivery withdrawn before dispatch runs nothing and leaves the agent as it was", async () => {
  // A pane waits to go idle before typing; withdrawing meanwhile must not make it look stopped.
  const adapter = createFakeAdapter({ script: () => ({}), supportsWaiting: true });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const session = await adapter.activate({
    key: "a",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "t1", prompt: "go", deadline },
    {
      endpoint: "/unused",
      operationId: "op-1",
    },
  );
  await turn.settled;
  const withdrawn = new AbortController();
  const pending = turn.deliver({
    id: "d",
    prompt: "x",
    deadline,
    deliverySignal: withdrawn.signal,
  });
  withdrawn.abort();
  const delivered = await pending.catch((error: Error) => error);
  if (!(delivered instanceof Error)) {
    expect((await delivered.settled).state).toBe("cancelled");
  }
  expect(adapter.turns.map(({ kind }) => kind)).toEqual(["turn"]);
  expect(await session.status()).toEqual({ state: "idle" });
  await session.close();
});

test("one successor: a check-in and a delivery racing on a turn, one wins", async () => {
  const adapter = createFakeAdapter({ script: () => ({}) });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const session = await adapter.activate({
    key: "a",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "t1", prompt: "go", deadline },
    {
      endpoint: "/unused",
      operationId: "op-1",
    },
  );
  const [nudged, delivered] = await Promise.allSettled([
    turn.nudge({ id: "n", deadline }),
    turn.deliver({ id: "d", prompt: "x", deadline }),
  ]);
  expect([nudged.status, delivered.status].sort()).toEqual(["fulfilled", "rejected"]);
  const lost = [nudged, delivered].find((each) => each.status === "rejected");
  expect(String((lost as PromiseRejectedResult).reason)).toContain("already been");
  await session.close();
});

test("a delivery that cannot start leaves the turn free for its check-in", async () => {
  const adapter = createFakeAdapter({ script: () => ({}) });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const session = await adapter.activate({
    key: "a",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const turn = await session.start(
    { id: "t1", prompt: "go", deadline },
    {
      endpoint: "/unused",
      operationId: "op-1",
    },
  );
  const past = { unixMilliseconds: Date.now() - 1 };
  await expect(turn.deliver({ id: "late", prompt: "x", deadline: past })).rejects.toThrow();
  await (await turn.nudge({ id: "n", deadline })).settled;
  expect(adapter.turns.map(({ kind }) => kind)).toEqual(["turn", "nudge"]);
  await session.close();
});

test("no delivery continues an operation released, or one another operation followed", async () => {
  const adapter = createFakeAdapter({ script: () => ({}) });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const session = await adapter.activate({
    key: "a",
    cwd: "/tmp",
    deadline,
    execution: { harness: "fake", model: "fake" },
  });
  const first = await session.start(
    { id: "t1", prompt: "one", deadline },
    {
      endpoint: "/unused",
      operationId: "op-1",
    },
  );
  await first.release("answered", deadline);
  await expect(first.deliver({ id: "d1", prompt: "x", deadline })).rejects.toThrow("released");
  const second = await session.start(
    { id: "t2", prompt: "two", deadline },
    {
      endpoint: "/unused",
      operationId: "op-2",
    },
  );
  await second.settled;
  const third = await session.start(
    { id: "t3", prompt: "three", deadline },
    {
      endpoint: "/unused",
      operationId: "op-3",
    },
  );
  await third.settled;
  await expect(second.deliver({ id: "d2", prompt: "x", deadline })).rejects.toThrow(
    "another turn has run",
  );
  expect(adapter.turns.map(({ id }) => id)).toEqual(["t1", "t2", "t3"]);
  await session.close();
});
