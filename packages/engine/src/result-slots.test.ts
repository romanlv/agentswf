import { afterAll, describe, expect, test } from "bun:test";
import type { SemanticCheck } from "@agentswf/contract";
import {
  createResultSlotRegistry,
  type ResultSlotRegistryOptions,
  type ResultSlotSpec,
} from "./result-slots";
import {
  readAccepted,
  readCandidates,
  recordCandidate,
  writeAcceptedExclusive,
  writeCall,
} from "./runs";
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
  return { writeCall, recordCandidate, writeAcceptedExclusive, ...overrides };
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
    const candidates = await readCandidates(runDir, "op-1");
    expect(candidates.filter((candidate) => candidate.accepted)).toHaveLength(1);
    expect(candidates.filter((candidate) => !candidate.accepted)).toHaveLength(11);
    const persisted = await readAccepted(runDir, "op-1");
    await expect(binding.settled).resolves.toEqual({
      kind: "accepted",
      value: persisted?.value,
      candidateRecorded: true,
      admittedAt: expect.any(Number),
      acceptedAt: expect.any(Number),
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

  test("schema and semantic failures remain field-level rejected candidates", async () => {
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
    expect((await readCandidates(runDir, "op-1")).every((candidate) => !candidate.accepted)).toBe(
      true,
    );
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

  test("a failed admitted write terminalizes the slot instead of allowing uncertain retry", async () => {
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      persistence: persistenceWith({
        async writeAcceptedExclusive() {
          throw new Error("disk unavailable");
        },
      }),
    });
    const binding = await slots.open(call());
    await expect(slots.submit(answer())).rejects.toThrow("disk unavailable");
    await expect(binding.settled).resolves.toEqual({ kind: "failed", reason: "disk unavailable" });
    await expect(slots.submit(answer())).resolves.toMatchObject({
      kind: "rejected",
      code: "closed-operation",
    });
  });

  test("candidate-log failure after atomic settlement cannot turn acceptance into rejection", async () => {
    const persistence = persistenceWith({
      async recordCandidate() {
        throw new Error("candidate log unavailable");
      },
    });
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir, now: () => NOW, persistence });
    const binding = await slots.open(call());

    const outcome = await slots.submit(answer());

    expect(outcome).toEqual({
      kind: "accepted",
      value: {},
      candidateRecorded: false,
      admittedAt: NOW,
      acceptedAt: NOW,
    });
    await expect(binding.settled).resolves.toEqual({
      kind: "accepted",
      value: {},
      candidateRecorded: false,
      admittedAt: NOW,
      acceptedAt: NOW,
    });
    expect(await readAccepted(runDir, "op-1")).toEqual({ value: {} });
  });

  test("accepted settlement waits until the audit append reaches a final decision", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistence = persistenceWith({
      async recordCandidate(...args) {
        await gate;
        return recordCandidate(...args);
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
      candidateRecorded: true,
      admittedAt: expect.any(Number),
      acceptedAt: expect.any(Number),
    });
    await expect(binding.settled).resolves.toEqual({
      kind: "accepted",
      value: {},
      candidateRecorded: true,
      admittedAt: expect.any(Number),
      acceptedAt: expect.any(Number),
    });
  });
});

function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

function manualTimers() {
  const pending = new Map<number, Set<() => void>>();
  return {
    schedule(delay: number, callback: () => void) {
      const group = pending.get(delay) ?? new Set<() => void>();
      pending.set(delay, group);
      group.add(callback);
      return () => {
        group.delete(callback);
      };
    },
    fire(delay: number) {
      const callbacks = [...(pending.get(delay) ?? [])];
      expect(callbacks.length).toBeGreaterThan(0);
      for (const callback of callbacks) callback();
    },
  };
}

