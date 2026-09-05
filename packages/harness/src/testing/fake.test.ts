import { describe, expect, test } from "bun:test";
import { createFakeAdapter, createManualClock } from "./fake";

const BINDING = {
  endpoint: "/private/engine.sock",
  operationId: "op-1",
  capability: "A".repeat(43),
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
    const compact = await session.compact(
      "compact-1",
      "summarize",
      { unixMilliseconds: 2_000 },
    );
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

  test("one session rejects reused operation authority", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const deadline = { unixMilliseconds: Date.now() + 60_000 };
    const session = await adapter.activate({
      key: "reviewer",
      deadline,
      cwd: "/repo",
      execution: { harness: "fake", model: "fake" },
    });
    const first = await session.start({ id: "one", prompt: "one", deadline }, BINDING);
    await first.settled;

    await expect(
      session.start({ id: "two", prompt: "two", deadline }, BINDING),
    ).rejects.toThrow("already been used");
  });

  test("the shared core removes operation authority from backend output", async () => {
    const adapter = createFakeAdapter({
      script: () => ({
        detail: `echoed ${BINDING.operationId}`,
        transcript: `echoed ${BINDING.capability}`,
        sessionRef: BINDING.capability,
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

    expect(outcome.resultEvidence).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(outcome)).not.toContain(BINDING.operationId);
    expect(JSON.stringify(outcome)).not.toContain(BINDING.capability);
  });

  test("later outcomes cannot expose authority issued earlier in the session", async () => {
    const prior = { ...BINDING };
    const next = {
      endpoint: BINDING.endpoint,
      operationId: "op-2",
      capability: "B".repeat(43),
    };
    const adapter = createFakeAdapter({
      script: ({ turn }) =>
        turn === 1
          ? {}
          : {
              detail: `earlier ${prior.operationId}`,
              transcript: `earlier ${prior.capability}`,
              sessionRef: prior.capability,
            },
    });
    const deadline = { unixMilliseconds: Date.now() + 60_000 };
    const session = await adapter.activate({
      key: "reviewer",
      deadline,
      cwd: "/repo",
      execution: { harness: "fake", model: "fake" },
    });
    await (await session.start({ id: "one", prompt: "one", deadline }, prior)).settled;
    const outcome = await (
      await session.start({ id: "two", prompt: "two", deadline }, next)
    ).settled;

    expect(JSON.stringify(outcome)).not.toContain(prior.operationId);
    expect(JSON.stringify(outcome)).not.toContain(prior.capability);
    expect(outcome.resultEvidence).toEqual({ kind: "unavailable" });
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

    await expect(
      turn.release("stop", { unixMilliseconds: Date.now() }),
    ).resolves.toEqual({ kind: "quarantined", reason: "release deadline exceeded" });
    await expect(session.status()).resolves.toEqual({
      state: "quarantined",
      detail: "release deadline exceeded",
    });
    await expect(turn.nudge({ id: "nudge", deadline })).rejects.toThrow("quarantined");
    await expect(
      session.start({ id: "two", prompt: "two", deadline }, {
        ...BINDING,
        operationId: "op-2",
        capability: "B".repeat(43),
      }),
    ).rejects.toThrow("quarantined");
    await session.close();
  });

  test("cancellation interrupts a hanging fake and close waits for it", async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
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
