import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitCommand } from "./emit-command";
import { appendMailbox } from "./mailbox";
import { runOperatorCli } from "./operator-cli";
import { createRun, openRun, previousGone, processStart, readAttempts } from "./runs";
import { stopCrashed } from "./stop-crashed";
import { createTempRunDirs, keyedProject, until, writeAttempt } from "./testing";
import { wake } from "./wake";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

// A run that takes events until it has seen two, and returns them: no agent, so no harness. What
// it has seen is in a file, as anything that must outlive a park is.
const WORKFLOW = `import { appendFileSync, readFileSync } from "node:fs";
const Changes = { type: "object", properties: { case: { type: "string" }, n: { type: "number" } }, required: ["case"] };
const SEEN = new URL("./seen.txt", import.meta.url).pathname;
const seen = () => { try { return readFileSync(SEEN, "utf8").split("\\n").filter(Boolean).map(Number); } catch { return []; } };
import { defineEventWorkflow } from "agentswf/workflow";
export default defineEventWorkflow({
  definition: {
    meta: { name: "e2e-case", description: "Takes two events." },
    file: import.meta.path,
    events: { "dd.changes": Changes },
    id: (e) => e.data.case,
    starts: ["dd.changes"],
    async run(workflow) {
      for (;;) {
        for (const e of await workflow.receive({ label: seen().length + " seen" }))
          appendFileSync(SEEN, e.data.n + "\\n");
        if (seen().length >= 2) return { seen: seen() };
      }
    },
  },
});
`;

function setup() {
  const { root, file, home } = keyedProject(dirs, "case.ts", WORKFLOW);
  const out: string[] = [];
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(`! ${t}`) };
  const send = (n: number) =>
    emitCommand(
      ["--target", file, "dd.changes", JSON.stringify({ case: "k", n }), "--id", `c${n}`],
      dirs.tempRunDir(),
      io,
      { home, environment: { ...process.env, HOME: home } },
    );
  return { root, file, home, out, send };
}

test("an event starts a detached run, which parks; the next continues it, from any directory", async () => {
  const { root, out, send } = setup();
  expect(await send(1)).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-case", "k");
  // It takes the starting event, waits with nothing to take and no turn running, and parks.
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  expect(await send(2)).toBe(0);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "completed");
  expect(out).toEqual(["accepted e2e-case/k: started", "accepted e2e-case/k: continued"]);
  expect((await readAttempts(run)).map((a) => a.outcome)).toEqual(["parked", "completed"]);
  // It returned having taken every event; its output went to the run's log, not a terminal.
  expect((await readAttempts(run)).at(-1)?.unacknowledged).toBe(0);
  expect(await Bun.file(join(run.dir, "process.log")).text()).toContain("◇ parked: 1 seen");
  const output = JSON.parse(await Bun.file(join(run.dir, "output.json")).text()) as {
    value: unknown;
  };
  expect(output.value).toEqual({ seen: [1, 2] });
  expect(await send(3)).toBe(0);
  expect(out.at(-1)).toBe("refused e2e-case/k: returned");
}, 60_000);

test("awf run starts a run of a workflow with events by its id, with no event, and it parks", async () => {
  const { root, file, home, out, send } = setup();
  const run = (...extra: string[]) =>
    runOperatorCli(["run", file, ...extra], {
      home,
      environment: { ...process.env, HOME: home },
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(`! ${t}`),
    });
  // Its id comes from its events: without --id there is nothing to name the run by.
  expect(await run()).toBe(2);
  expect(out.pop()).toContain("names its runs from their events: awf run --id {id}");
  expect(await run("--id", "k")).toBe(0);
  const opened = await openRun(join(root, ".awf", "runs"), "e2e-case", "k");
  await until(async () => (await readAttempts(opened)).at(-1)?.outcome === "parked");
  expect(await run("--id", "k")).toBe(0);
  expect(out).toEqual(["e2e-case/k: started", "e2e-case/k was there: nothing-due"]);
  // The first event it takes is the first one sent, not one awf made up.
  expect(await send(1)).toBe(0);
  expect(await send(2)).toBe(0);
  await until(async () => (await readAttempts(opened)).at(-1)?.outcome === "completed");
  expect(await run("--id", "k")).toBe(0);
  expect(out.at(-1)).toBe("e2e-case/k was there: returned");
}, 60_000);

test("a workflow whose id is a string has one run, which awf run starts without --id", async () => {
  const { root, file, home } = keyedProject(
    dirs,
    "tick.ts",
    WORKFLOW.replace("id: (e) => e.data.case,", 'id: "main",').replace(
      'starts: ["dd.changes"],\n',
      "",
    ),
  );
  const out: string[] = [];
  const code = await runOperatorCli(["run", file], {
    home,
    environment: { ...process.env, HOME: home },
    stdout: (t) => out.push(t),
    stderr: (t) => out.push(`! ${t}`),
  });
  expect(code).toBe(0);
  expect(out).toEqual(["e2e-case/main: started"]);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-case", "main");
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
}, 60_000);

