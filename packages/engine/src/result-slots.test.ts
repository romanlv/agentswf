import { afterAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SemanticCheck } from "@wf/contract";
import { readAccepted, readAttempts, recordAttempt, writeAcceptedExclusive, writeCall } from "./run-dir";
import {
  createResultSlotRegistry,
  type ResultSlotRegistryOptions,
} from "./result-slots";
import { COUNT_SCHEMA, createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

const SOURCE = "control-plane";
const NOW = 1_800_000_000_000;
const DEADLINE = { unixMilliseconds: NOW + 10_000 };
type TestPersistence = NonNullable<ResultSlotRegistryOptions["persistence"]>;

describe("result slots", () => {
  test("a generated capability is 32 random bytes encoded as base64url", async () => {
    const slots = createResultSlotRegistry({ runDir: tempRunDir(), now: () => NOW });

    const binding = await slots.open({
      operationId: "op-1",
      question: "review",
      deadline: DEADLINE,
    });

    expect(binding.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

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
    const slots = createResultSlotRegistry({
      runDir,
      now: () => NOW,
      generateCapability: () => "capability-op-1",
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "review",
      semantic,
      deadline: DEADLINE,
    });

    const submissions = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        slots.submit({
          operationId: "op-1",
          capability: binding.capability,
          raw: JSON.stringify({ n }),
          source: SOURCE,
        }),
      ),
    );

    expect(submissions.filter((item) => item.kind === "accepted")).toHaveLength(1);
    expect(
      submissions.filter(
        (item) => item.kind === "rejected" && item.code === "closed-capability",
      ),
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

  test("wrong, unknown, expired, and closed capabilities have stable codes", async () => {
    let now = NOW;
    const capabilities = ["capability-op-1", "capability-op-2"];
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({
      runDir,
      now: () => now,
      generateCapability: () => capabilities.shift() ?? "unexpected",
    });
    const first = await slots.open({
      operationId: "op-1",
      question: "review",
      deadline: DEADLINE,
    });
    const second = await slots.open({
      operationId: "op-2",
      question: "review",
      deadline: DEADLINE,
    });

    await expect(
      slots.submit({
        operationId: "op-2",
        capability: first.capability,
        raw: "{}",
        source: SOURCE,
      }),
    ).resolves.toMatchObject({ kind: "rejected", code: "wrong-operation" });
    await expect(
      slots.submit({
        operationId: "op-1",
        capability: "not-a-capability",
        raw: "{}",
        source: SOURCE,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      code: "unknown-capability",
      error: "unknown-capability",
    });

    now = DEADLINE.unixMilliseconds;
    await expect(
      slots.submit({
        operationId: "op-1",
        capability: first.capability,
        raw: "{}",
        source: SOURCE,
      }),
    ).resolves.toMatchObject({ kind: "rejected", code: "expired-capability" });
    await expect(first.settled).resolves.toEqual({ kind: "expired" });
    await expect(
      slots.submit({
        operationId: "op-1",
        capability: first.capability,
        raw: "{}",
        source: SOURCE,
      }),
    ).resolves.toMatchObject({ kind: "rejected", code: "expired-capability" });

    now = NOW;
    expect(await slots.close(second.capability)).toBe(true);
    await expect(second.settled).resolves.toEqual({ kind: "closed" });
    await expect(
      slots.submit({
        operationId: "op-2",
        capability: second.capability,
        raw: "{}",
        source: SOURCE,
      }),
    ).resolves.toMatchObject({ kind: "rejected", code: "closed-capability" });
    expect(await readAccepted(runDir, "op-1")).toBeNull();
    expect(await readAccepted(runDir, "op-2")).toBeNull();
  });

  test("an open slot settles as expired without waiting for another submission", async () => {
    let expire!: () => void;
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      generateCapability: () => "capability-op-1",
      schedule: (_delay, callback) => {
        expire = callback;
        return () => undefined;
      },
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "review",
      deadline: DEADLINE,
    });

    expire();

    await expect(binding.settled).resolves.toEqual({ kind: "expired" });
  });

  test("one operation and one capability cannot silently open two slots", async () => {
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      generateCapability: () => "same-capability",
    });
    await slots.open({ operationId: "op-1", question: "review", deadline: DEADLINE });

    await expect(
      slots.open({ operationId: "op-1", question: "again", deadline: DEADLINE }),
    ).rejects.toThrow("already exists for operation op-1");
    await expect(
      slots.open({ operationId: "op-2", question: "review", deadline: DEADLINE }),
    ).rejects.toThrow("capability generator produced a collision");
  });

  test("concurrent opens reserve both operation id and capability before persistence", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const persistence: TestPersistence = {
      async writeCall(...args) {
        writes += 1;
        await gate;
        return writeCall(...args);
      },
      recordAttempt,
      writeAcceptedExclusive,
    };
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      generateCapability: () => "same-capability",
      persistence,
    });

    const first = slots.open({ operationId: "op-1", question: "review", deadline: DEADLINE });
    await Promise.resolve();
    await expect(
      slots.open({ operationId: "op-1", question: "again", deadline: DEADLINE }),
    ).rejects.toThrow("already exists for operation op-1");
    await expect(
      slots.open({ operationId: "op-2", question: "review", deadline: DEADLINE }),
    ).rejects.toThrow("capability generator produced a collision");
    expect(writes).toBe(1);
    release();
    await first;
  });

  test("failed call persistence rolls back operation and capability reservations", async () => {
    let fail = true;
    const persistence: TestPersistence = {
      async writeCall(...args) {
        if (fail) throw new Error("call record unavailable");
        return writeCall(...args);
      },
      recordAttempt,
      writeAcceptedExclusive,
    };
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      generateCapability: () => "capability-op-1",
      persistence,
    });
    const spec = { operationId: "op-1", question: "review", deadline: DEADLINE };

    await expect(slots.open(spec)).rejects.toThrow("call record unavailable");
    fail = false;
    await expect(slots.open(spec)).resolves.toMatchObject({
      operationId: "op-1",
      capability: "capability-op-1",
    });
  });

  test("schema and semantic failures remain field-level rejected attempts", async () => {
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({
      runDir,
      now: () => NOW,
      generateCapability: () => "capability-op-1",
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "count letters",
      schema: COUNT_SCHEMA,
      semantic: async () => ({ kind: "rejected", reason: "wrong source text" }),
      deadline: DEADLINE,
    });

    const malformed = await slots.submit({
      operationId: "op-1",
      capability: binding.capability,
      raw: '{"count":"three","even":false}',
      source: SOURCE,
    });
    const semantic = await slots.submit({
      operationId: "op-1",
      capability: binding.capability,
      raw: '{"count":3,"even":false}',
      source: SOURCE,
    });

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
    const slots = createResultSlotRegistry({
      runDir,
      now: () => NOW,
      generateCapability: () => "capability-op-1",
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "review",
      deadline: DEADLINE,
      semantic: async () => {
        entered();
        await gate;
        return { kind: "accepted" };
      },
    });
    const submission = slots.submit({
      operationId: "op-1",
      capability: binding.capability,
      raw: "{}",
      source: SOURCE,
    });
    await validationStarted;

    expect(await slots.close(binding.capability)).toBe(true);
    release();

    await expect(submission).resolves.toMatchObject({
      kind: "rejected",
      code: "closed-capability",
    });
    await expect(binding.settled).resolves.toEqual({ kind: "closed" });
    expect(await readAccepted(runDir, "op-1")).toBeNull();
  });

  test("the bearer capability cannot enter a result, record, or diagnostic", async () => {
    const runDir = tempRunDir();
    const capability = "secret-capability-that-must-not-leak";
    const otherCapability = "other-active-capability-must-not-leak";
    const generated = [capability, otherCapability];
    const slots = createResultSlotRegistry({
      runDir,
      now: () => NOW,
      generateCapability: () => generated.shift() ?? "unexpected",
    });
    await slots.open({ operationId: "op-1", question: "review", deadline: DEADLINE });
    await slots.open({ operationId: "op-2", question: "review", deadline: DEADLINE });

    const escapedCapability = `\\u${capability.charCodeAt(0).toString(16).padStart(4, "0")}${capability.slice(1)}`;

    const outcome = await slots.submit({
      operationId: "op-1",
      capability,
      raw: `{"key-${escapedCapability}":"${otherCapability}"}`,
      source: `source-${capability}`,
    });
    const wrongOperation = await slots.submit({
      operationId: "op-2",
      capability,
      raw: JSON.stringify({ leak: otherCapability }),
      source: SOURCE,
    });
    expect(await slots.close(capability)).toBe(true);
    const closed = await slots.submit({
      operationId: "op-1",
      capability,
      raw: JSON.stringify({ leak: otherCapability }),
      source: SOURCE,
    });

    expect(outcome).toMatchObject({ kind: "rejected", code: "invalid-result" });
    expect(wrongOperation).toMatchObject({ kind: "rejected", code: "wrong-operation" });
    expect(closed).toMatchObject({ kind: "rejected", code: "closed-capability" });
    expect(JSON.stringify(outcome)).not.toContain(capability);
    const records = (await readAllFiles(runDir)).join("\n");
    expect(records).not.toContain(capability);
    expect(records).not.toContain(escapedCapability);
    expect(records).not.toContain(otherCapability);
    expect(await readAccepted(runDir, "op-1")).toBeNull();
  });

  test("a settled capability stays protected for the full run", async () => {
    const runDir = tempRunDir();
    const settled = "settled-capability-remains-protected";
    const generated = [
      settled,
      "literal-metadata-capability",
      "escaped-metadata-capability",
      "live-capability",
    ];
    const slots = createResultSlotRegistry({
      runDir,
      now: () => NOW,
      generateCapability: () => generated.shift() ?? "unexpected",
    });
    await slots.open({ operationId: "op-1", question: "review", deadline: DEADLINE });
    expect(await slots.close(settled)).toBe(true);

    await expect(slots.open({
      operationId: "rejected-metadata",
      question: `the earlier attempt used ${settled}`,
      deadline: DEADLINE,
    })).rejects.toThrow("metadata contains protected operation authority");
    const escaped = `\\u${settled.charCodeAt(0).toString(16).padStart(4, "0")}${settled.slice(1)}`;
    await expect(slots.open({
      operationId: "rejected-escaped-metadata",
      question: `the earlier attempt used ${escaped}`,
      deadline: DEADLINE,
    })).rejects.toThrow("metadata contains protected operation authority");
    await slots.open({ operationId: "op-2", question: "safe", deadline: DEADLINE });
    const raw = JSON.stringify({ note: settled });
    const outcome = await slots.submit({
      operationId: "op-2",
      capability: "live-capability",
      raw,
      source: SOURCE,
    });

    expect(outcome).toMatchObject({ kind: "rejected", code: "invalid-result" });
    expect((await readAttempts(runDir, "op-2")).map((attempt) => attempt.raw)).toEqual([
      "[redacted-capability-bearing-text]",
    ]);
    expect((await readAllFiles(runDir)).join("\n")).not.toContain(settled);
    expect((await readAllFiles(runDir)).join("\n")).not.toContain(escaped);
  });

  test("semantic checks cannot mutate the validated value that is accepted", async () => {
    const runDir = tempRunDir();
    const capability = "capability-op-1";
    const slots = createResultSlotRegistry({
      runDir,
      now: () => NOW,
      generateCapability: () => capability,
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "count letters",
      schema: COUNT_SCHEMA,
      semantic: async ({ value }) => {
        const mutable = value as Record<string, unknown>;
        mutable.count = "invalid after validation";
        mutable.leak = capability;
        return { kind: "accepted" };
      },
      deadline: DEADLINE,
    });
    const original = { count: 3, even: false };

    const outcome = await slots.submit({
      operationId: "op-1",
      capability,
      raw: JSON.stringify(original),
      source: SOURCE,
    });

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
      generateCapability: () => "capability-op-1",
      schedule: (_delay, callback) => {
        expire = callback;
        return () => undefined;
      },
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "review",
      semantic: async () => {
        entered();
        await gate;
        return { kind: "rejected", reason: "too late" };
      },
      deadline: DEADLINE,
    });
    const submission = slots.submit({
      operationId: "op-1",
      capability: binding.capability,
      raw: "{}",
      source: SOURCE,
    });
    await validationStarted;
    expire();
    finish();

    await expect(submission).resolves.toMatchObject({
      kind: "rejected",
      code: "expired-capability",
    });
  });

  test("a persistence failure leaves the slot open for a later valid submission", async () => {
    let fail = true;
    const persistence: TestPersistence = {
      writeCall,
      recordAttempt,
      async writeAcceptedExclusive(...args) {
        if (fail) throw new Error("disk unavailable");
        return writeAcceptedExclusive(...args);
      },
    };
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({
      runDir,
      now: () => NOW,
      generateCapability: () => "capability-op-1",
      persistence,
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "review",
      deadline: DEADLINE,
    });
    const input = {
      operationId: "op-1",
      capability: binding.capability,
      raw: "{}",
      source: SOURCE,
    };

    await expect(slots.submit(input)).rejects.toThrow("disk unavailable");
    fail = false;
    await expect(slots.submit(input)).resolves.toMatchObject({ kind: "accepted" });
    expect((await readAttempts(runDir, "op-1")).filter((attempt) => attempt.accepted)).toHaveLength(1);
  });

  test("attempt-log failure after atomic settlement cannot turn acceptance into rejection", async () => {
    const persistence: TestPersistence = {
      writeCall,
      async recordAttempt() {
        throw new Error("attempt log unavailable");
      },
      writeAcceptedExclusive,
    };
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({
      runDir,
      now: () => NOW,
      generateCapability: () => "capability-op-1",
      persistence,
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "review",
      deadline: DEADLINE,
    });

    const outcome = await slots.submit({
      operationId: "op-1",
      capability: binding.capability,
      raw: "{}",
      source: SOURCE,
    });

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
    const persistence: TestPersistence = {
      writeCall,
      async recordAttempt(...args) {
        await gate;
        return recordAttempt(...args);
      },
      writeAcceptedExclusive,
    };
    const slots = createResultSlotRegistry({
      runDir: tempRunDir(),
      now: () => NOW,
      generateCapability: () => "capability-op-1",
      persistence,
    });
    const binding = await slots.open({
      operationId: "op-1",
      question: "review",
      deadline: DEADLINE,
    });
    let settled = false;
    void binding.settled.then(() => {
      settled = true;
    });

    const submission = slots.submit({
      operationId: "op-1",
      capability: binding.capability,
      raw: "{}",
      source: SOURCE,
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);

    release();
    await expect(submission).resolves.toEqual({ kind: "accepted", value: {}, attemptRecorded: true });
    await expect(binding.settled).resolves.toEqual({
      kind: "accepted",
      value: {},
      attemptRecorded: true,
    });
  });
});

async function readAllFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...(await readAllFiles(path)));
    else contents.push(await Bun.file(path).text());
  }
  return contents;
}
