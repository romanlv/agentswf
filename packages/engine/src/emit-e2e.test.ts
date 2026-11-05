import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitCommand } from "./emit-command";
import { appendIn } from "./in-lines";
import { runOperatorCli } from "./operator-cli";
import { readRunLines } from "./run-lines";
import { runStatus } from "./run-state";
import { createRun, launchLog, openRun, previousGone, processStart, readAttempts } from "./runs";
import { stopCrashed } from "./stop-crashed";
import { createTempRunDirs, eventProject, lastLines, until, writeAttempt } from "./testing";
import { wake } from "./wake";

const dirs = createTempRunDirs();
const CLI = join(import.meta.dir, "operator-cli.ts");
afterAll(() => dirs.cleanup());

// A run that takes events until it has seen two, and returns them: no agent, so no harness. What
// it has seen is in a file, as anything that must outlive a park is.
const WORKFLOW = `import { appendFileSync, readFileSync } from "node:fs";
const Changes = { type: "object", properties: { case: { type: "string" }, n: { type: "number" } }, required: ["case"] };
const SEEN = new URL("./seen.txt", import.meta.url).pathname;
const seen = () => { try { return readFileSync(SEEN, "utf8").split("\\n").filter(Boolean).map(Number); } catch { return []; } };
import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "e2e-case", description: "Takes two events." },
  file: import.meta.path,
  events: { "dd.changes": Changes },
  starts: ["dd.changes"],
  async run(workflow) {
    for (;;) {
      for (const e of await workflow.receive({ label: seen().length + " seen" }))
        appendFileSync(SEEN, e.data.n + "\\n");
      if (seen().length >= 2) return { seen: seen() };
    }
  },
});
`;