describe("waiting and bounded commit admission", () => {
  test("waiting is authorized, clipped, revised in admission order and superseded by a result", async () => {
    let now = NOW;
    const events: import("./result-slots").ResultSlotEvent[] = [];
    const slots = createResultSlotRegistry({ runDir: tempRunDir(), now: () => now });
    const binding = await slots.open(
      call({
        allowWaiting: true,
        onEvent: (event) => events.push(event),
        deadline: { unixMilliseconds: NOW + 300_000 },
      }),
    );
    const wait = { operationId: "op-1", agentId: AGENT, reason: "deploy" };
    await expect(slots.waiting({ ...wait, agentId: "other" })).resolves.toMatchObject({
      code: "wrong-agent",
    });
    await expect(slots.waiting({ ...wait, operationId: "missing" })).resolves.toMatchObject({
      code: "unknown-operation",
    });
    await expect(slots.waiting({ ...wait, reason: " ", timeoutMs: 1 })).resolves.toMatchObject({
      code: "invalid-request",
    });
    await expect(slots.waiting({ ...wait, reason: "é".repeat(1025) })).resolves.toMatchObject({
      code: "invalid-request",
    });
    await expect(slots.waiting({ ...wait, timeoutMs: Infinity })).resolves.toMatchObject({
      code: "invalid-request",
    });
    await expect(slots.waiting({ ...wait, timeoutMs: 1 })).resolves.toEqual({
      kind: "waiting",
      waitUntil: NOW + 30_000,
      deadline: NOW + 300_000,
    });
    now += 10;
    await expect(slots.waiting(wait)).resolves.toMatchObject({ waitUntil: now + 120_000 });
    await expect(
      slots.waiting({ ...wait, timeoutMs: Number.MAX_SAFE_INTEGER }),
    ).resolves.toMatchObject({ waitUntil: NOW + 300_000 });
    expect(events.map((event) => event.revision)).toEqual([1, 2, 3]);
    await slots.submit(answer());
    await expect(binding.settled).resolves.toMatchObject({ kind: "accepted" });
    await expect(slots.waiting(wait)).resolves.toMatchObject({ code: "closed-operation" });
  });

  test("waiting is opt-in and exact expiry rejects it", async () => {
    let now = NOW;
    const slots = createResultSlotRegistry({ runDir: tempRunDir(), now: () => now });
    const binding = await slots.open(call());
    const wait = { operationId: "op-1", agentId: AGENT, reason: "deploy" };
    await expect(slots.waiting(wait)).resolves.toMatchObject({ code: "unsupported-command" });
    now = DEADLINE.unixMilliseconds;
    await expect(slots.waiting(wait)).resolves.toMatchObject({ code: "expired-operation" });
    await expect(binding.settled).resolves.toEqual({ kind: "expired" });
  });

  test("admission closes waiting immediately and close cannot be held by a write", async () => {
    const entered = deferred();
    const gate = deferred<boolean>();
    const events: import("./result-slots").ResultSlotEvent[] = [];
    let now = NOW;
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => now,
      persistence: persistenceWith({
        async writeAcceptedExclusive() {
          entered.resolve();
          return gate.promise;
        },
      }),
    });
    const binding = await slots.open(
      call({
        allowWaiting: true,
        onEvent: (event) => {
          events.push(event);
          if (event.kind === "admitted") throw new Error("observer failed");
        },
      }),
    );
    const submission = slots.submit(answer());
    await entered.promise;
    expect(events[0]).toEqual({ kind: "admitted", admittedAt: NOW, revision: 1 });
    await expect(
      slots.waiting({ operationId: "op-1", agentId: AGENT, reason: "late" }),
    ).resolves.toMatchObject({ code: "closed-operation" });
    expect(await slots.close("op-1")).toBe(true);
    await expect(binding.settled).resolves.toEqual({ kind: "closed" });
    now = DEADLINE.unixMilliseconds + 1;
    gate.resolve(true);
    await expect(submission).resolves.toMatchObject({
      kind: "accepted",
      admittedAt: NOW,
      acceptedAt: now,
    });
    await expect(binding.settled).resolves.toEqual({ kind: "closed" });
    expect(events.at(-1)?.kind).toBe("persisted");
  });

  test("an admitted answer can save after its answer deadline without expiring", async () => {
    let now = NOW;
    const entered = deferred();
    const gate = deferred<boolean>();
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => now,
      persistence: persistenceWith({
        async writeAcceptedExclusive() {
          entered.resolve();
          return gate.promise;
        },
      }),
    });
    const binding = await slots.open(call());
    const submission = slots.submit(answer());
    await entered.promise;
    now = DEADLINE.unixMilliseconds + 1;
    gate.resolve(true);
    await expect(submission).resolves.toMatchObject({
      kind: "accepted",
      admittedAt: NOW,
      acceptedAt: now,
    });
    await expect(binding.settled).resolves.toMatchObject({ kind: "accepted" });
  });

  test("hung publication fails within its bound and late success is evidence only", async () => {
    const timers = manualTimers();
    const entered = deferred();
    const gate = deferred<boolean>();
    const published = deferred();
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      schedule: timers.schedule,
      persistenceMs: 5,
      persistence: persistenceWith({
        async writeAcceptedExclusive() {
          entered.resolve();
          return gate.promise;
        },
      }),
    });
    const binding = await slots.open(
      call({
        onEvent: (event) => {
          if (event.kind === "persisted") published.resolve();
        },
      }),
    );
    const submission = slots.submit(answer());
    const rejected = submission.catch((error) => error);
    await entered.promise;
    timers.fire(5);
    expect(await rejected).toMatchObject({ message: "result persistence timed out" });
    await expect(binding.settled).resolves.toEqual({
      kind: "failed",
      reason: "result persistence timed out",
    });
    gate.resolve(true);
    await published.promise;
    await expect(binding.settled).resolves.toMatchObject({ kind: "failed" });
  });

  test("hung audit is bounded and never loses a durably accepted answer", async () => {
    const timers = manualTimers();
    const auditing = deferred();
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      schedule: timers.schedule,
      auditMs: 7,
      persistence: persistenceWith({
        async recordCandidate() {
          auditing.resolve();
          await new Promise(() => {});
        },
      }),
    });
    const binding = await slots.open(call());
    const submission = slots.submit(answer());
    await auditing.promise;
    timers.fire(7);
    await expect(submission).resolves.toMatchObject({ kind: "accepted", candidateRecorded: false });
    await expect(binding.settled).resolves.toMatchObject({
      kind: "accepted",
      candidateRecorded: false,
    });
  });
});

