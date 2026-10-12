import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptRecord } from "@agentswf/contract/records";
import { writeJson } from "./files";
import { createRun, processStart, type Run } from "./runs";
import { runsCommand } from "./runs-command";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const T = (minute: number) => `2026-10-11T09:${String(minute).padStart(2, "0")}:00.000Z`;
const ALIVE = { pid: process.pid, processStart: processStart(process.pid)! };
// A process that has exited: `ps` knows nothing of it.
const GONE = { pid: Bun.spawnSync(["true"]).pid, processStart: "2026-10-11T09:00:00Z" };

async function makeRun(
  cwd: string,
  workflow: string,
  id: string,
  attempts: Partial<AttemptRecord>[],
  lines: object[] = [],
): Promise<Run> {
  const run = await createRun(join(cwd, ".awf", "runs"), {
    id,
    workflow,
    argv: [],
    cwd,
    sandbox: null,
  });
  run.record = { ...run.record, created: attempts[0]?.started ?? T(0) };
  await writeJson(join(run.dir, "run.json"), run.record);
  mkdirSync(join(run.dir, "attempts"), { recursive: true });
  for (const [index, fields] of attempts.entries()) {
    await writeJson(join(run.dir, "attempts", `${index + 1}.json`), {
      version: 1,
      attempt: index + 1,
      file: join(cwd, "review.ts"),
      flags: { timeout: "1h" },
      ...GONE,
      started: T(0),
      ...fields,
    });
  }
  writeFileSync(
    join(run.dir, "turns.jsonl"),
    lines.map((line) => `${JSON.stringify({ version: 1, attempt: 1, ...line })}\n`).join(""),
  );
  return run;
}