test("awf run --continue of an event run takes no stage, values or arguments", async () => {
  const { file, home } = setup();
  for (const [extra, message] of [
    [["--from-stage", "x"], "takes no --from-stage or --values"],
    [["--", "arg"], "takes no arguments"],
    [["--id", "j"], "--id names a new run"],
  ] as const) {
    const err: string[] = [];
    const code = await runOperatorCli(["run", file, "--continue", "k", ...extra], {
      home,
      stdout: () => undefined,
      stderr: (t) => err.push(t),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain(message);
  }
});

test("a continue reads the project's .env again, and not what the sender exported", async () => {
  const { root, file, home } = keyedProject(
    dirs,
    "env.ts",
    `import { appendFileSync } from "node:fs";
import { defineEventWorkflow } from "agentswf/workflow";
const Ping = { type: "object", properties: { n: { type: "number" } } };
export default defineEventWorkflow({
  definition: {
    meta: { name: "e2e-env", description: "Records its token at each wake." },
    file: import.meta.path,
    events: { ping: Ping },
    id: () => "one",
    starts: ["ping"],
    async run(workflow) {
      for (;;) {
        const events = await workflow.receive();
        appendFileSync(new URL("../tokens.txt", import.meta.url).pathname, (process.env.TOKEN ?? "none") + "\\n");
        if (events.some((e) => e.data.n === 2)) return null;
      }
    },
  },
});
`,
  );
  writeFileSync(join(root, ".env"), "TOKEN=first\n");
  const io = { stdout: () => undefined, stderr: () => undefined };
  const send = (n: number, environment: Record<string, string | undefined>) =>
    emitCommand(
      ["--target", file, "ping", JSON.stringify({ n }), "--id", `p${n}`],
      dirs.tempRunDir(),
      io,
      {
        home,
        environment,
      },
    );
  expect(await send(1, { HOME: home, PATH: process.env.PATH })).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-env", "one");
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  writeFileSync(join(root, ".env"), "TOKEN=rotated\n");
  // A sender with a stale token exported, and a PATH of its own: the run has neither.
  expect(await send(2, { HOME: home, PATH: "/nowhere", TOKEN: "stale" })).toBe(0);
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "completed");
  expect((await Bun.file(join(root, "tokens.txt")).text()).trim().split("\n")).toEqual([
    "first",
    "rotated",
  ]);
}, 60_000);

test("a continue waits for the previous attempt's process to be gone", async () => {
  const root = dirs.tempRunDir();
  const run = await createRun(join(root, "runs"), {
    id: "k",
    workflow: "w",
    argv: [],
    cwd: root,
    sandbox: null,
    events: true,
  });
  const previous = Bun.spawn({ cmd: ["sleep", "0.4"] });
  await Bun.sleep(50);
  await writeAttempt(run, {
    pid: previous.pid,
    processStart: processStart(previous.pid)!,
    ended: new Date().toISOString(),
    outcome: "parked",
  });
  const started = Date.now();
  await previousGone(run, 2, () => undefined);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(previous.exitCode).toBe(0);
});

test("a continue claims its attempt first, so wake returns, then waits for the previous process", async () => {
  const { root, file, home } = setup();
  const run = await createRun(join(root, ".awf", "runs"), {
    id: "k",
    workflow: "e2e-case",
    argv: [],
    cwd: root,
    sandbox: null,
    events: true,
    env: { PATH: process.env.PATH ?? "" },
    file,
  });
  // Attempt 1 parked, its process still closing for a second.
  const previous = Bun.spawn({ cmd: ["sleep", "1.5"] });
  await Bun.sleep(50);
  const now = new Date().toISOString();
  await writeAttempt(run, {
    file,
    pid: previous.pid,
    processStart: processStart(previous.pid)!,
    started: now,
    ended: now,
    outcome: "parked",
  });
  await appendMailbox(run.dir, {
    version: 1,
    at: now,
    kind: "event",
    id: "c1",
    name: "dd.changes",
    data: { case: "k", n: 1 },
    from: "operator",
  });
  const started = Date.now();
  expect(await wake(run, { home, environment: { ...process.env, HOME: home } })).toMatchObject({
    did: "continued",
  });
  // Returned on the claim, the previous process still alive.
  expect(Date.now() - started).toBeLessThan(1_400);
  expect(previous.exitCode).toBeNull();
  // The new attempt wrote nothing yet: its first line waits for the previous process.
  const turns = await Bun.file(join(run.dir, "turns.jsonl"))
    .text()
    .catch(() => "");
  expect(turns).not.toContain('"attempt":2');
  await previous.exited;
  await until(async () =>
    (
      await Bun.file(join(run.dir, "turns.jsonl"))
        .text()
        .catch(() => "")
    ).includes('"attempt":2'),
  );
}, 60_000);

test("a continue after a crash stops what is left of the crashed attempt's group", async () => {
  // A detached attempt, as wake starts one, that crashed and left a child running in its group.
  const attempt = Bun.spawn({
    cmd: ["sh", "-c", "sleep 30 & echo $!"],
    stdout: "pipe",
    detached: true,
  });
  const reader = attempt.stdout.getReader();
  const agent = Number(new TextDecoder().decode((await reader.read()).value).trim());
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const started = processStart(attempt.pid) ?? "";
  await attempt.exited;
  expect(alive(agent)).toBe(true);
  const home = dirs.tempRunDir();
  await stopCrashed(
    {
      version: 1,
      attempt: 1,
      file: "/f.ts",
      flags: {},
      pid: attempt.pid,
      processStart: started,
      started: new Date().toISOString(),
    },
    "awf e2e-case k #1",
    { home, environment: {} },
  );
  await Bun.sleep(100);
  expect(alive(agent)).toBe(false);
});