test("the timestamp checked for deadline eligibility is the recorded admission timestamp", async () => {
  let times: number[] = [];
  const slots = createResultSlotRegistry({ runDir: tempRunDir(), now: () => times.shift() ?? NOW });
  const binding = await slots.open(call());
  times = [NOW, DEADLINE.unixMilliseconds - 1, DEADLINE.unixMilliseconds];
  await expect(slots.submit(answer())).resolves.toMatchObject({
    kind: "accepted",
    admittedAt: DEADLINE.unixMilliseconds - 1,
    acceptedAt: DEADLINE.unixMilliseconds,
  });
  await expect(binding.settled).resolves.toMatchObject({ kind: "accepted" });
});

test("timed-out opening reserves its ID against a late call-record write", async () => {
  const timers = manualTimers();
  const entered = deferred();
  const gate = deferred();
  const slots = createResultSlotRegistry({
    runDir: tempRunDir(),
    now: () => NOW,
    schedule: timers.schedule,
    persistenceMs: 5,
    persistence: persistenceWith({
      async writeCall() {
        entered.resolve();
        await gate.promise;
      },
    }),
  });
  const opening = slots.open(call()).catch((error) => error);
  await entered.promise;
  timers.fire(5);
  expect(await opening).toMatchObject({ message: "call persistence timed out" });
  await expect(slots.open(call())).rejects.toThrow("already exists");
  gate.resolve();
  await expect(slots.submit(answer())).resolves.toMatchObject({ code: "closed-operation" });
});

test("close during call persistence does not install an expiry timer afterward", async () => {
  const write = Promise.withResolvers<void>();
  const timers = new Set<() => void>();
  const registry = createResultSlotRegistry({
    runDir: "/unused",
    now: () => NOW,
    schedule: (_ms, callback) => {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
    persistence: {
      writeCall: () => write.promise,
      writeAcceptedExclusive: async () => true,
      recordCandidate: async () => {},
    },
  });
  const opening = registry.open(call());
  await Promise.resolve();
  await registry.close("op-1");
  write.resolve();
  const slot = await opening;
  expect(await slot.settled).toEqual({ kind: "closed" });
  expect(timers.size).toBe(0);
});