async function awfRuns(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runsCommand(
    argv,
    cwd,
    { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    Date.parse(T(14)),
  );
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") };
}

const turnFields = (agent: string, id: string, stage: string, from: number, to?: number) => ({
  agent,
  operationId: id,
  execution: { harness: "codex", model: "m" },
  stage,
  deliveredAt: T(from),
  ...(to === undefined ? {} : { settledAt: T(to) }),
  sessions: [],
  callPath: [],
});

describe("awf runs", () => {
  test("one running run: its stages, each agent's state, and what to run next", async () => {
    const cwd = runDirs.tempRunDir();
    await makeRun(
      cwd,
      "review",
      "r1",
      [{ ...ALIVE }],
      [
        { kind: "stage-started", at: T(0), stage: "review" },
        {
          kind: "operation-started",
          at: T(0),
          of: "turn",
          ...turnFields("review:codex", "o1", "review", 0),
        },
        { kind: "turn", outcome: "answered", ...turnFields("review:codex", "o1", "review", 0, 6) },
        { kind: "stage-ended", at: T(6), stage: "review", outcome: "succeeded" },
        { kind: "stage-started", at: T(7), stage: "fix" },
        {
          kind: "operation-started",
          at: T(12),
          of: "turn",
          ...turnFields("fixer", "o2", "fix", 12),
        },
        {
          kind: "decision-asked",
          at: T(13),
          decision: 1,
          key: "merge?",
          alias: "jev",
          provider: "p",
          model: "m",
          stage: "fix",
        },
      ],
    );
    const { exitCode, stdout } = await awfRuns(cwd, "review/r1");
    expect(exitCode).toBe(0);
    const lines = stdout.split("\n");
    expect(lines[0]).toBe("review/r1  running  stage fix  14m00s");
    expect(lines).toContain("  stage review   succeeded  6m00s");
    expect(lines.some((line) => /^ {4}review:codex +answered +1 turn$/.test(line))).toBe(true);
    expect(lines.some((line) => /^ {4}fixer +working +turn 1 +2m00s$/.test(line))).toBe(true);
    expect(lines).toContain(
      '    decision "merge?"  asked 09:13, open'.replace(
        "09:13",
        new Date(T(13)).toTimeString().slice(0, 5),
      ),
    );
    expect(lines.at(-1)).toMatch(/^next: awf logs review\/r1 --after c1\.\S+ --wait 90$/);
  });

  test("a failed run says why, where its records are, and where to look", async () => {
    const cwd = runDirs.tempRunDir();
    await makeRun(
      cwd,
      "implement-ticket",
      "r2",
      [
        {
          ended: T(9),
          outcome: "failed",
          stage: "review",
          reason: "turn deadline exceeded (worker, turn 6)",
        },
      ],
      [
        {
          kind: "operation-started",
          at: T(1),
          of: "turn",
          ...turnFields("worker", "o1", "review", 1),
        },
        { kind: "turn", outcome: "timed-out", ...turnFields("worker", "o1", "review", 1, 8) },
      ],
    );
    const { stdout } = await awfRuns(cwd, "r2");
    const lines = stdout.split("\n");
    expect(lines[0]).toBe("implement-ticket/r2  failed  stage review  9m00s");
    expect(lines).toContain("reason: turn deadline exceeded (worker, turn 6)");
    expect(
      lines.some(
        (line) => line.startsWith("records: ") && line.endsWith("(report.md, output.json)"),
      ),
    ).toBe(true);
    expect(lines.at(-2)).toBe("see: awf logs implement-ticket/r2 --agent worker --limit 30");
    expect(lines.at(-1)).toBe("continue: awf run review.ts --continue r2");
  });

  test("a run whose process is gone is interrupted, and says how to go on", async () => {
    const cwd = runDirs.tempRunDir();
    await makeRun(
      cwd,
      "review",
      "r3",
      [{}],
      [
        { kind: "stage-started", at: T(1), stage: "fix" },
        { kind: "operation-started", at: T(2), of: "turn", ...turnFields("fixer", "o1", "fix", 2) },
      ],
    );
    const { stdout } = await awfRuns(cwd, "review/r3");
    const lines = stdout.split("\n");
    expect(lines[0]).toMatch(
      /^review\/r3 {2}interrupted {2}stage fix {2}last event \d\d:\d\d:\d\d$/,
    );
    expect(lines.some((line) => /fixer +was working +turn 1/.test(line))).toBe(true);
    expect(lines.at(-1)).toBe("continue: awf run review.ts --continue r3");
  });

  test("--json keeps durable fields apart from best-effort ones, and names next", async () => {
    const cwd = runDirs.tempRunDir();
    await makeRun(
      cwd,
      "review",
      "r4",
      [{ ...ALIVE }],
      [
        { kind: "agent-opened", at: T(0), agent: "fixer", callPath: [], harness: "codex", cwd },
        { kind: "operation-started", at: T(1), of: "turn", ...turnFields("fixer", "o1", "fix", 1) },
      ],
    );
    const json = JSON.parse((await awfRuns(cwd, "review/r4", "--json")).stdout);
    expect(json).toMatchObject({
      v: 1,
      run: { ref: "review/r4", state: "running", checked: true },
      agents: [
        {
          key: "fixer",
          harness: "codex",
          state: "working",
          turns: 0,
          sessions: [],
          live: { observedAt: T(14) },
        },
      ],
    });
    expect(json.next.slice(0, 4)).toEqual(["awf", "logs", "review/r4", "--after"]);
  });

  test("lists the runs here, newest first, and says when there are none or no such run", async () => {
    const cwd = runDirs.tempRunDir();
    expect(await awfRuns(cwd)).toMatchObject({
      exitCode: 0,
      stdout: `no runs under ${join(cwd, ".awf", "runs")}; started elsewhere? awf runs --cwd {dir}`,
    });
    await makeRun(cwd, "review", "old", [
      {
        started: T(0),
        ended: T(5),
        outcome: "completed",
        accounting: { totals: { estimate: 6.1 } } as never,
      },
    ]);
    await makeRun(cwd, "review", "new", [{ started: T(10), ...ALIVE }]);
    const listed = (await awfRuns(cwd)).stdout.split("\n");
    expect(listed[0]).toMatch(/^review\/new {2}running {6}\d\d-\d\d \d\d:\d\d {2}\S+/);
    expect(listed[1]).toMatch(
      /^review\/old {2}completed {4}\d\d-\d\d \d\d:\d\d {2}5m00s {3}\$6\.10$/,
    );
    const missing = await awfRuns(cwd, "nope");
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toBe(
      `no run nope under ${join(cwd, ".awf", "runs")}; runs here: awf runs`,
    );
    expect((await awfRuns(cwd, "--bogus")).exitCode).toBe(2);
  });
});
