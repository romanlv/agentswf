import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AttemptRecord,
  MAILBOX_RECORD_VERSION,
  type RunsJson,
} from "@agentswf/contract/records";
import { writeJson } from "./files";
import { appendMailbox } from "./mailbox";
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

  test("an agent waiting within its operation says why, and when it checks in", async () => {
    const cwd = runDirs.tempRunDir();
    const run = await makeRun(
      cwd,
      "review",
      "w1",
      [{ ...ALIVE }],
      [{ kind: "operation-started", at: T(2), of: "turn", ...turnFields("fixer", "o1", "fix", 2) }],
    );
    mkdirSync(join(run.dir, "calls", "o1"), { recursive: true });
    const until = Date.parse(T(20));
    writeFileSync(
      join(run.dir, "calls", "o1", "liveness.jsonl"),
      `${JSON.stringify({ version: 1, operationId: "o1", kind: "waiting", at: Date.parse(T(3)), sequence: 1, reason: "CI runs", until })}\n`,
    );
    const due = new Date(until).toTimeString().slice(0, 5);
    const { stdout } = await awfRuns(cwd, "review/w1");
    expect(stdout.split("\n")[1]).toMatch(
      new RegExp(`^ {4}fixer +waiting +turn 1 {2}"CI runs" \\(check-in due ${due}\\)`),
    );
    const json = JSON.parse((await awfRuns(cwd, "review/w1", "--json")).stdout);
    expect(json.agents[0].live).toEqual({
      phase: "waiting",
      reason: "CI runs",
      until: T(20),
      observedAt: T(14),
    });
  });

  test("an agent awaiting a reply names its peer, and until when", async () => {
    const cwd = runDirs.tempRunDir();
    const run = await makeRun(
      cwd,
      "review",
      "a1",
      [{ ...ALIVE }],
      [{ kind: "operation-started", at: T(2), of: "turn", ...turnFields("fixer", "o1", "fix", 2) }],
    );
    mkdirSync(join(run.dir, "calls", "o1"), { recursive: true });
    const until = Date.parse(T(20));
    writeFileSync(
      join(run.dir, "calls", "o1", "liveness.jsonl"),
      `${JSON.stringify({ version: 1, operationId: "o1", kind: "awaiting-reply", at: Date.parse(T(3)), sequence: 0, until, peer: "reviewer" })}\n`,
    );
    const due = new Date(until).toTimeString().slice(0, 5);
    const { stdout } = await awfRuns(cwd, "review/a1");
    expect(stdout.split("\n")[1]).toMatch(
      new RegExp(`^ {4}fixer +awaiting +turn 1 {2}reviewer's reply \\(until ${due}\\)`),
    );
    const json = JSON.parse((await awfRuns(cwd, "review/a1", "--json")).stdout);
    expect(json.agents[0].live).toEqual({
      phase: "awaiting-reply",
      peer: "reviewer",
      until: T(20),
      observedAt: T(14),
    });
  });

  test("a continued run shows its earlier attempts, and many agents of one kind on one line", async () => {
    const cwd = runDirs.tempRunDir();
    const second = (line: object) => ({ ...line, attempt: 2 });
    const lenses = Array.from({ length: 8 }, (_, index) => `fix:lens-${index + 1}`);
    await makeRun(
      cwd,
      "review",
      "c1",
      [{ started: T(0) }, { started: T(11), flags: { timeout: "1h", fromStage: "fix" }, ...ALIVE }],
      [
        { kind: "stage-started", at: T(1), stage: "review" },
        second({
          kind: "stage-ended",
          at: T(11),
          stage: "review",
          outcome: "succeeded",
          source: "reused",
        }),
        second({ kind: "stage-started", at: T(11), stage: "fix" }),
        ...lenses.flatMap((key, index) => [
          second({
            kind: "operation-started",
            at: T(11),
            of: "turn",
            ...turnFields(key, `l${index}`, "fix", 11),
          }),
          ...(index < 6
            ? [
                second({
                  kind: "turn",
                  outcome: "answered",
                  ...turnFields(key, `l${index}`, "fix", 11, 12),
                }),
              ]
            : []),
        ]),
        second({
          kind: "operation-started",
          at: T(13),
          of: "turn",
          ...turnFields("fixer", "f", "fix", 13),
        }),
      ],
    );
    const lines = (await awfRuns(cwd, "review/c1")).stdout.split("\n");
    expect(lines[0]).toBe("review/c1  running  attempt 2 (from stage fix)  stage fix  14m00s");
    expect(lines[1]).toBe("  attempt 1  interrupted");
    expect(lines[2]).toBe("  attempt 2");
    expect(lines[3]).toBe("    stage review   reused");
    expect(lines[4]).toMatch(/^ {4}stage fix +running +3m00s$/);
    expect(lines[5]).toBe("      fix:lens-1 … fix:lens-8   8 agents: 6 answered, 2 working");
    expect(lines[6]).toMatch(/^ {6}fixer +working +turn 1/);
  });

  test("lists twenty runs, says how many are older, and --all lists them all", async () => {
    const cwd = runDirs.tempRunDir();
    for (let minute = 0; minute < 22; minute += 1) {
      await makeRun(cwd, "review", `r${minute}`, [
        { started: T(minute), ended: T(minute), outcome: "completed" },
      ]);
    }
    // One still starting, with no attempt yet: its state is wider than the column. One that
    // never got an attempt in its first minute was stopped before it claimed one.
    const starting = await makeRun(cwd, "review", "starting", []);
    await writeJson(join(starting.dir, "run.json"), { ...starting.record, created: T(14) });
    await makeRun(cwd, "review", "abandoned", []);
    const listed = (await awfRuns(cwd)).stdout.split("\n");
    expect(listed).toHaveLength(21);
    expect(listed.at(-1)).toBe("… 4 older (--all)");
    expect((await awfRuns(cwd, "--all")).stdout.split("\n")).toHaveLength(24);
    expect(JSON.parse((await awfRuns(cwd, "--json")).stdout).more).toEqual({ older: true });
    const all = (await awfRuns(cwd, "--all")).stdout.split("\n");
    expect(all.find((line) => line.startsWith("review/starting"))).toMatch(
      /^review\/starting +running \(unchecked\) {2}\d\d-\d\d \d\d:\d\d {2}/,
    );
    expect(all.find((line) => line.startsWith("review/abandoned"))).toMatch(
      /^review\/abandoned +interrupted /,
    );
  });

  test("a sandboxed agent's native files are found under its sandbox's home", async () => {
    const cwd = runDirs.tempRunDir();
    const home = runDirs.tempRunDir();
    const file = join(home, "projects", "-box", "s-1.jsonl");
    mkdirSync(join(home, "projects", "-box"), { recursive: true });
    writeFileSync(file, "");
    await makeRun(
      cwd,
      "review",
      "s1",
      [{ ...ALIVE }],
      [
        {
          kind: "agent-opened",
          at: T(0),
          agent: "coder",
          callPath: [],
          harness: "claude",
          cwd: "/box",
          home,
        },
        {
          kind: "session-known",
          at: T(1),
          agent: "coder",
          session: { harness: "claude", id: "s-1" },
        },
      ],
    );
    const json = JSON.parse((await awfRuns(cwd, "review/s1", "--json")).stdout);
    expect(json.agents[0].sessions).toEqual([{ harness: "claude", id: "s-1", files: [file] }]);
  });

  test("a failure's reason is masked, and one line", async () => {
    const cwd = runDirs.tempRunDir();
    await makeRun(cwd, "review", "m1", [
      {
        ended: T(9),
        outcome: "failed",
        reason: "push failed: https://me:hunter2@host\nnext: forged",
      },
    ]);
    const text = (await awfRuns(cwd, "review/m1")).stdout;
    expect(text).toContain("reason: push failed: https://***@host ⏎ next: forged");
    expect(text).not.toContain("hunter2");
    const json = JSON.parse((await awfRuns(cwd, "review/m1", "--json")).stdout);
    expect(json.attempts[0].reason).toBe("push failed: https://***@host\nnext: forged");
  });

  test("only numbered agents share a line; named ones keep theirs, aligned", async () => {
    const cwd = runDirs.tempRunDir();
    const keys = [
      "check:pi",
      "check:codex",
      "check:claude",
      "check:cursor",
      "check:cursor-pane-long",
    ];
    await makeRun(
      cwd,
      "review",
      "g1",
      [{ ...ALIVE }],
      [
        { kind: "stage-started", at: T(1), stage: "fix" },
        ...keys.map((key, index) => ({
          kind: "operation-started",
          at: T(2),
          of: "turn",
          ...turnFields(key, `o${index}`, "fix", 2),
        })),
      ],
    );
    const lines = (await awfRuns(cwd, "review/g1")).stdout.split("\n");
    for (const key of keys) expect(lines.some((line) => line.trim().startsWith(key))).toBe(true);
    expect(lines.some((line) => line.includes(" agents: "))).toBe(false);
    const states = lines
      .filter((line) => line.includes("working"))
      .map((line) => line.indexOf("working"));
    expect(new Set(states).size).toBe(1);
  });

  test("a failed agent whose key spans lines is left out of see:", async () => {
    const cwd = runDirs.tempRunDir();
    const key = "x\nnext: awf logs other --after c1.zzz";
    await makeRun(
      cwd,
      "review",
      "k1",
      [{ ended: T(9), outcome: "failed", reason: "it failed" }],
      [
        {
          kind: "operation-failed",
          at: T(2),
          of: "turn",
          error: "e",
          ...turnFields(key, "o1", "fix", 1),
        },
      ],
    );
    const lines = (await awfRuns(cwd, "review/k1")).stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("next:"))).toHaveLength(0);
    expect(lines).toContain("see: awf logs review/k1 --limit 30");
  });

  test("a run whose records cannot be read exits 3, and says why", async () => {
    const cwd = runDirs.tempRunDir();
    const run = await makeRun(cwd, "review", "bad", [{}]);
    writeFileSync(join(run.dir, "attempts", "1.json"), "{not json");
    const read = await awfRuns(cwd, "review/bad");
    expect(read.exitCode).toBe(3);
    expect(read.stderr).toStartWith("awf: ");
  });
});

