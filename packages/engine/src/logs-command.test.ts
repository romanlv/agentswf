import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptRecord } from "@agentswf/contract/records";
import { writeJson } from "./files";
import { type LogsClock, logsCommand } from "./logs-command";
import { createRun, processStart, type Run } from "./runs";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const T = (minute: number, second = 0) =>
  `2026-10-11T09:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const ALIVE = { pid: process.pid, processStart: processStart(process.pid)! };
const WORKER = "11111111-1111-4111-8111-111111111111";

type Fixture = { cwd: string; run: Run; log: string; native: string };

async function fixture(attempt: Partial<AttemptRecord> = ALIVE): Promise<Fixture> {
  const cwd = runDirs.tempRunDir();
  const run = await createRun(join(cwd, ".awf", "runs"), {
    id: "r1",
    workflow: "review",
    argv: [],
    cwd,
    sandbox: null,
  });
  mkdirSync(join(run.dir, "attempts"), { recursive: true });
  await writeJson(join(run.dir, "attempts", "1.json"), {
    version: 1,
    attempt: 1,
    file: join(cwd, "review.ts"),
    flags: { timeout: "1h" },
    started: T(0),
    ...attempt,
  });
  const home = join(cwd, "claude-home");
  const project = join(home, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const native = join(project, `${WORKER}.jsonl`);
  writeFileSync(native, "");
  const log = join(run.dir, "turns.jsonl");
  writeFileSync(log, "");
  addLines(
    { log } as Fixture,
    { kind: "stage-started", at: T(0), stage: "fix" },
    { kind: "agent-opened", at: T(0), agent: "fixer", callPath: [], harness: "claude", cwd, home },
    {
      kind: "operation-started",
      at: T(1),
      of: "turn",
      callPath: [],
      agent: "fixer",
      operationId: "op-1",
      execution: { harness: "claude", model: "m" },
      stage: "fix",
      deliveredAt: T(1),
      sessions: [{ harness: "claude", id: WORKER }],
    },
  );
  return { cwd, run, log, native };
}

function addLines(fixture: Pick<Fixture, "log">, ...lines: object[]) {
  appendFileSync(
    fixture.log,
    lines.map((line) => `${JSON.stringify({ version: 1, attempt: 1, ...line })}\n`).join(""),
  );
}

function addActivity(fixture: Fixture, at: string, content: object[]) {
  appendFileSync(
    fixture.native,
    `${JSON.stringify({ type: "assistant", timestamp: at, message: { content } })}\n`,
  );
}

const turnEnded = (minute: number) => ({
  kind: "turn",
  outcome: "answered",
  callPath: [],
  agent: "fixer",
  operationId: "op-1",
  execution: { harness: "claude", model: "m" },
  stage: "fix",
  deliveredAt: T(1),
  settledAt: T(minute),
  sessions: [{ harness: "claude", id: WORKER }],
});

/** A clock the waits move, and a hook to change the run as they do. */
function fakeClock(onSleep: (now: number) => void = () => {}): LogsClock {
  let now = Date.parse(T(30));
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onSleep(now);
    },
  };
}

async function awfLogs(fixture: Fixture, argv: string[], clock = fakeClock()) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await logsCommand(
    argv,
    fixture.cwd,
    { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    clock,
  );
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") };
}

const strip = (text: string) => text.replace(/ \d\d:\d\d:\d\d /g, " hh:mm:ss ");

describe("awf logs", () => {
  test("messaging: a message, an owed answer and a wait, followed by --agent from either side", async () => {
    const f = await fixture();
    const at = { callPath: [] };
    addLines(
      f,
      {
        ...at,
        kind: "route-opened",
        at: T(1),
        between: ["fixer", "reviewer"],
        purpose: "Agree.",
        maxMessages: 40,
      },
      {
        ...at,
        kind: "message-sent",
        at: T(2),
        message: 1,
        from: "fixer",
        to: "reviewer",
        operationId: "op-1",
        text: "Is 4 blocking?",
        bytes: 14,
        awaitsReply: { until: T(22) },
      },
      {
        ...at,
        kind: "message-delivery",
        at: T(2),
        message: 1,
        from: "fixer",
        to: "reviewer",
        operationId: "op-2",
        state: "offered",
      },
      {
        ...at,
        kind: "message-sent",
        at: T(3),
        message: 2,
        from: "reviewer",
        to: "fixer",
        operationId: "op-2",
        text: "No.",
        bytes: 3,
        replyTo: 1,
      },
      {
        ...at,
        kind: "request-ended",
        at: T(3),
        message: 1,
        owedBy: "reviewer",
        asker: "fixer",
        end: "replied",
        reply: 2,
      },
      {
        ...at,
        kind: "message-sent",
        at: T(4),
        message: 3,
        from: "lens",
        to: "fixer",
        operationId: "op-3",
        text: "Done.",
        bytes: 5,
      },
    );
    const until = new Date(Date.parse(T(22))).toTimeString().slice(0, 8);
    const messaging = [
      "fixer ↔ reviewer opened",
      `message 1 fixer → reviewer  14 B, reply owed  fixer awaits it until ${until}`,
      "message 1 offered",
      "message 2 reviewer → fixer  3 B, reply to 1",
      "request 1 replied",
    ];
    const shown = async (agent: string) =>
      strip((await awfLogs(f, ["--agent", agent])).stdout)
        .split("\n")
        .filter((line) => /route|message \d|request/.test(line));
    const reviewer = await shown("reviewer");
    expect(reviewer).toHaveLength(messaging.length);
    for (const [index, text] of messaging.entries()) expect(reviewer[index]).toContain(text);
    // The fixer's side holds the lens's note too.
    const fixer = await shown("fixer");
    expect(fixer.at(-1)).toContain("message 3 lens → fixer  5 B");
    expect(fixer).toHaveLength(messaging.length + 1);
  });

  test("a tool call is one line, its end's; a start with no end shows alone; --json keeps both", async () => {
    const f = await fixture();
    const keys = { callPath: [], stage: "fix", operationId: "op-1", agent: "fixer" };
    addLines(
      f,
      { ...keys, kind: "tool-called", at: T(2), call: "c1", tool: "close", input: { id: "a1" } },
      {
        ...keys,
        kind: "tool-ended",
        at: T(2),
        call: "c1",
        tool: "close",
        outcome: "cancelled",
        error: "close was stopped as your turn ended",
        durationMs: 2000,
      },
      { ...keys, kind: "tool-called", at: T(3), call: "c2", tool: "list", input: {} },
    );
    const lines = (argv: string[]) =>
      awfLogs(f, argv).then(({ stdout }) =>
        strip(stdout)
          .split("\n")
          .filter((line) => line.includes("tool call "))
          .map((line) => line.replace(/^@\S+ hh:mm:ss fix {2}fixer {2}/, "")),
      );
    const expected = [
      'tool call close {"id":"a1"}  cancelled  2s  close was stopped as your turn ended',
      "tool call list  no end yet",
    ];
    expect(await lines([])).toEqual(expected);
    expect(await lines(["--agent", "fixer"])).toEqual(expected);
    const json = JSON.parse((await awfLogs(f, ["--json"])).stdout) as {
      events: { kind?: string }[];
    };
    expect(
      json.events.flatMap((event) => (String(event.kind).startsWith("tool-") ? [event.kind] : [])),
    ).toEqual(["tool-called", "tool-ended", "tool-called"]);
  });

  test("shows the run's events and its agents' activity, newest last, and what to run next", async () => {
    const f = await fixture();
    addActivity(f, T(2), [
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } },
    ]);
    addActivity(f, T(3), [{ type: "text", text: "Fixed it." }]);
    const { exitCode, stdout } = await awfLogs(f, []);
    expect(exitCode).toBe(0);
    const lines = strip(stdout).split("\n");
    expect(lines.slice(0, -1)).toEqual([
      "review/r1  running  stage fix",
      "@e1 hh:mm:ss fix  stage started",
      "@e2 hh:mm:ss fixer  opened  claude",
      "@e3 hh:mm:ss fix  fixer  turn started",
      "@a1.0 hh:mm:ss fix  fixer  tool Bash  bun test",
      expect.stringMatching(/^@a1\.[0-9a-f]+ hh:mm:ss fix {2}fixer {2}message {2}9 chars$/),
    ]);
    expect(lines.at(-1)).toMatch(/^next: awf logs review\/r1 --after c1\.\S+ --wait 90$/);
  });

  test("--after gives only what is new; --wait returns when it comes, or says nothing came", async () => {
    const f = await fixture();
    const first = await awfLogs(f, ["--json"]);
    const cursor = JSON.parse(first.stdout).cursor;

    const quiet = await awfLogs(f, ["--after", cursor, "--wait", "90"]);
    expect(quiet.stdout.split("\n").at(-1)).toMatch(
      /^nothing new in 90s · running, stage fix · next: awf logs review\/r1 --after c1\.\S+ --wait 90$/,
    );

    let added = false;
    const clock = fakeClock(() => {
      if (added) return;
      added = true;
      addActivity(f, T(4), [{ type: "text", text: "Done." }]);
      addLines(f, turnEnded(5));
    });
    const woke = await awfLogs(f, ["--after", cursor, "--wait", "90", "--json"], clock);
    const page = JSON.parse(woke.stdout);
    expect(page.events.map((event: { kind: string }) => event.kind)).toEqual(["activity", "turn"]);
    expect(page.events[1]).toMatchObject({
      handle: "e4",
      operation: "op-1",
      agent: "fixer",
      outcome: "answered",
    });
    expect(page.events[0]).toMatchObject({
      kind: "activity",
      operation: "op-1",
      stage: "fix",
      activity: { type: "message", from: "agent", chars: 5 },
    });
    expect(page.next.at(-2)).toBe("--wait");
    // Nothing is shown twice.
    const after = await awfLogs(f, ["--after", page.cursor, "--json"]);
    expect(JSON.parse(after.stdout).events).toEqual([]);
  });

  test("pages a long run forward, every event once, a page's end said by more.newer", async () => {
    const f = await fixture();
    for (let second = 0; second < 50; second += 1) {
      addActivity(f, T(2, second), [{ type: "text", text: `step ${second}` }]);
    }
    const newest = JSON.parse((await awfLogs(f, ["--json", "--limit", "5"])).stdout);
    expect(newest.more).toEqual({ older: true });
    expect(newest.events).toHaveLength(5);
    // From the start: the cursor of a read that has read nothing.
    let cursor = `c1.${Buffer.from(JSON.stringify([0, {}])).toString("base64url")}`;
    const seen: string[] = [];
    for (let pages = 0; pages < 20; pages += 1) {
      const page = JSON.parse(
        (await awfLogs(f, ["--after", cursor, "--limit", "7", "--json"])).stdout,
      );
      seen.push(...page.events.map((event: { handle: string }) => event.handle));
      cursor = page.cursor;
      if (!page.more.newer) {
        expect(page.next.at(-1)).toBe("90");
        break;
      }
      expect(page.next.at(-2)).not.toBe("--wait");
    }
    expect(seen).toHaveLength(53);
    expect(new Set(seen).size).toBe(53);
  });

  test("--agent and --limit, said in the header; one event by its handle, in full", async () => {
    const f = await fixture();
    for (let second = 0; second < 8; second += 1) {
      addActivity(f, T(2, second), [
        { type: "text", text: `step ${second} with API_TOKEN=s3cr3t` },
      ]);
    }
    const some = await awfLogs(f, ["--agent", "fixer", "--limit", "3"]);
    expect(some.stdout.split("\n")[1]).toBe("(showing 3 of 10 for fixer; raise --limit for more)");
    const handle = some.stdout.split("\n")[2]!.split(" ")[0]!;
    const full = await awfLogs(f, ["review/r1", handle, "--full"]);
    expect(full.stdout.split("\n")).toEqual([
      "(native text; common credential shapes are masked)",
      expect.stringContaining(`${handle} `),
      "  step 5 with API_TOKEN=***",
    ]);
  });

  test("a page's JSON carries each activity's native text, masked, the line its short cut", async () => {
    const f = await fixture();
    const argument = `wf result op-1 <<'WF_JSON'\n{"approved":false,"note":"${"z".repeat(200)}"}\nWF_JSON`;
    addActivity(f, T(2), [
      { type: "text", text: "Sending the verdict with API_TOKEN=s3cr3t" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: argument } },
    ]);
    appendFileSync(
      f.native,
      `${JSON.stringify({
        type: "user",
        timestamp: T(3),
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "recorded" }] },
      })}\n`,
    );
    const { events } = JSON.parse((await awfLogs(f, ["--json"])).stdout);
    const activity = events.filter((event: { kind: string }) => event.kind === "activity");
    expect(activity.map((event: { text: string }) => event.text)).toEqual([
      "Sending the verdict with API_TOKEN=***",
      argument,
      "recorded",
    ]);
    expect(activity[1].activity.input).toHaveLength(120);
    const [one] = JSON.parse(
      (await awfLogs(f, [`@${activity[1].handle}`, "--json"])).stdout,
    ).events;
    expect(one.text).toBe(argument);
  });

  test("a run that ended says so, with no next; an interrupted one says how to go on", async () => {
    const ended = await fixture({ ...ALIVE, ended: T(6), outcome: "completed" });
    addLines(ended, turnEnded(5), { kind: "attempt-ended", at: T(6), outcome: "completed" });
    const json = JSON.parse((await awfLogs(ended, ["--json"])).stdout);
    expect(json.run).toMatchObject({ state: "completed", duration: 6 * 60_000 });
    expect(json).not.toHaveProperty("next");
    expect((await awfLogs(ended, [])).stdout.split("\n").at(-1)).toBe(
      "run ended: completed in 6m00s · result: awf runs review/r1",
    );
    const gone = await fixture({ pid: Bun.spawnSync(["true"]).pid, processStart: T(0) });
    expect((await awfLogs(gone, [])).stdout.split("\n").at(-1)).toBe(
      "run interrupted · continue: awf run review.ts --continue r1",
    );
  });

  test("an ended run's pages go on in text until the newest, then say it ended", async () => {
    const ended = await fixture({ ...ALIVE, ended: T(6), outcome: "completed" });
    for (let second = 0; second < 20; second += 1) {
      addActivity(ended, T(2, second), [{ type: "text", text: `step ${second}` }]);
    }
    addLines(ended, turnEnded(5), { kind: "attempt-ended", at: T(6), outcome: "completed" });
    let argv = ["--after", `c1.${Buffer.from(JSON.stringify([0, {}])).toString("base64url")}`];
    const seen: string[] = [];
    for (let pages = 0; pages < 10; pages += 1) {
      const lines = (await awfLogs(ended, [...argv, "--limit", "7"])).stdout.split("\n");
      seen.push(...lines.filter((line) => line.startsWith("@")).map((line) => line.split(" ")[0]!));
      const last = lines.at(-1)!;
      if (last.startsWith("run ended: completed")) break;
      const next = /^next: (.*) · run completed, more to read$/.exec(last);
      expect(next?.[1]).not.toContain("--wait");
      argv = next![1]!.split(" ").slice(3);
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  test("--follow prints each event as it comes until the run ends; --stage keeps one stage", async () => {
    const f = await fixture();
    let step = 0;
    const clock = fakeClock(() => {
      step += 1;
      if (step === 1) addActivity(f, T(2), [{ type: "text", text: "Working." }]);
      if (step === 2) {
        addLines(f, turnEnded(3), {
          kind: "stage-ended",
          at: T(3),
          stage: "fix",
          outcome: "succeeded",
        });
        addLines(f, { kind: "attempt-ended", at: T(4), outcome: "completed" });
        writeFileSync(
          join(f.run.dir, "attempts", "1.json"),
          JSON.stringify({
            version: 1,
            attempt: 1,
            file: join(f.cwd, "review.ts"),
            flags: { timeout: "1h" },
            started: T(0),
            ...ALIVE,
            ended: T(4),
            outcome: "completed",
          }),
        );
      }
    });
    const followed = strip((await awfLogs(f, ["--follow"], clock)).stdout).split("\n");
    expect(followed[0]).toBe("review/r1  running  stage fix");
    expect(followed).toContain("@e4 hh:mm:ss fix  fixer  turn ended  answered  2m00s");
    expect(followed.at(-1)).toBe("run ended: completed in 4m00s · result: awf runs review/r1");
    const staged = await awfLogs(f, ["--stage", "elsewhere", "--json"]);
    expect(JSON.parse(staged.stdout).events).toEqual([]);
  });

  test("a turn line that settled before the line written ahead of it is still paged once", async () => {
    const f = await fixture();
    // The worker's turn settles at 09:02, but its line comes after another's start at 09:03.
    addLines(
      f,
      {
        kind: "operation-started",
        at: T(3),
        of: "turn",
        callPath: [],
        agent: "other",
        operationId: "op-2",
        execution: { harness: "claude", model: "m" },
        stage: "fix",
        deliveredAt: T(3),
        sessions: [],
      },
      turnEnded(2),
    );
    let cursor = `c1.${Buffer.from(JSON.stringify([0, {}])).toString("base64url")}`;
    const seen: string[] = [];
    for (let pages = 0; pages < 10; pages += 1) {
      const page = JSON.parse(
        (await awfLogs(f, ["--after", cursor, "--limit", "1", "--json"])).stdout,
      );
      seen.push(...page.events.map((event: { handle: string }) => event.handle));
      cursor = page.cursor;
      if (!page.more.newer) break;
    }
    expect(seen).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  test("a filtered wait ends when the run does, though nothing it keeps came", async () => {
    const f = await fixture();
    const cursor = JSON.parse((await awfLogs(f, ["--json"])).stdout).cursor;
    let slept = 0;
    const clock = fakeClock(() => {
      slept += 1;
      if (slept > 1) return;
      addLines(f, { kind: "attempt-ended", at: T(5), outcome: "completed" });
      writeFileSync(
        join(f.run.dir, "attempts", "1.json"),
        JSON.stringify({
          version: 1,
          attempt: 1,
          file: join(f.cwd, "review.ts"),
          flags: { timeout: "1h" },
          started: T(0),
          ...ALIVE,
          ended: T(5),
          outcome: "completed",
        }),
      );
    });
    const waited = await awfLogs(
      f,
      ["--agent", "nobody", "--after", cursor, "--wait", "90"],
      clock,
    );
    expect(slept).toBe(1);
    expect(waited.stdout.split("\n").at(-1)).toBe(
      "run ended: completed in 5m00s · result: awf runs review/r1",
    );
  });

  test("a run whose record is newer than this awf is the run's files, exit 3, not a missing run", async () => {
    const f = await fixture();
    await writeJson(join(f.run.dir, "run.json"), { version: 99 });
    const read = await awfLogs(f, ["review/r1"]);
    expect(read.exitCode).toBe(3);
    expect(read.stderr).not.toContain("runs here");
  });

  test("a cursor stays good past a line the reader skips", async () => {
    const f = await fixture();
    appendFileSync(
      f.log,
      `${JSON.stringify({ version: 9, attempt: 1, kind: "later", at: T(2) })}\n`,
    );
    addLines(f, { kind: "log", at: T(3), text: "after it", stage: "fix" });
    const cursor = JSON.parse((await awfLogs(f, ["--json"])).stdout).cursor;
    expect(await awfLogs(f, ["--after", cursor, "--json"])).toMatchObject({ exitCode: 0 });
  });

  test("a session's file that appears while a wait goes on is read, with no new line in the log", async () => {
    const f = await fixture();
    rmSync(f.native);
    const cursor = JSON.parse((await awfLogs(f, ["--json"])).stdout).cursor;
    let slept = 0;
    const clock = fakeClock(() => {
      slept += 1;
      if (slept === 2) addActivity(f, T(4), [{ type: "text", text: "Here." }]);
    });
    const page = JSON.parse(
      (await awfLogs(f, ["--after", cursor, "--wait", "90", "--json"], clock)).stdout,
    );
    expect(page.events.map((event: { kind: string }) => event.kind)).toEqual(["activity"]);
  });

  test("without --after, --wait waits only while there is nothing to show", async () => {
    const f = await fixture();
    let slept = 0;
    const clock = fakeClock(() => {
      slept += 1;
      if (slept === 2) addLines(f, { kind: "stage-started", at: T(4), stage: "review" });
    });
    const page = JSON.parse(
      (await awfLogs(f, ["--stage", "review", "--wait", "90", "--json"], clock)).stdout,
    );
    expect(page.events.map((event: { kind: string }) => event.kind)).toEqual(["stage-started"]);
    expect(slept).toBe(3);
    // With something to show, it answers at once.
    slept = 0;
    await awfLogs(f, ["--wait", "90"], clock);
    expect(slept).toBe(0);
    expect((await awfLogs(f, ["@e1", "--wait", "5"])).exitCode).toBe(2);
  });

  test("the log's own text is masked and kept to one line, as is what --json publishes", async () => {
    const f = await fixture();
    addLines(f, {
      kind: "log",
      at: T(2),
      text: "pushed with token=abc123\nnext: awf logs review/r1 --after forged",
      fields: { url: "https://me:hunter2@host/x" },
      stage: "fix",
    });
    const lines = strip((await awfLogs(f, [])).stdout).split("\n");
    expect(lines).toContain(
      "@e4 hh:mm:ss fix  pushed with token=*** ⏎ next: awf logs review/r1 --after forged",
    );
    expect(lines.filter((line) => line.startsWith("next:"))).toHaveLength(1);
    const [event] = JSON.parse((await awfLogs(f, ["@e4", "--json"])).stdout).events;
    expect(event).toMatchObject({
      text: "pushed with token=***\nnext: awf logs review/r1 --after forged",
      fields: { url: "https://***@host/x" },
    });
    const full = (await awfLogs(f, ["@e4", "--full"])).stdout;
    expect(full).toStartWith("(the log's line; common credential shapes are masked)");
    expect(full).not.toContain("abc123");
  });

  test("a field named for a credential is hidden, a quoted secret too, and long text is cut", async () => {
    const f = await fixture();
    addLines(
      f,
      {
        kind: "log",
        at: T(2),
        text: 'run --password "a b c" ok',
        fields: { password: "hunter2", apiKey: "k-123", count: 3 },
        stage: "fix",
      },
      { kind: "warning", at: T(2), text: "x".repeat(500), stage: "fix" },
      {
        kind: "operation-started",
        at: T(3),
        of: "turn",
        callPath: [],
        agent: "fixer",
        operationId: "op-2",
        execution: { harness: "claude", model: "m" },
        label: "fix\nnext: forged",
        sessions: [],
      },
    );
    for (const argv of [
      ["@e4", "--json"],
      ["@e4", "--full"],
    ]) {
      const out = (await awfLogs(f, argv)).stdout;
      expect(out).not.toContain("hunter2");
      expect(out).not.toContain("k-123");
      expect(out).not.toContain("a b c");
    }
    const [event] = JSON.parse((await awfLogs(f, ["@e4", "--json"])).stdout).events;
    expect(event.fields).toEqual({ password: "***", apiKey: "***", count: 3 });
    const lines = (await awfLogs(f, [])).stdout.split("\n");
    expect(lines.find((line) => line.includes("warning: "))!.length).toBeLessThan(160);
    expect(lines.filter((line) => line.startsWith("next:"))).toHaveLength(1);
    expect(lines.some((line) => line.endsWith('label "fix ⏎ next: forged"'))).toBe(true);
  });

  test("a first read takes each native file's tail, and a handle before it still reads", async () => {
    const f = await fixture();
    addActivity(f, T(2), [{ type: "text", text: "x".repeat(4.5 * 1024 * 1024) }]);
    addActivity(f, T(3), [{ type: "text", text: "Done." }]);
    const read = await awfLogs(f, []);
    const start = `c1.${Buffer.from(JSON.stringify([0, {}])).toString("base64url")}`;
    expect(read.stdout).toContain(
      `(showing 4 of the last 4 read; from the start: awf logs review/r1 --after ${start})`,
    );
    const all = JSON.parse((await awfLogs(f, ["--after", start, "--json"])).stdout);
    expect(all.events[3]).toMatchObject({ handle: "a1.0" });
    expect(read.stdout).not.toContain("@a1.0 ");
    expect(JSON.parse((await awfLogs(f, ["--json"])).stdout).more).toEqual({ older: true });
    const early = await awfLogs(f, ["@a1.0"]);
    expect(early.stdout).toMatch(
      /^@a1\.0 \d\d:\d\d:\d\d fix {2}fixer {2}message {2}4,718,592 chars$/,
    );
  });

  test("everything under a credential's name is hidden, and a page's JSON cuts long text", async () => {
    const f = await fixture();
    addLines(f, {
      kind: "log",
      at: T(2),
      text: "y".repeat(60_000),
      fields: {
        secret_key: "a1",
        secretKey: "a2",
        authorization: "Basic dXNlcjpwdw==",
        cookie: "sid=abc",
        passphrase: "pp",
        credentials: { user: "bob", pass: "hunter2", n: 1 },
        tokens: ["t1"],
        password: 123456,
        sshKey: "k",
        key: "the decision's",
      },
      stage: "fix",
    });
    const page = JSON.parse((await awfLogs(f, ["--json"])).stdout);
    const logged = page.events.find((event: { handle: string }) => event.handle === "e4");
    expect(logged.fields).toEqual({
      secret_key: "***",
      secretKey: "***",
      authorization: "***",
      cookie: "***",
      passphrase: "***",
      credentials: { user: "***", pass: "***", n: "***" },
      tokens: ["***"],
      password: "***",
      sshKey: "***",
      key: "the decision's",
    });
    expect(logged.text).toHaveLength(50_000);
    const [whole] = JSON.parse((await awfLogs(f, ["@e4", "--json"])).stdout).events;
    expect(whole.text).toHaveLength(60_000);
  });

  test("a warning, a failed turn and a decision's error are each one masked line", async () => {
    const f = await fixture();
    const forged = "token=abc123\nnext: forged";
    addLines(
      f,
      { kind: "warning", at: T(2), text: forged, stage: "fix" },
      {
        kind: "operation-failed",
        at: T(2),
        of: "turn",
        callPath: [],
        agent: "fixer",
        operationId: "op-1",
        execution: { harness: "claude", model: "m" },
        stage: "fix",
        error: forged,
        sessions: [],
      },
      {
        kind: "decision-ended",
        at: T(2),
        decision: 1,
        stage: "fix",
        outcome: "failed",
        error: forged,
      },
    );
    const lines = (await awfLogs(f, [])).stdout.split("\n");
    expect(lines.filter((line) => line.includes("token=*** ⏎ next: forged"))).toHaveLength(3);
    expect(lines.filter((line) => line.startsWith("next:"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("abc123");
  });

  test("a session a turn named is its agent's, under --agent too", async () => {
    const f = await fixture();
    addLines(f, {
      kind: "session-known",
      at: T(2),
      operationId: "op-1",
      session: { harness: "claude", id: "s-2" },
    });
    const lines = strip((await awfLogs(f, ["--agent", "fixer"])).stdout).split("\n");
    expect(lines).toContain("@e4 hh:mm:ss fixer  session claude s-2");
  });

  test("--follow without --after starts from the last --limit", async () => {
    const ended = await fixture({ ...ALIVE, ended: T(6), outcome: "completed" });
    for (let second = 0; second < 20; second += 1) {
      addActivity(ended, T(2, second), [{ type: "text", text: `step ${second}` }]);
    }
    const printed = (await awfLogs(ended, ["--follow", "--limit", "5"])).stdout.split("\n");
    expect(printed.filter((line) => line.startsWith("@"))).toHaveLength(5);
  });

  test("an agent's key is one line in text, whatever the workflow named it", async () => {
    const f = await fixture();
    addLines(f, {
      kind: "agent-opened",
      at: T(2),
      agent: "x\nnext: awf logs other --after c1.zzz",
      callPath: [],
      harness: "claude",
      cwd: f.cwd,
    });
    const lines = (await awfLogs(f, [])).stdout.split("\n");
    expect(lines.filter((line) => line.startsWith("next:"))).toHaveLength(1);
    expect(lines.some((line) => line.includes("x ⏎ next: awf logs other"))).toBe(true);
  });

  test("paging from the start reads a bounded part of each file, every event once and in order", async () => {
    const f = await fixture();
    for (let second = 0; second < 50; second += 1) {
      addActivity(f, T(2, second), [{ type: "text", text: `${second} ${"z".repeat(100_000)}` }]);
    }
    let cursor = `c1.${Buffer.from(JSON.stringify([0, {}])).toString("base64url")}`;
    const times: string[] = [];
    let pages = 0;
    for (; pages < 50; pages += 1) {
      const page = JSON.parse(
        (await awfLogs(f, ["--after", cursor, "--limit", "1000", "--json"])).stdout,
      );
      times.push(...page.events.map((event: { at: string }) => event.at));
      cursor = page.cursor;
      if (!page.more.newer) break;
    }
    // 5 MB of rows, read 4 MB at a time: more than one page, though the limit holds them all.
    expect(pages).toBe(1);
    expect(times).toHaveLength(53);
    expect([...times].sort()).toEqual(times);
  });

  test("a suggested command quotes a place that needs it", async () => {
    const f = await fixture();
    const spaced = join(runDirs.tempRunDir(), "my project");
    symlinkSync(f.cwd, spaced);
    const read = await awfLogs(f, ["--cwd", spaced]);
    expect(read.stdout.split("\n").at(-1)).toMatch(
      new RegExp(`^next: awf logs review/r1 --cwd '${spaced}' --after c1\\.\\S+ --wait 90$`),
    );
  });

  test("mistakes: no such run, a cursor or handle that does not fit, and usage errors", async () => {
    const f = await fixture();
    expect(await awfLogs(f, ["20261008-0000-ffff"])).toMatchObject({
      exitCode: 1,
      stderr: `no run 20261008-0000-ffff under ${join(f.cwd, ".awf", "runs")}; runs here: awf runs`,
    });
    expect(await awfLogs(f, ["review/r1", "--after", "c1.zzz"])).toMatchObject({
      exitCode: 1,
      stderr: "cursor c1.zzz does not fit this run; start again: awf logs review/r1",
    });
    expect((await awfLogs(f, ["review/r1", "@a9.ff"])).exitCode).toBe(1);
    expect((await awfLogs(f, ["--follow", "--json"])).exitCode).toBe(2);
    expect((await awfLogs(f, ["--wait", "301"])).exitCode).toBe(2);
    expect((await awfLogs(f, ["--full"])).exitCode).toBe(2);
  });
});
