import { afterAll, describe, expect, test } from "bun:test";
import type { SemanticCheck } from "@wf/contract";
import {
  createResultSlotRegistry,
  type ResultSlotRegistryOptions,
  type ResultSlotSpec,
} from "./result-slots";
import {
  readAccepted,
  readAttempts,
  recordAttempt,
  writeAcceptedExclusive,
  writeCall,
} from "./run-dir";
import { COUNT_SCHEMA, createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

const SOURCE = "control-plane";
const AGENT = "agent-1";
const NOW = 1_800_000_000_000;
const DEADLINE = { unixMilliseconds: NOW + 10_000 };
type TestPersistence = NonNullable<ResultSlotRegistryOptions["persistence"]>;

function call(overrides: Partial<ResultSlotSpec> = {}): ResultSlotSpec {
  return {
    operationId: "op-1",
    agentId: AGENT,
    question: "review",
    deadline: DEADLINE,
    ...overrides,
  };
}

function answer(raw = "{}", overrides: { operationId?: string; agentId?: string } = {}) {
  return { operationId: "op-1", agentId: AGENT, raw, source: SOURCE, ...overrides };
}

function persistenceWith(overrides: Partial<TestPersistence>): TestPersistence {
  return { writeCall, recordAttempt, writeAcceptedExclusive, ...overrides };
}

describe("result slots", () => {
  test("concurrent valid submissions settle once and only the winner is accepted", async () => {
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const semantic: SemanticCheck = async () => {
      arrivals += 1;
      if (arrivals === 12) release();
      await gate;
      return { kind: "accepted" };
    };
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir, now: () => NOW });
    const binding = await slots.open(call({ semantic }));

    const submissions = await Promise.all(
      Array.from({ length: 12 }, (_, n) => slots.submit(answer(JSON.stringify({ n })))),
    );

    expect(submissions.filter((item) => item.kind === "accepted")).toHaveLength(1);
    expect(
      submissions.filter((item) => item.kind === "rejected" && item.code === "closed-operation"),
    ).toHaveLength(11);
    const attempts = await readAttempts(runDir, "op-1");
    expect(attempts.filter((attempt) => attempt.accepted)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.accepted)).toHaveLength(11);
    const persisted = await readAccepted(runDir, "op-1");
    await expect(binding.settled).resolves.toEqual({
      kind: "accepted",
      value: persisted?.value,
      attemptRecorded: true,
    });
  });

  test("wrong agent, unknown, expired, and closed operations have stable codes", async () => {
    let now = NOW;
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir, now: () => now });
    const first = await slots.open(call());
    const second = await slots.open(call({ operationId: "op-2", agentId: "agent-2" }));

    await expect(slots.submit(answer("{}", { operationId: "op-2" }))).resolves.toMatchObject({
      kind: "rejected",
      code: "wrong-agent",
    });
    await expect(slots.submit(answer("{}", { operationId: "op-3" }))).resolves.toEqual({
      kind: "rejected",
      code: "unknown-operation",
      error: "unknown-operation",
    });

    now = DEADLINE.unixMilliseconds;
    await expect(slots.submit(answer())).resolves.toMatchObject({
      kind: "rejected",
      code: "expired-operation",
    });
    await expect(first.settled).resolves.toEqual({ kind: "expired" });
    await expect(slots.submit(answer())).resolves.toMatchObject({
      kind: "rejected",
      code: "expired-operation",
    });

    now = NOW;
    expect(await slots.close(second.operationId)).toBe(true);
    await expect(second.settled).resolves.toEqual({ kind: "closed" });
    await expect(
      slots.submit(answer("{}", { operationId: "op-2", agentId: "agent-2" })),
    ).resolves.toMatchObject({ kind: "rejected", code: "closed-operation" });
    expect(await readAccepted(runDir, "op-1")).toBeNull();
    expect(await readAccepted(runDir, "op-2")).toBeNull();
  });

  test("an open slot settles as expired without waiting for another submission", async () => {
    let expire!: () => void;
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      schedule: (_delay, callback) => {
        expire = callback;
        return () => undefined;
      },
    });
    const binding = await slots.open(call());

    expire();

    await expect(binding.settled).resolves.toEqual({ kind: "expired" });
  });

  test("concurrent opens reserve the operation id before persistence", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const persistence = persistenceWith({
      async writeCall(...args) {
        writes += 1;
        await gate;
        return writeCall(...args);
      },
    });
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      persistence,
    });

    const first = slots.open(call());
    await Promise.resolve();
    await expect(slots.open(call({ question: "again" }))).rejects.toThrow(
      "already exists for operation op-1",
    );
    expect(writes).toBe(1);
    release();
    await first;
  });

  test("failed call persistence rolls back the operation reservation", async () => {
    let fail = true;
    const persistence = persistenceWith({
      async writeCall(...args) {
        if (fail) throw new Error("call record unavailable");
        return writeCall(...args);
      },
    });
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      persistence,
    });

    await expect(slots.open(call())).rejects.toThrow("call record unavailable");
    fail = false;
    await expect(slots.open(call())).resolves.toMatchObject({ operationId: "op-1" });
  });

  test("schema and semantic failures remain field-level rejected attempts", async () => {
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir, now: () => NOW });
    await slots.open(
      call({
        question: "count letters",
        schema: COUNT_SCHEMA,
        semantic: async () => ({ kind: "rejected", reason: "wrong source text" }),
      }),
    );

    const malformed = await slots.submit(answer('{"count":"three","even":false}'));
    const semantic = await slots.submit(answer('{"count":3,"even":false}'));

    expect(malformed).toMatchObject({ kind: "rejected", code: "invalid-result" });
    expect(malformed.kind === "rejected" ? malformed.error : "").toContain(
      "value.count: expected an integer",
    );
    expect(semantic.kind === "rejected" ? semantic.error : "").toContain("wrong source text");
    expect(await readAccepted(runDir, "op-1")).toBeNull();
    expect((await readAttempts(runDir, "op-1")).every((attempt) => !attempt.accepted)).toBe(true);
  });

  test("closing during semantic validation prevents the late value from settling", async () => {
    let entered!: () => void;
    let release!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir, now: () => NOW });
    const binding = await slots.open(
      call({
        semantic: async () => {
          entered();
          await gate;
          return { kind: "accepted" };
        },
      }),
    );
    const submission = slots.submit(answer());
    await validationStarted;

    expect(await slots.close(binding.operationId)).toBe(true);
    release();

    await expect(submission).resolves.toMatchObject({
      kind: "rejected",
      code: "closed-operation",
    });
    await expect(binding.settled).resolves.toEqual({ kind: "closed" });
    expect(await readAccepted(runDir, "op-1")).toBeNull();
  });

  test("semantic checks cannot mutate the validated value that is accepted", async () => {
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir, now: () => NOW });
    const binding = await slots.open(
      call({
        question: "count letters",
        schema: COUNT_SCHEMA,
        semantic: async ({ value }) => {
          const mutable = value as Record<string, unknown>;
          mutable.count = "invalid after validation";
          return { kind: "accepted" };
        },
      }),
    );
    const original = { count: 3, even: false };

    const outcome = await slots.submit(answer(JSON.stringify(original)));

    expect(outcome).toMatchObject({ kind: "accepted", value: original });
    expect(await readAccepted(runDir, "op-1")).toEqual({ value: original });
    await expect(binding.settled).resolves.toMatchObject({ kind: "accepted", value: original });
  });

  test("expiry wins over semantic rejection that finishes later", async () => {
    let expire!: () => void;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      schedule: (_delay, callback) => {
        expire = callback;
        return () => undefined;
      },
    });
    await slots.open(
      call({
        semantic: async () => {
          entered();
          await gate;
          return { kind: "rejected", reason: "too late" };
        },
      }),
    );
    const submission = slots.submit(answer());
    await validationStarted;
    expire();
    finish();

    await expect(submission).resolves.toMatchObject({
      kind: "rejected",
      code: "expired-operation",
    });
  });

  test("a persistence failure leaves the slot open for a later valid submission", async () => {
    let fail = true;
    const persistence = persistenceWith({
      async writeAcceptedExclusive(...args) {
        if (fail) throw new Error("disk unavailable");
        return writeAcceptedExclusive(...args);
      },
    });
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir, now: () => NOW, persistence });
    await slots.open(call());

    await expect(slots.submit(answer())).rejects.toThrow("disk unavailable");
    fail = false;
    await expect(slots.submit(answer())).resolves.toMatchObject({ kind: "accepted" });
    expect((await readAttempts(runDir, "op-1")).filter((attempt) => attempt.accepted)).toHaveLength(
      1,
    );
  });

  test("attempt-log failure after atomic settlement cannot turn acceptance into rejection", async () => {
    const persistence = persistenceWith({
      async recordAttempt() {
        throw new Error("attempt log unavailable");
      },
    });
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir, now: () => NOW, persistence });
    const binding = await slots.open(call());

    const outcome = await slots.submit(answer());

    expect(outcome).toEqual({ kind: "accepted", value: {}, attemptRecorded: false });
    await expect(binding.settled).resolves.toEqual({
      kind: "accepted",
      value: {},
      attemptRecorded: false,
    });
    expect(await readAccepted(runDir, "op-1")).toEqual({ value: {} });
  });

  test("accepted settlement waits until the audit append reaches a final decision", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistence = persistenceWith({
      async recordAttempt(...args) {
        await gate;
        return recordAttempt(...args);
      },
    });
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      persistence,
    });
    const binding = await slots.open(call());
    let settled = false;
    void binding.settled.then(() => {
      settled = true;
    });

    const submission = slots.submit(answer());
    await Bun.sleep(0);
    expect(settled).toBe(false);

    release();
    await expect(submission).resolves.toEqual({
      kind: "accepted",
      value: {},
      attemptRecorded: true,
    });
    await expect(binding.settled).resolves.toEqual({
      kind: "accepted",
      value: {},
      attemptRecorded: true,
    });
  });
});