function setup() {
  const { root, file, home } = eventProject(dirs, "case.ts", WORKFLOW);
  const out: string[] = [];
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(`! ${t}`) };
  const send = (n: number) =>
    emitCommand(
      [
        "--target",
        file,
        "--id",
        "k",
        "dd.changes",
        JSON.stringify({ case: "k", n }),
        "--event-id",
        `c${n}`,
      ],
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
  expect((await runStatus(run)).unacknowledged).toBe(0);
  // Its return value is its attempt file's; out.json is a view of it.
  expect((await readAttempts(run)).at(-1)?.value).toEqual({ seen: [1, 2] });
  // Each launch has its own log, named by the launch its attempt records.
  const attempts = await readAttempts(run);
  const launches = attempts.map((each) => each.launch);
  expect(launches.every((launch) => typeof launch === "string")).toBe(true);
  expect(new Set(launches).size).toBe(2);
  expect(await Bun.file(launchLog(run.dir, launches[0] as string)).text()).toContain(
    "◇ parked: 1 seen",
  );
  const output = JSON.parse(await Bun.file(join(run.dir, "out.json")).text()) as {
    ref: string;
    value: unknown;
  };
  expect(output.ref).toBe("e2e-case/k");
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
  // Without --id there is nothing to name the run by.
  expect(await run()).toBe(2);
  expect(out.pop()).toContain("is named by its id, which --id or the workflow's id(args) gives");
  expect(await run("--id", "k", "--timeout", "5m")).toBe(2);
  expect(out.pop()).toContain("as every wake starts it: it takes no --timeout");
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

// Started by hand with args or by an event without: what `prepare` made of its argv is in its output.
const WITH_ARGS = `import { defineWorkflow } from "agentswf/workflow";
const Changes = { type: "object", properties: { case: { type: "string" } }, required: ["case"] };
export default defineWorkflow({
  meta: { name: "e2e-args", description: "Returns its args at the first event." },
  file: import.meta.path,
  events: { "dd.changes": Changes },
  prepare: ({ argv }) => {
    if (argv[0] === undefined) throw new Error("a case needs its key");
    if (argv[0] === "refuse") throw new Error("no such case");
    return { case: argv[0] };
  },
  id: (args) => args.case,
  async run(workflow, args) {
    await workflow.receive();
    return args;
  },
});
`;

test("awf run starts a run of a workflow with events with args, and an event for its id lands in it", async () => {
  const { root, file, home } = eventProject(dirs, "args.ts", WITH_ARGS);
  const out: string[] = [];
  const io = { home, environment: { ...process.env, HOME: home } };
  const run = (...extra: string[]) =>
    runOperatorCli(["run", file, ...extra], {
      ...io,
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(`! ${t}`),
    });
  const send = (id: string) =>
    emitCommand(
      ["--target", file, "--id", id, "dd.changes", JSON.stringify({ case: id })],
      dirs.tempRunDir(),
      { stdout: (t) => out.push(t), stderr: (t) => out.push(`! ${t}`) },
      io,
    );
  const output = async (id: string) => {
    const opened = await openRun(join(root, ".awf", "runs"), "e2e-args", id);
    await until(async () => (await readAttempts(opened)).at(-1)?.outcome === "completed");
    return (JSON.parse(await Bun.file(join(opened.dir, "out.json")).text()) as { value: unknown })
      .value;
  };
  // `id(args)` names it, so no --id is needed; prepare runs where the run works, its project.
  expect(await run("--", "kombo")).toBe(0);
  expect(out.pop()).toBe("e2e-args/kombo: started");
  const opened = await openRun(join(root, ".awf", "runs"), "e2e-args", "kombo");
  expect(opened.record.argv).toEqual(["kombo"]);
  await until(async () => (await readAttempts(opened)).at(-1)?.outcome === "parked");
  // Its args are its own: a run there already is refused other args, and woken by none, which
  // prepare refuses only for a run it would make.
  expect(await run("--id", "kombo", "--", "other")).toBe(2);
  expect(out.pop()).toContain("is there already, started with arguments of its own");
  expect(await run("--id", "kombo")).toBe(0);
  expect(out.pop()).toStartWith("e2e-args/kombo was there");
  expect(await send("kombo")).toBe(0);
  expect(await output("kombo")).toEqual({ case: "kombo" });
  // A run an event starts has no argv: its args are what prepare makes of none, refused here.
  expect(await send("fresh")).toBe(2);
  expect(out.pop()).toContain("which its prepare refuses: a case needs its key");
  expect(await run("--id", "fresh")).toBe(2);
  expect(out.pop()).toContain("prepare: a case needs its key");
  expect(existsSync(join(root, ".awf", "runs", "e2e-args", "fresh"))).toBe(false);
  // An argv prepare refuses is refused before any run is made.
  expect(await run("--", "refuse")).toBe(2);
  expect(out.pop()).toContain("prepare: no such case");
}, 60_000);

test("awf run of an event run takes no values, arguments on a continue, or a stage on a new run", async () => {
  const { file, home } = setup();
  const values = join(dirs.tempRunDir(), "values.json");
  writeFileSync(values, "{}");
  for (const [extra, message] of [
    [["--continue", "--from-stage", "x", "--values", values], "takes no --values"],
    [["--continue", "--", "arg"], "takes no arguments"],
    [["--from-stage", "x"], "takes --from-stage only with --continue"],
  ] as const) {
    const err: string[] = [];
    const code = await runOperatorCli(["run", file, "--id", "k", ...extra], {
      home,
      stdout: () => undefined,
      stderr: (t) => err.push(t),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain(message);
  }
});

// Three stages around two waits, and no file, no starts and no id: awf finds it by its path and
// names its run. Each stage's value is how many stages had run when it ran.
const REDO = `import { appendFileSync, readFileSync } from "node:fs";
import { defineWorkflow } from "agentswf/workflow";
const RAN = new URL("./ran.txt", import.meta.url).pathname;
const ran = (stage) => {
  appendFileSync(RAN, stage + "\\n");
  return readFileSync(RAN, "utf8").split("\\n").filter(Boolean).length;
};
const N = { type: "number" };
export default defineWorkflow({
  meta: { name: "e2e-redo", description: "Stages around two waits." },
  events: { go: { type: "object", properties: {} } },
  async run(wf) {
    const plan = await wf.stage("plan", { result: N }, async () => ran("plan"));
    await wf.race("first", { go: wf.signal("go") });
    const build = await wf.stage("build", { result: N }, async () => ran("build"));
    await wf.race("second", { go: wf.signal("go") });
    const ship = await wf.stage("ship", { result: N }, async () => ran("ship"));
    return { plan, build, ship };
  },
});
`;

test("--from-stage on a run with events redoes that stage and the ones after it, as a plain run's does", async () => {
  const { root, file, home } = eventProject(dirs, "redo.ts", REDO);
  const out: string[] = [];
  const io = { home, environment: { ...process.env, HOME: home } };
  const awf = (...words: string[]) =>
    runOperatorCli(["run", file, ...words], {
      ...io,
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(`! ${t}`),
    });
  const runs = join(root, ".awf", "runs", "e2e-redo");
  expect(await awf()).toBe(0);
  // A run's folder, not one a claim is making.
  const [id] = readdirSync(runs).filter((name) => !name.startsWith("."));
  if (id === undefined) throw new Error("no run");
  const run = await openRun(join(root, ".awf", "runs"), "e2e-redo", id);
  const outcomes = async () => (await readAttempts(run)).map((attempt) => attempt.outcome);
  const go = () =>
    emitCommand(
      ["--target", file, "--id", id, "go", "{}"],
      dirs.tempRunDir(),
      {
        stdout: (t) => out.push(t),
        stderr: (t) => out.push(`! ${t}`),
      },
      io,
    );
  await until(async () => (await outcomes()).at(-1) === "parked");
  expect(await go()).toBe(0);
  await until(async () => (await outcomes()).length === 2 && (await outcomes())[1] === "parked");
  const stage = async (name: string) => (await lastLines(run.dir)).get(name);
  const attemptsOf = async (name: string) =>
    (await readRunLines(run.dir)).view.stages[name]?.history.map((line) => line.attempt);
  expect([(await stage("plan"))?.value, (await stage("build"))?.value]).toEqual([1, 2]);

  // Each by hand in a process of its own, as at a terminal: an attempt waits for the one before it to exit.
  const own = async (...words: string[]) => {
    const child = Bun.spawn({
      cmd: [process.execPath, CLI, "run", file, "--id", id, "--continue", ...words],
      cwd: root,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, text] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, text };
  };
  // Parked at its second wait: redone from build, which runs again, and parks there again.
  expect((await own("--from-stage", "build")).code).toBe(0);
  expect(await outcomes()).toEqual(["parked", "parked", "parked"]);
  expect((await readAttempts(run))[2]?.flags).toEqual({ fromStage: "build" });
  // It ran its stage.
  expect([await stage("plan"), await stage("build")]).toMatchObject([
    { attempt: 1, value: 1 },
    { attempt: 3, value: 3 },
  ]);
  // What marks it a redo for the attempts after it: its stage's line.
  expect(await stage("build")).toMatchObject({ redo: true });
  expect(await attemptsOf("build")).toEqual([2, 3]);
  const summaries = JSON.parse(await Bun.file(join(run.dir, "out.json")).text()) as {
    stages: { stage: string; source: string; attempt: number }[];
  };
  expect(summaries.stages.map(({ stage, source, attempt }) => [stage, source, attempt])).toEqual([
    ["plan", "reused", 1],
    ["build", "ran", 3],
  ]);

  // A stage it would park before reaching stops it, as one never reached by its end does.
  const nope = await own("--from-stage", "nope");
  expect(nope.code).toBe(3);
  expect(nope.text).toContain("never reached nope");
  expect((await outcomes()).at(-1)).toBe("stopped");
  expect(await attemptsOf("build")).toEqual([2, 3]);
  expect((await own()).code).toBe(0);
  expect((await outcomes()).at(-1)).toBe("parked");

  // The next wake reuses what the redo wrote, by content, and runs what comes after.
  expect(await go()).toBe(0);
  await until(async () => (await outcomes()).at(-1) === "completed");
  const output = JSON.parse(await Bun.file(join(run.dir, "out.json")).text()) as {
    value: unknown;
  };
  expect(output.value).toEqual({ plan: 1, build: 3, ship: 4 });
}, 90_000);

// Parked at a race with a timeout, a timer of its own.
const DEADLINE = `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "e2e-deadline", description: "Waits for go, an hour at most." },
  events: { go: { type: "object", properties: {} } },
  async run(wf) {
    await wf.stage("plan", async () => undefined);
    return (await wf.race("approval", { go: wf.signal("go"), timeout: "1h" })).key;
  },
});
`;

test("a --from-stage never reached keeps the timers of the wait it was parked at", async () => {
  const { root, file, home } = eventProject(dirs, "deadline.ts", DEADLINE);
  const io = { home, environment: { ...process.env, HOME: home } };
  expect(
    await runOperatorCli(["run", file, "--id", "d"], { ...io, stdout: () => {}, stderr: () => {} }),
  ).toBe(0);
  const run = await openRun(join(root, ".awf", "runs"), "e2e-deadline", "d");
  await until(async () => (await readAttempts(run)).at(-1)?.outcome === "parked");
  const own = async (...words: string[]) => {
    const child = Bun.spawn({
      cmd: [process.execPath, CLI, "run", file, "--id", "d", "--continue", ...words],
      cwd: root,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, text] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, text };
  };
  expect((await own("--from-stage", "nope")).code).toBe(3);
  const lines = await Bun.file(join(run.dir, "run.jsonl")).text();
  expect(lines).not.toContain('"cancelled":true');
  const next = await own();
  expect(next.code).toBe(0);
  expect(next.text).not.toContain("cancelled");
  expect((await readAttempts(run)).at(-1)?.outcome).toBe("parked");
}, 60_000);

test("a continue reads the project's .env again, and not what the sender exported", async () => {
  const { root, file, home } = eventProject(
    dirs,
    "env.ts",
    `import { appendFileSync } from "node:fs";
import { defineWorkflow } from "agentswf/workflow";
const Ping = { type: "object", properties: { n: { type: "number" } } };
export default defineWorkflow({
  meta: { name: "e2e-env", description: "Records its token at each wake." },
  file: import.meta.path,
  events: { ping: Ping },
  starts: ["ping"],
  async run(workflow) {
    for (;;) {
      const events = await workflow.receive();
      appendFileSync(new URL("../tokens.txt", import.meta.url).pathname, (process.env.TOKEN ?? "none") + "\\n");
      if (events.some((e) => e.data.n === 2)) return null;
    }
  },
});
`,
  );
  writeFileSync(join(root, ".env"), "TOKEN=first\n");
  const io = { stdout: () => undefined, stderr: () => undefined };
  const send = (n: number, environment: Record<string, string | undefined>) =>
    emitCommand(
      ["--target", file, "--id", "one", "ping", JSON.stringify({ n }), "--event-id", `p${n}`],
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
  await appendIn(run.dir, {
    at: now,
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
  const turns = await Bun.file(join(run.dir, "log.jsonl"))
    .text()
    .catch(() => "");
  expect(turns).not.toContain('"attempt":2');
  await previous.exited;
  await until(async () =>
    (
      await Bun.file(join(run.dir, "log.jsonl"))
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
      attempt: 1,
      kind: "attempt",
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
