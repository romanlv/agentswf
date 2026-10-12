import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptRecord } from "@agentswf/contract/records";
import { writeJson } from "./files";
import {
  decodeCursor,
  decodeHandle,
  encodeCursor,
  encodeHandle,
  readRun,
  readRunLog,
} from "./run-read";
import { findRun, RunNotFound, runStatus } from "./run-state";
import { attemptRefusal, createRun, isLive, type Run } from "./runs";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const STARTED = "2026-10-11T09:00:00Z";

async function run(root: string, workflow: string, id: string, created?: string): Promise<Run> {
  const made = await createRun(root, { id, workflow, argv: [], cwd: "/repo", sandbox: null });
  if (created) {
    made.record = { ...made.record, created };
    await writeJson(join(made.dir, "run.json"), made.record);
  }
  return made;
}

async function attempt(made: Run, fields: Partial<AttemptRecord> = {}): Promise<void> {
  const record: AttemptRecord = {
    version: 1,
    attempt: 1,
    file: "flow.ts",
    flags: { timeout: "1h" },
    pid: 4242,
    processStart: STARTED,
    started: STARTED,
    ...fields,
  };
  mkdirSync(join(made.dir, "attempts"), { recursive: true });
  await writeJson(join(made.dir, "attempts", `${record.attempt}.json`), record);
}

describe("a run's state", () => {
  test("is read from its attempts and its process, as a continue reads it", async () => {
    const root = runDirs.tempRunDir();
    const cases = [
      { ended: { outcome: "completed" as const, ended: STARTED }, ps: STARTED, state: "completed" },
      { ended: {}, ps: STARTED, state: "running" },
      { ended: {}, ps: "2026-10-11T10:00:00Z", state: "interrupted" },
      { ended: {}, ps: "gone", state: "interrupted" },
    ];
    for (const [n, { ended, ps, state }] of cases.entries()) {
      const made = await run(root, "review", `r${n}`);
      await attempt(made, ended);
      const status = await runStatus(made, () => ps);
      expect(status).toMatchObject({ state, checked: true, ref: `review/r${n}` });
      // `--continue` refuses a live attempt: the same one this calls running.
      const probe = () => (ps === "gone" ? undefined : ps);
      expect(isLive(status.attempts[0]!, probe)).toBe(state === "running");
      expect(attemptRefusal(status.attempts, new Map(), { fromStage: false, probe })?.kind).toBe(
        state === "running" ? "running" : state === "completed" ? "completed" : undefined,
      );
    }
  });

  test("a process that cannot be asked about is running, unchecked", async () => {
    const made = await run(runDirs.tempRunDir(), "review", "r1");
    await attempt(made);
    expect(await runStatus(made, () => "unknown")).toMatchObject({
      state: "running",
      checked: false,
    });
  });
});

describe("a run reference", () => {
  test("names a run by workflow and id, or by an id only one workflow has; none names the newest", async () => {
    const root = runDirs.tempRunDir();
    for (const [workflow, id, created] of [
      ["review", "a", "2026-10-11T09:00:00.000Z"],
      ["triage", "a", "2026-10-11T09:05:00.000Z"],
      ["review", "b", "2026-10-11T09:10:00.000Z"],
      ["review", "c", "2026-10-11T09:20:00.000Z"],
    ] as const) {
      await attempt(await run(root, workflow, id, created));
    }
    const alive = () => STARTED;
    expect((await findRun(root, "triage/a", alive)).status.ref).toBe("triage/a");
    expect((await findRun(root, "b", alive)).status.ref).toBe("review/b");
    await expect(findRun(root, "a", alive)).rejects.toThrow(
      "a names a run of more than one workflow: triage/a, review/a",
    );
    await expect(findRun(root, "zzz", alive)).rejects.toBeInstanceOf(RunNotFound);
    await expect(findRun(root, "review/zzz", alive)).rejects.toBeInstanceOf(RunNotFound);
    const newest = await findRun(root, undefined, alive);
    expect(newest.status.ref).toBe("review/c");
    expect(newest.alsoRunning).toEqual(["review/b", "triage/a", "review/a"]);
    await expect(findRun(runDirs.tempRunDir(), undefined, alive)).rejects.toBeInstanceOf(
      RunNotFound,
    );
  });
});

