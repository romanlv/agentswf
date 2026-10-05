import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationLivenessRecord } from "@agentswf/contract/records";
import { createOperationEvents, readOperationEvents } from "./operation-events";
import { createTempRunDirs } from "./testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());
const event = (kind: string, sequence = 0, reason?: string) => ({
  kind,
  at: 1000 + sequence,
  sequence,
  ...(reason === undefined ? {} : { reason }),
});

test("persists ordered standalone v1 records and reads a completed diagnostic stream", async () => {
  const runDir = dirs.tempRunDir();
  const events = createOperationEvents(runDir, "operation");
  events.record(event("dispatched"));
  events.record({ ...event("waiting", 1, "Deploy is running"), until: 2000 });
  events.record(event("terminal", 1, "answer saved"));
  await events.close();
  const read = await readOperationEvents(runDir, "operation");
  expect(read.incomplete).toBe(false);
  expect(read.records.map((row) => row.kind)).toEqual(["dispatched", "waiting", "terminal"]);
  expect(read.records[1]).toEqual({
    version: 1,
    operationId: "operation",
    kind: "waiting",
    at: 1001,
    sequence: 1,
    reason: "Deploy is running",
    until: 2000,
  });
});

test("a stalled writer cannot grow its queue and terminal capacity is reserved", async () => {
  const gate = Promise.withResolvers<void>();
  const rows: OperationLivenessRecord[] = [];
  let writing = 0;
  let peak = 0;
  const events = createOperationEvents("unused", "operation", {
    maxQueuedRecords: 3,
    write: async (_path, line) => {
      writing++;
      peak = Math.max(peak, writing);
      await gate.promise;
      rows.push(JSON.parse(line));
      writing--;
    },
  });
  events.record(event("dispatched"));
  for (let i = 0; i < 100; i++) events.record(event("waiting", i));
  events.record(event("terminal", 100));
  gate.resolve();
  await events.close();
  expect(peak).toBe(1);
  expect(rows).toHaveLength(3);
  expect(rows.at(-1)?.kind).toBe("terminal");
  expect(rows.reduce((sum, row) => sum + (row.dropped ?? 0), 0)).toBe(99);
});

test("total record and byte budgets include all attempted writes", async () => {
  const rows: string[] = [];
  const events = createOperationEvents("unused", "operation", {
    maxRecords: 5,
    maxBytes: 8192,
    maxQueuedBytes: 8192,
    write: async (_path, line) => {
      rows.push(line);
    },
  });
  for (let i = 0; i < 100; i++) {
    events.record(event("waiting", i, "😀".repeat(512)));
    await Promise.resolve();
  }
  events.record(event("terminal", 100, "done"));
  await events.close();
  expect(rows.length).toBeLessThanOrEqual(5);
  expect(rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0)).toBeLessThanOrEqual(8192);
  expect(JSON.parse(rows.at(-1)!).kind).toBe("terminal");
  expect(JSON.parse(rows.at(-1)!).dropped).toBeGreaterThan(0);
});

test("failed writes are counted in the next successful diagnostic without throwing", async () => {
  const rows: OperationLivenessRecord[] = [];
  let writes = 0;
  const events = createOperationEvents("unused", "operation", {
    write: async (_path, line) => {
      if (++writes === 1) throw new Error("disk unavailable");
      rows.push(JSON.parse(line));
    },
  });
  events.record(event("dispatched"));
  events.record(event("terminal"));
  await events.close();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.dropped).toBe(1);
});

test("close has one finite flush and does not restart queued writes after timeout", async () => {
  let expire: (() => void) | undefined;
  let cancelled = 0;
  let writes = 0;
  const gate = Promise.withResolvers<void>();
  const events = createOperationEvents("unused", "operation", {
    write: async () => {
      writes++;
      await gate.promise;
    },
    schedule: (ms, callback) => {
      expect(ms).toBe(1000);
      expire = callback;
      return () => {
        cancelled++;
      };
    },
  });
  events.record(event("dispatched"));
  events.record(event("terminal"));
  const closing = events.close();
  expect(events.close()).toBe(closing);
  expire!();
  await closing;
  gate.resolve();
  await Promise.resolve();
  events.record(event("waiting"));
  expect(writes).toBe(1);
  expect(cancelled).toBe(1);
});

test("encoded reason size is bounded without splitting unicode and signals truncation", async () => {
  const rows: OperationLivenessRecord[] = [];
  const events = createOperationEvents("unused", "operation", {
    write: async (_path, line) => {
      expect(Buffer.byteLength(line)).toBeLessThan(4096);
      rows.push(JSON.parse(line));
    },
  });
  events.record(event("waiting", 0, "😀".repeat(1000)));
  events.record(event("terminal", 1, "\u0000".repeat(2048)));
  await events.close();
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.truncated)).toBe(true);
  expect(rows[0]?.reason).toBe("😀".repeat(512));
});

test("reader reports missing, malformed, foreign and truncated diagnostics as incomplete", async () => {
  const runDir = dirs.tempRunDir();
  expect(await readOperationEvents(runDir, "absent")).toEqual({ records: [], incomplete: true });
  const directory = join(runDir, "calls", "operation");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "liveness.jsonl");
  const valid = JSON.stringify({ version: 1, operationId: "operation", ...event("dispatched") });
  await writeFile(path, `${valid}\nnot-json\n{"version":`);
  let read = await readOperationEvents(runDir, "operation");
  expect(read.records).toHaveLength(1);
  expect(read.incomplete).toBe(true);
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, operationId: "other", ...event("terminal") })}\n`,
  );
  read = await readOperationEvents(runDir, "operation");
  expect(read).toEqual({ records: [], incomplete: true });
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, operationId: "operation", ...event("terminal"), dropped: 1 })}\n`,
  );
  expect((await readOperationEvents(runDir, "operation")).incomplete).toBe(true);
});

test("the total event cap holds even when the writer drains between records", async () => {
  const rows: OperationLivenessRecord[] = [];
  const events = createOperationEvents("unused", "operation", {
    maxRecords: 4,
    write: async (_path, line) => {
      rows.push(JSON.parse(line));
    },
  });
  for (let i = 0; i < 20; i++) {
    events.record(event("waiting", i));
    await Promise.resolve();
  }
  events.record(event("terminal", 20));
  await events.close();
  expect(rows).toHaveLength(4);
  expect(rows.at(-1)).toMatchObject({ kind: "terminal", dropped: 17 });
});
