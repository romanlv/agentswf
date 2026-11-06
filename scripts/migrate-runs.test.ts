import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRun } from "../packages/contract/src/run-lines";
import { readAttemptFiles } from "../packages/engine/src/runs";
import { readWaits } from "../packages/engine/src/waits";
import { migrateRuns } from "./migrate-runs";

const root = mkdtempSync(join(tmpdir(), "awf-migrate-"));
afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(root, { recursive: true, force: true });
});

const T = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const jsonl = (lines: object[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
const TIMER = "awf.timer.0123456789abcdef";
const END = "awf.end.0123456789abcdef";

/** An event run as awf wrote it before run.json had a format: started, a timer taken, a turn ended, parked. */
async function oldRun(): Promise<string> {
  const dir = join(root, ".awf", "runs", "review", "7");
  await mkdir(join(dir, "attempts"), { recursive: true });
  await mkdir(join(dir, "stages"), { recursive: true });
  await mkdir(join(dir, "agents"), { recursive: true });
  const run = { version: 1, id: "7", workflow: "review", argv: [], cwd: root, sandbox: null };
  await writeFile(join(dir, "run.json"), JSON.stringify({ ...run, events: true, created: T(0) }));
  const attempt = {
    version: 1,
    attempt: 1,
    file: "/w/flow.ts",
    flags: {},
    pid: 1,
    processStart: T(0),
  };
  await writeFile(
    join(dir, "attempts", "1.json"),
    JSON.stringify({
      ...attempt,
      started: T(0),
      ended: T(9),
      outcome: "parked",
      stages: [],
      accounting: {},
      unacknowledged: 0,
    }),
  );
  const execution = { harness: "claude", model: "", effort: "default" };
  const end = { turn: "t1", meta: null, outcome: { kind: "answered", value: "ok" } };
  await writeFile(
    join(dir, "mailbox.jsonl"),
    jsonl([
      {
        version: 1,
        kind: "event",
        id: "e1",
        name: "pr.opened",
        data: {},
        from: "operator",
        at: T(0),
        starts: true,
      },
      { version: 1, at: T(1), kind: "wait", attempt: 1, label: "starting" },
      { version: 1, at: T(1), kind: "took", attempt: 1, ids: ["e1"] },
      { version: 1, at: T(2), kind: "timer", attempt: 1, name: "nudge", due: T(3), when: "1m" },
      {
        version: 1,
        at: T(2),
        kind: "turn",
        attempt: 1,
        agent: "reviewer",
        turn: "t1",
        meta: null,
        execution,
      },
      { version: 1, at: T(2), kind: "wait", attempt: 1, label: "reviewing" },
      {
        version: 1,
        kind: "event",
        id: TIMER,
        name: "timer:due",
        data: { name: "nudge" },
        from: "nudge",
        at: T(3),
      },
      { version: 1, at: T(3), kind: "took", attempt: 1, ids: [TIMER] },
      { version: 1, at: T(4), kind: "wait", attempt: 1, label: "reviewing" },
      {
        version: 1,
        kind: "event",
        id: END,
        name: "agent:ended",
        data: end,
        from: "reviewer",
        at: T(5),
      },
      { version: 1, at: T(5), kind: "took", attempt: 1, ids: [END] },
      { version: 1, at: T(8), kind: "wait", attempt: 1, label: "parked" },
    ]),
  );
  await writeFile(
    join(dir, "stages", "triage.json"),
    JSON.stringify({
      version: 1,
      stage: "triage",
      attempt: 1,
      outcome: "succeeded",
      started: T(6),
      ended: T(7),
      sessions: [],
      value: { severity: "low" },
    }),
  );
  await writeFile(
    join(dir, "turns.jsonl"),
    jsonl([
      {
        version: 1,
        attempt: 1,
        kind: "turn",
        outcome: "answered",
        agent: "reviewer",
        operationId: "op-1",
        settledAt: T(5),
        sessions: [{ harness: "claude", id: "s-1" }],
      },
    ]),
  );
  await writeFile(
    join(dir, "output.json"),
    JSON.stringify({ version: 5, runId: "7", attempt: 1, outcome: "parked", label: "parked" }),
  );
  return dir;
}

test("an old event run reads as format 1: its events, waits, stages, sessions and attempt", async () => {
  const dir = await oldRun();
  expect(await migrateRuns([root])).toBe(0);

  const record = JSON.parse(await readFile(join(dir, "run.json"), "utf8"));
  expect(record.format).toBe(1);
  expect(record.version).toBeUndefined();

  // Only what senders sent is in in.jsonl; the derived ones are run.jsonl's.
  const events = (await readFile(join(dir, "in.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(events).toEqual([
    { id: "e1", name: "pr.opened", data: {}, from: "operator", at: T(0), starts: true },
  ]);

  const lines = (await readFile(join(dir, "run.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const view = readRun(lines);
  expect(lines[0]).toEqual({ kind: "claimed", attempt: 1, at: T(0) });
  expect(view.stages.triage?.settled?.value).toEqual({ severity: "low" });
  expect(view.sessions.latest.reviewer?.session).toBe("s-1");
  expect(view.timers.nudge?.taken).toBe(true);
  expect(lines.find((l) => l.kind === "turn-ended")).toMatchObject({
    id: END,
    agent: "reviewer",
    began: 1,
  });

  // Every batch was acknowledged by the wait after it, as the mailbox had it.
  const waits = await readWaits(dir, Date.parse(T(30)));
  expect(waits.unacknowledged).toEqual([]);
  expect(waits.held).toBeUndefined();
  expect(waits.lastWait).toMatchObject({ label: "parked", waiting: true });

  const [attempt] = await readAttemptFiles({ dir });
  expect(attempt).toMatchObject({ attempt: 1, kind: "attempt", outcome: "parked" });
  expect(attempt).not.toHaveProperty("stages");

  expect(existsSync(join(dir, "out.json"))).toBe(true);
  expect(existsSync(join(dir, "log.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "work", "agents"))).toBe(true);
  for (const kept of ["run.json", "mailbox.jsonl", "stages", "attempts/1.json", "output.json"]) {
    expect(existsSync(join(dir, "pre-format", kept))).toBe(true);
  }
  expect(existsSync(join(dir, "mailbox.jsonl"))).toBe(false);

  // A second pass finds nothing left to do.
  expect(await migrateRuns([root])).toBe(0);
});