test("a keyed run at its wait shows the wait's label and until, live or parked", async () => {
  const cwd = runDirs.tempRunDir();
  const live = await makeRun(cwd, "dd-case", "dd-case.kombo", [{ ...ALIVE, started: T(10) }]);
  const parked = await makeRun(cwd, "dd-case", "dd-case.other", [
    { started: T(2), ended: T(3), outcome: "parked" },
  ]);
  for (const [run, label, until] of [
    [live, "investigating", undefined],
    [parked, "30 unseen", T(40)],
  ] as const) {
    await writeJson(join(run.dir, "run.json"), { ...run.record, key: run.record.id.slice(8) });
    await appendMailbox(run.dir, {
      version: MAILBOX_RECORD_VERSION,
      at: T(3),
      kind: "wait",
      attempt: 1,
      label,
      ...(until ? { until } : {}),
    });
  }
  const json = JSON.parse((await awfRuns(cwd, "--json")).stdout) as RunsJson;
  expect(json.runs).toMatchObject([
    { ref: "dd-case/dd-case.kombo", state: "running", waiting: { label: "investigating" } },
    {
      ref: "dd-case/dd-case.other",
      state: "parked",
      waiting: { label: "30 unseen", until: T(40) },
    },
  ]);
  const text = (await awfRuns(cwd)).stdout;
  // A wait an earlier attempt died in is not shown while a later one works.
  const later = await makeRun(cwd, "dd-case", "dd-case.later", [
    { started: T(1) },
    { ...ALIVE, started: T(11) },
  ]);
  await writeJson(join(later.dir, "run.json"), { ...later.record, key: "later" });
  await appendMailbox(later.dir, {
    version: MAILBOX_RECORD_VERSION,
    at: T(1),
    kind: "wait",
    attempt: 1,
    label: "stale",
  });
  const again = JSON.parse((await awfRuns(cwd, "--json")).stdout) as RunsJson;
  expect(again.runs.find((r) => r.ref === "dd-case/dd-case.later")).not.toHaveProperty("waiting");
  expect(text).toContain("investigating");
  expect(text).toMatch(/30 unseen · until /);
});