describe("cursors and handles", () => {
  test("round-trip, and anything else is refused", () => {
    const cursor = { log: 12, files: { a1: 4096, "a2-9b2e00aa11cc": 17 } };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    for (const bad of ["c1.zzz", "c2.e30", "", encodeCursor({ log: -1, files: {} })]) {
      expect(decodeCursor(bad)).toBeUndefined();
    }
    for (const handle of [
      { kind: "event" as const, line: 216 },
      { kind: "activity" as const, file: "a3", offset: 0x1f4c, index: 0 },
      { kind: "activity" as const, file: "a3-9b2e00aa11cc", offset: 7, index: 2 },
    ]) {
      expect(decodeHandle(encodeHandle(handle))).toEqual(handle);
      expect(decodeHandle(`@${encodeHandle(handle)}`)).toEqual(handle);
    }
    expect(encodeHandle({ kind: "activity", file: "a3", offset: 0x1f4c, index: 0 })).toBe(
      "a3.1f4c",
    );
    for (const bad of ["e0", "a.1", "a3", "x1", "a3.zz"]) expect(decodeHandle(bad)).toBeUndefined();
  });
});

describe("reading a run", () => {
  const event = (fields: object) => JSON.stringify({ version: 1, attempt: 1, ...fields });
  const op = (agent: string, id: string, deliveredAt: string, session: string) =>
    event({
      kind: "operation-started",
      at: deliveredAt,
      of: "turn",
      callPath: [],
      agent,
      operationId: id,
      execution: { harness: "claude", model: "m" },
      deliveredAt,
      sessions: [{ harness: "claude", id: session }],
    });
  const turn = (
    agent: string,
    id: string,
    deliveredAt: string,
    settledAt: string,
    session: string,
  ) =>
    event({
      kind: "turn",
      outcome: "answered",
      callPath: [],
      agent,
      operationId: id,
      execution: { harness: "claude", model: "m" },
      deliveredAt,
      settledAt,
      sessions: [{ harness: "claude", id: session }],
    });
  const said = (at: string, text: string) =>
    `${JSON.stringify({ type: "assistant", timestamp: at, message: { content: [{ type: "text", text }] } })}\n`;
  const T = (minute: number) => `2026-10-11T09:${String(minute).padStart(2, "0")}:00.000Z`;

  async function setUp() {
    const root = runDirs.tempRunDir();
    const made = await run(root, "review", "r1");
    const home = join(root, "claude-home");
    const project = join(home, "projects", "-repo");
    mkdirSync(project, { recursive: true });
    const worker = "11111111-1111-4111-8111-111111111111";
    const caller = "22222222-2222-4222-8222-222222222222";
    // The worker's file: before it was the run's, during its turn, and after its stop.
    writeFileSync(
      join(project, `${worker}.jsonl`),
      said(T(0), "before") + said(T(2), "working") + said(T(9), "after stop"),
    );
    // The calling session's: the operator's own before and after, the run's turn between.
    writeFileSync(
      join(project, `${caller}.jsonl`),
      said(T(0), "operator") + said(T(4), "in the run") + said(T(7), "operator again"),
    );
    const lines = [
      event({
        kind: "agent-opened",
        at: T(1),
        agent: "worker",
        callPath: [],
        harness: "claude",
        cwd: "/repo",
        home,
      }),
      event({
        kind: "agent-opened",
        at: T(1),
        agent: "author",
        callPath: [],
        harness: "claude",
        cwd: "/repo",
        home,
        caller: true,
      }),
      op("worker", "op-1", T(1), worker),
      turn("worker", "op-1", T(1), T(3), worker),
      op("author", "op-2", T(3), caller),
      turn("author", "op-2", T(3), T(5), caller),
      event({ kind: "agent-stopped", at: T(8), agent: "worker", callPath: [], harness: "claude" }),
    ];
    writeFileSync(join(made.dir, "turns.jsonl"), `${lines.join("\n")}\n`);
    return { made, project, worker };
  }

  test("merges the log and the run's own activity by time, each under its operation", async () => {
    const { made } = await setUp();
    const read = await readRun(made.dir, "/repo");
    const shown = read.events.map((each) =>
      each.source === "log"
        ? `${each.handle} ${each.line.kind}`
        : `${each.handle} ${each.agent} ${each.operation} ${each.activity.type}`,
    );
    expect(shown).toEqual([
      "e1 agent-opened",
      "e2 agent-opened",
      "e3 operation-started",
      "a1.74 worker op-1 message",
      "e4 turn",
      "e5 operation-started",
      "a2.76 author op-2 message",
      "e6 turn",
      "e7 agent-stopped",
    ]);
    expect(read.log.sessions.map(({ n, agent }) => [n, agent])).toEqual([
      [1, "worker"],
      [2, "author"],
    ]);
  });

  test("a cursor returns only what is new, never past a torn line", async () => {
    const { made, project, worker } = await setUp();
    const first = await readRun(made.dir, "/repo");
    expect((await readRun(made.dir, "/repo", first.cursor)).events).toEqual([]);
    const file = join(project, `${worker}.jsonl`);
    const line = said(T(8), "late");
    appendFileSync(file, line.slice(0, 30));
    appendFileSync(
      join(made.dir, "turns.jsonl"),
      event({ kind: "log", at: T(8), text: "x" }).slice(0, 10),
    );
    const torn = await readRun(made.dir, "/repo", first.cursor);
    expect(torn.events).toEqual([]);
    expect(torn.cursor).toEqual(first.cursor);
    appendFileSync(file, line.slice(30));
    const next = await readRun(made.dir, "/repo", torn.cursor);
    expect(next.events.map((each) => each.source === "activity" && each.operation)).toEqual([null]);
  });

  test("an attempt that died ends its spans at its last line; a continue opens them again", async () => {
    const root = runDirs.tempRunDir();
    const made = await run(root, "review", "r1");
    const home = join(root, "claude-home");
    const project = join(home, "projects", "-repo");
    mkdirSync(project, { recursive: true });
    const caller = "22222222-2222-4222-8222-222222222222";
    const worker = "11111111-1111-4111-8111-111111111111";
    writeFileSync(
      join(project, `${caller}.jsonl`),
      said(T(3), "in the run") + said(T(9), "operator"),
    );
    writeFileSync(
      join(project, `${worker}.jsonl`),
      said(T(4), "one") + said(T(9), "between") + said(T(11), "two"),
    );
    const again = (fields: object) => JSON.stringify({ version: 1, attempt: 2, ...fields });
    const lines = [
      event({
        kind: "agent-opened",
        at: T(1),
        agent: "author",
        callPath: [],
        harness: "claude",
        cwd: "/repo",
        home,
        caller: true,
      }),
      event({
        kind: "agent-opened",
        at: T(1),
        agent: "worker",
        callPath: [],
        harness: "claude",
        cwd: "/repo",
        home,
      }),
      op("author", "op-1", T(2), caller),
      op("worker", "op-2", T(2), worker),
      // Attempt 1 dies here, mid-turn; attempt 2 opens the worker again later.
      again({ kind: "attempt-started", at: T(10) }),
      again({
        kind: "agent-opened",
        at: T(10),
        agent: "worker",
        callPath: [],
        harness: "claude",
        cwd: "/repo",
        home,
      }),
    ];
    writeFileSync(join(made.dir, "turns.jsonl"), `${lines.join("\n")}\n`);
    const read = await readRun(made.dir, "/repo");
    const activity = read.events.flatMap((each) =>
      each.source === "activity"
        ? [`${each.agent} ${each.operation} ${each.at.slice(14, 16)}`]
        : [],
    );
    // The calling session's turn ends at attempt 1's last line: after it, its file is the operator's.
    expect(activity).toEqual(["worker op-2 04", "worker op-2 09", "worker null 11"]);
  });

  test("a session named late renumbers none named before it", async () => {
    const { made } = await setUp();
    const before = (await readRunLog(made.dir)).sessions;
    appendFileSync(
      join(made.dir, "turns.jsonl"),
      `${event({ kind: "session-known", at: T(6), session: { harness: "codex", id: "thread-9" }, operationId: "op-1" })}\n`,
    );
    const after = (await readRunLog(made.dir)).sessions;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ n: 3, harness: "codex", id: "thread-9", agent: "worker" });
  });
});
