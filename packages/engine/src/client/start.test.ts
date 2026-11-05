import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ClientError } from "@agentswf/contract/client";
import type { AttemptRecord } from "@agentswf/contract/records";
import { writeJson } from "../files";
import { appendMailbox } from "../mailbox";
import { runOperatorCli } from "../operator-cli";
import { runLockFile } from "../run-lock";
import { openRun, processStart, type Run, readAttempts } from "../runs";
import { createTempRunDirs, writeAttempt } from "../testing";
import type { Launch } from "../wake";
import { loadWorkflowFile } from "../workflow-loader";
import { clientWith } from "./index";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

const AGENTSWF = realpathSync(join(import.meta.dir, "../../../agentswf"));
const ALIVE = { pid: process.pid, processStart: processStart(process.pid)! };
const GONE = { pid: Bun.spawnSync(["true"]).pid, processStart: "2026-10-11T09:00:00Z" };

// Plain, with args: `prepare` leaves a mark if it ever runs; `fail` fails the attempt until a file
// beside it says otherwise.
const RELEASE = (major: string) => `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "release", description: "Releases a version.", version: "${major}.0.0" },
  file: import.meta.path,
  prepare: ({ argv }) => {
    writeFileSync(join(import.meta.dir, "prepared"), argv.join(" "));
    return { version: argv[0] ?? "", dryRun: argv.includes("--dry") };
  },
  run: async (wf, args) => {
    await wf.stage("built", async () => undefined);
    if (args.version === "fail" && !existsSync(join(import.meta.dir, "fixed")))
      throw new Error("the release failed");
    return { released: args.version, dryRun: args.dryRun, cwd: process.cwd() };
  },
});
`;

// With events: parks at its wait until a ping, then returns the ping's data.
const REVIEW = `import { defineWorkflow } from "agentswf/workflow";
const Ping = { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false };
export default defineWorkflow({
  meta: { name: "review", description: "Waits for a ping." },
  file: import.meta.path,
  events: { ping: Ping },
  prepare: () => ({ pr: 0 }),
  id: (args) => \`pr-\${args.pr}\`,
  run: async (wf, args) => {
    const [ping] = await wf.receive();
    return { pr: args.pr, n: ping.data.n, source: ping.source ?? null };
  },
});
`;

const STARTS = `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "starts", description: "Named by its senders." },
  file: import.meta.path,
  events: { go: { type: "object", properties: {}, additionalProperties: false } },
  starts: ["go"],
  run: async () => null,
});
`;

const TIDY = `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "tidy", description: "Takes no arguments." },
  file: import.meta.path,
  run: async () => "tidied",
});
`;

/** A project on this engine, with the workflows above in it. */
async function project() {
  const root = realpathSync(dirs.tempRunDir());
  mkdirSync(join(root, ".awf"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(AGENTSWF, join(root, "node_modules", "agentswf"));
  const files = {
    release: join(root, "release.ts"),
    review: join(root, "review.ts"),
    starts: join(root, "starts.ts"),
    tidy: join(root, "tidy.ts"),
  };
  writeFileSync(files.release, RELEASE("1"));
  writeFileSync(files.review, REVIEW);
  writeFileSync(files.starts, STARTS);
  writeFileSync(files.tidy, TIDY);
  const load = async (file: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: a workflow of any args and events.
    (await loadWorkflowFile(file, dirname(file))).workflow as any;
  return {
    root,
    home: realpathSync(dirs.tempRunDir()),
    files,
    runRoot: join(root, ".awf", "runs"),
    release: await load(files.release),
    review: await load(files.review),
    starts: await load(files.starts),
    tidy: await load(files.tidy),
  };
}
type Project = Awaited<ReturnType<typeof project>>;

function fakeLaunch(): Launch & { launched: string[] } {
  const launched: string[] = [];
  const launch = (async (run: Run, file: string) => {
    launched.push(run.record.id);
    await writeAttempt(run, { ...ALIVE, file });
  }) as Launch & { launched: string[] };
  launch.launched = launched;
  return launch;
}
const failing: Launch = async () => {
  throw new Error("the attempt exited before it started");
};

const runsOf = (p: Project, launch?: Launch) =>
  clientWith({
    home: p.home,
    environment: { ...process.env, PATH: process.env.PATH ?? "" },
    pollMs: 50,
    ...(launch ? { launch } : {}),
  });

const ended = (outcome: AttemptRecord["outcome"]) => ({
  ...GONE,
  ended: new Date().toISOString(),
  outcome,
});

/** Rewrites a run's last attempt to the state given. */
async function lastAttempt(run: Run, fields: Partial<AttemptRecord>): Promise<void> {
  const attempts = await readAttempts(run);
  const last = attempts.at(-1)!;
  await writeJson(join(run.dir, "attempts", `${last.attempt}.json`), { ...last, ...fields });
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error) => (error instanceof ClientError ? error.code : `not a ClientError: ${error}`),
  );

describe("start, by its rules", () => {
  test("a new id is started; the same args, in any key order, are exists; other args are other-args", async () => {
    const p = await project();
    const launch = fakeLaunch();
    const runs = runsOf(p, launch);
    const first = await runs.start(p.release, { version: "1.4.0", dryRun: false }, { id: "v1" });
    expect(first.did).toBe("started");
    expect(first.run.ref).toBe("release/v1");
    const again = await runs.start(p.release, { dryRun: false, version: "1.4.0" }, { id: "v1" });
    expect(again.did).toBe("exists");
    expect(launch.launched).toEqual(["v1"]);
    expect(
      await code(runs.start(p.release, { version: "1.4.0", dryRun: true }, { id: "v1" })),
    ).toBe("other-args");
    // The record: awf run's, with its args, PATH, file and project, at the new version.
    const run = await openRun(p.runRoot, "release", "v1");
    expect(run.record).toMatchObject({
      version: 2,
      id: "v1",
      workflow: "release",
      argv: [],
      args: { version: "1.4.0", dryRun: false },
      cwd: p.root,
      sandbox: null,
      env: { PATH: process.env.PATH ?? "" },
      file: p.files.release,
    });
    expect(run.record.events).toBeUndefined();
    expect(readFileSync(join(p.home, ".awf", "projects"), "utf8")).toContain(p.root);
    expect(existsSync(join(p.root, "prepared"))).toBe(false);
  });

  test("a no-args workflow started twice by id is exists, its args null", async () => {
    const p = await project();
    const runs = runsOf(p, fakeLaunch());
    expect((await runs.start(p.tidy, null, { id: "t" })).did).toBe("started");
    expect((await runs.start(p.tidy, null, { id: "t" })).did).toBe("exists");
    expect((await openRun(p.runRoot, "tidy", "t")).record).toMatchObject({
      version: 2,
      args: null,
    });
  });

  test("ids: id(args) names it; a workflow with starts and no id() is no-id; else one is generated", async () => {
    const p = await project();
    const runs = runsOf(p, fakeLaunch());
    expect((await runs.start(p.review, { pr: 7 })).run.id).toBe("pr-7");
    expect(await code(runs.start(p.starts, null))).toBe("no-id");
    const generated = await runs.start(p.tidy, null);
    expect(generated.did).toBe("started");
    expect(generated.run.id).toMatch(/^\d{8}-\d{4}-[0-9a-f]{4}$/);
    expect(await code(runs.start(p.tidy, null, { id: "Bad Id" }))).toBe("id");
  });

  test("a run begun by an event, or by awf run with argv, is other-args; get reaches it", async () => {
    const p = await project();
    const runs = runsOf(p, fakeLaunch());
    await runs.emit(p.review, "pr-1", "ping", { n: 1 });
    expect(await code(runs.start(p.review, { pr: 1 }, { id: "pr-1" }))).toBe("other-args");
    expect((await runs.get(p.review, "pr-1")).ref).toBe("review/pr-1");
    expect(await code(runs.get(p.review, "pr-2"))).toBe("no-run");
  });

  test("a launch that fails is launch-failed, and a second start launches it: exists", async () => {
    const p = await project();
    const failed = await runsOf(p, failing).start(p.tidy, null, { id: "t" });
    expect(failed).toMatchObject({
      did: "launch-failed",
      error: expect.stringContaining("exited"),
    });
    // Interrupted at once, not running for the minute an attempt is given to claim it.
    expect(await failed.run.status()).toEqual({ state: "interrupted", final: true });
    expect(await failed.run.wait()).toMatchObject({ state: "interrupted" });
    const launch = fakeLaunch();
    expect((await runsOf(p, launch).start(p.tidy, null, { id: "t" })).did).toBe("exists");
    expect(launch.launched).toEqual(["t"]);
  });

  test(`a launch that fails three times is stuck, and a start then launches nothing`, async () => {
    const p = await project();
    for (let i = 0; i < 3; i++) await runsOf(p, failing).start(p.tidy, null, { id: "t" });
    const launch = fakeLaunch();
    const stuck = await runsOf(p, launch).start(p.tidy, null, { id: "t" });
    expect(stuck.did).toBe("stuck");
    expect(launch.launched).toEqual([]);
    expect(await stuck.run.status()).toMatchObject({ state: "stuck", final: true });
  });

  test("a live sender relaunching holds a run with no attempt at running; a dead one doesn't", async () => {
    const p = await project();
    const { run } = await runsOf(p, failing).start(p.tidy, null, { id: "t" });
    const lock = runLockFile(p.runRoot, "tidy", "t");
    writeFileSync(lock, JSON.stringify({ ...ALIVE, at: new Date().toISOString() }));
    expect(await run.status()).toMatchObject({ state: "running", final: false });
    // A final wait doesn't resolve while it is held.
    const controller = new AbortController();
    const waiting = run.wait({ final: true, signal: controller.signal });
    await Bun.sleep(200);
    controller.abort(new Error("gave up"));
    await expect(waiting).rejects.toThrow("gave up");
    writeFileSync(lock, JSON.stringify({ ...GONE, at: new Date().toISOString() }));
    expect(await run.status()).toMatchObject({ state: "interrupted", final: true });
  });

  test("the file's default export must be the value given; a plain file that isn't its path is refused", async () => {
    const p = await project();
    const runs = runsOf(p, fakeLaunch());
    expect(await code(runs.start({ ...p.tidy }, null))).toBe("file");
    writeFileSync(
      join(p.root, "elsewhere.ts"),
      TIDY.replace("file: import.meta.path", `file: ${JSON.stringify(p.files.tidy)}`),
    );
    await expect(loadWorkflowFile(join(p.root, "elsewhere.ts"), p.root)).rejects.toThrow(
      "a workflow gives file: import.meta.path",
    );
  });
});

describe("wait, read from the attempt records", () => {
  test("at a park, at a crash, and at a park a wake continued before the next poll", async () => {
    const p = await project();
    const runs = runsOf(p, fakeLaunch());
    const { run } = await runs.start(p.review, { pr: 1 });
    const record = await openRun(p.runRoot, "review", "pr-1");
    const parked = run.wait();
    await Bun.sleep(80);
    await lastAttempt(record, ended("parked"));
    expect(await parked).toMatchObject({ state: "parked", final: false });

    // Running again; then gone without an ending.
    await writeAttempt(record, { ...ALIVE });
    const crashed = run.wait();
    await Bun.sleep(80);
    await lastAttempt(record, { ...GONE });
    expect(await crashed).toMatchObject({ state: "interrupted", final: false });

    // Parked and continued between two polls: running both times, and still a rest.
    await writeAttempt(record, { ...ALIVE });
    const missed = run.wait();
    await Bun.sleep(20);
    await lastAttempt(record, ended("parked"));
    await writeAttempt(record, { ...ALIVE });
    expect(await missed).toMatchObject({ state: "parked", final: false });
  });

  test("a final wait goes on across a park and a failure a wake continues, and resolves stuck", async () => {
    const p = await project();
    const { run } = await runsOf(p, fakeLaunch()).start(p.review, { pr: 1 });
    const record = await openRun(p.runRoot, "review", "pr-1");
    let resolved = false;
    const final = run.wait({ final: true }).then((status) => {
      resolved = true;
      return status;
    });
    await lastAttempt(record, ended("parked"));
    await Bun.sleep(120);
    await writeAttempt(record, ended("failed"));
    await Bun.sleep(120);
    expect(resolved).toBe(false);
    await writeAttempt(record, ended("failed"));
    await writeAttempt(record, ended("failed"));
    expect(await final).toMatchObject({ state: "stuck", final: true });
  });

  test("a plain run's failure is final; an aborted signal rejects with its reason", async () => {
    const p = await project();
    const { run } = await runsOf(p, fakeLaunch()).start(p.tidy, null, { id: "t" });
    const record = await openRun(p.runRoot, "tidy", "t");
    const controller = new AbortController();
    const aborted = run.wait({ final: true, signal: controller.signal });
    controller.abort(new Error("the webhook timed out"));
    await expect(aborted).rejects.toThrow("the webhook timed out");
    const final = run.wait({ final: true });
    await lastAttempt(record, ended("failed"));
    expect(await final).toMatchObject({ state: "failed", final: true });
  });

  test("a second program gets the run by workflow and id and reads the same status", async () => {
    const p = await project();
    const { run } = await runsOf(p, fakeLaunch()).start(p.tidy, null, { id: "t" });
    const other = await runsOf(p).get(p.tidy, "t");
    expect(await other.status()).toEqual(await run.status());
  });
});

describe("runs started from code, for real", () => {
  test("a plain run completes with its args, prepare never run, and fails; awf run --continue from elsewhere continues it", async () => {
    const p = await project();
    const runs = runsOf(p);
    const started = await runs.start(p.release, { version: "1.4.0", dryRun: true }, { id: "v1" });
    expect(started.did).toBe("started");
    const done = await started.run.wait({ final: true });
    expect(done).toMatchObject({
      state: "completed",
      final: true,
      ending: { kind: "completed", value: { released: "1.4.0", dryRun: true, cwd: p.root } },
    });
    expect(existsSync(join(p.root, "prepared"))).toBe(false);

    const failing = await runs.start(p.release, { version: "fail", dryRun: false }, { id: "v2" });
    const failed = await failing.run.wait({ final: true });
    expect(failed).toMatchObject({ state: "failed", final: true, ending: { kind: "failed" } });
    const failedEnding = failed.ending as { continue: string };
    expect(failedEnding.continue).toBe(`awf run ${p.files.release} --id v2 --continue`);
    // Not continued by start, nor by tick.
    expect(
      (await runs.start(p.release, { version: "fail", dryRun: false }, { id: "v2" })).did,
    ).toBe("exists");
    writeFileSync(join(p.root, "fixed"), "");
    const elsewhere = realpathSync(dirs.tempRunDir());
    const out: string[] = [];
    const exit = await runOperatorCli(
      ["run", p.files.release, "--id", "v2", "--continue", "--json"],
      { cwd: elsewhere, home: p.home, stdout: (text) => out.push(text), stderr: () => {} },
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out.join("")).value).toMatchObject({ released: "fail" });
    expect(existsSync(join(p.root, "prepared"))).toBe(false);
    // Found by awf runs from elsewhere.
    const listed: string[] = [];
    await runOperatorCli(["runs", "release/v2", "--json"], {
      cwd: elsewhere,
      home: p.home,
      stdout: (text) => listed.push(text),
      stderr: () => {},
    });
    expect(JSON.parse(listed.join("")).run.state).toBe("completed");
  }, 60_000);

  test("an event run parks at its wait and an event continues it, its source with it", async () => {
    const p = await project();
    const runs = runsOf(p);
    const started = await runs.start(p.review, { pr: 3 });
    expect(started.did).toBe("started");
    expect(await started.run.wait()).toMatchObject({ state: "parked", final: false });
    await runs.emit(p.review, "pr-3", "ping", { n: 9 }, { source: "github" });
    expect(await started.run.wait({ final: true })).toMatchObject({
      state: "completed",
      ending: { kind: "completed", value: { pr: 3, n: 9, source: "github" } },
    });
  }, 60_000);

  test("awf run of a plain workflow with file keeps --from-stage, --timeout and --cwd, its runs in the project", async () => {
    const p = await project();
    const elsewhere = realpathSync(dirs.tempRunDir());
    const out: string[] = [];
    const exit = await runOperatorCli(
      [
        "run",
        p.files.release,
        "--id",
        "c1",
        "--timeout",
        "5m",
        "--cwd",
        elsewhere,
        "--json",
        "--",
        "2.0.0",
      ],
      { cwd: elsewhere, home: p.home, stdout: (text) => out.push(text), stderr: () => {} },
    );
    expect(exit).toBe(0);
    expect(JSON.parse(out.join("")).value).toMatchObject({ released: "2.0.0" });
    const run = await openRun(p.runRoot, "release", "c1");
    expect(run.record).toMatchObject({ version: 1, argv: ["2.0.0"], cwd: elsewhere });
    const again: string[] = [];
    const redo = await runOperatorCli(
      ["run", p.files.release, "--id", "c1", "--continue", "--from-stage", "built", "--json"],
      { cwd: elsewhere, home: p.home, stdout: (text) => again.push(text), stderr: () => {} },
    );
    expect(redo).toBe(0);
  }, 60_000);

  test("a continue across a major meta.version stops a plain run, at the stage the older one recorded", async () => {
    const p = await project();
    const { run } = await runsOf(p).start(
      p.release,
      { version: "fail", dryRun: false },
      { id: "v" },
    );
    expect(await run.wait({ final: true })).toMatchObject({ state: "failed" });
    // Fixed, so only the version stops it: its "built" record is major 1's.
    writeFileSync(join(p.root, "fixed"), "");
    writeFileSync(p.files.release, RELEASE("2"));
    // In a process of its own: this one holds the file's major-1 module.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "../operator-cli.ts"),
        "run",
        p.files.release,
        "--id",
        "v",
        "--continue",
      ],
      cwd: p.root,
      env: { ...process.env, HOME: p.home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(stderr).toContain("built was recorded by 1.0.0; this is 2.0.0");
    expect(exit).not.toBe(0);
    expect(await run.status()).not.toMatchObject({ state: "completed" });
  }, 60_000);

  test("a plain start returns once its attempt has claimed the run, not after a socket wait", async () => {
    const p = await project();
    writeFileSync(
      join(p.root, "slow.ts"),
      TIDY.replace('name: "tidy"', 'name: "slow"').replace(
        'run: async () => "tidied"',
        'run: async () => { await Bun.sleep(4000); return "slept"; }',
      ),
    );
    // biome-ignore lint/suspicious/noExplicitAny: a workflow of no args.
    const slow = (await loadWorkflowFile(join(p.root, "slow.ts"), p.root)).workflow as any;
    const began = Date.now();
    const { run } = await runsOf(p).start(slow, null, { id: "s" });
    // A socket wait would hold the start 5 s past the claim: the run, alive, opens none.
    expect(Date.now() - began).toBeLessThan(3_500);
    expect(await run.wait({ final: true })).toMatchObject({ state: "completed" });
  }, 60_000);
});

test("a stale run with no attempt and a launch-failed, past its lock's holder", async () => {
  const p = await project();
  const { run } = await runsOf(p, fakeLaunch()).start(p.tidy, null, { id: "t" });
  const record = await openRun(p.runRoot, "tidy", "t");
  await appendMailbox(record.dir, {
    version: 1,
    at: new Date().toISOString(),
    kind: "launch-failed",
    reason: "x",
  });
  // An attempt exists: the launch-failed before it counts for nothing.
  expect((await run.status()).state).toBe("running");
});

test("a plain run whose continues failed three times is failed, not stuck", async () => {
  const p = await project();
  const { run } = await runsOf(p, fakeLaunch()).start(p.tidy, null, { id: "t" });
  const record = await openRun(p.runRoot, "tidy", "t");
  await lastAttempt(record, ended("failed"));
  await writeAttempt(record, ended("failed"));
  await writeAttempt(record, ended("failed"));
  expect(await run.status()).toMatchObject({ state: "failed", final: true });
});

test("prepare: an id(args) that throws, or a starting event whose prepare refuses no argv; project: a workflow directly in home", async () => {
  const p = await project();
  const runs = runsOf(p, fakeLaunch());
  writeFileSync(
    join(p.root, "thrower.ts"),
    REVIEW.replace('name: "review"', 'name: "thrower"').replace(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's source, replaced.
      "id: (args) => `pr-${args.pr}`",
      'id: () => { throw new Error("no pr"); }',
    ),
  );
  // biome-ignore lint/suspicious/noExplicitAny: a workflow of any args.
  const thrower = (await loadWorkflowFile(join(p.root, "thrower.ts"), p.root)).workflow as any;
  expect(await code(runs.start(thrower, { pr: 1 }))).toBe("prepare");
  writeFileSync(
    join(p.root, "needs.ts"),
    `import { defineWorkflow } from "agentswf/workflow";
export default defineWorkflow({
  meta: { name: "needs", description: "Needs an argument." },
  file: import.meta.path,
  events: { go: { type: "object", properties: {}, additionalProperties: false } },
  prepare: ({ argv }) => { if (!argv[0]) throw new Error("a ticket"); return { ticket: argv[0] }; },
  run: async () => null,
});
`,
  );
  // biome-ignore lint/suspicious/noExplicitAny: a workflow of any args.
  const needs = (await loadWorkflowFile(join(p.root, "needs.ts"), p.root)).workflow as any;
  expect(await code(runs.emit(needs, "n", "go", {}))).toBe("prepare");
  // Directly in home, where awf keeps its own .awf.
  writeFileSync(
    join(p.home, "flow.ts"),
    TIDY.replace('"agentswf/workflow"', JSON.stringify(join(AGENTSWF, "src/workflow.ts"))),
  );
  const inHome = // biome-ignore lint/suspicious/noExplicitAny: a workflow of no args.
    (await loadWorkflowFile(join(p.home, "flow.ts"), p.home, dirs.tempRunDir())).workflow as any;
  expect(await code(clientWith({ home: p.home }).start(inHome, null))).toBe("project");
});

test("a run awf run started with argv is other-args to start; a run an event began stays at today's version", async () => {
  const p = await project();
  expect(
    await runOperatorCli(["run", p.files.release, "--id", "cli", "--json", "--", "3.0.0"], {
      cwd: p.root,
      home: p.home,
      stdout: () => {},
      stderr: () => {},
    }),
  ).toBe(0);
  const runs = runsOf(p, fakeLaunch());
  expect(
    await code(runs.start(p.release, { version: "3.0.0", dryRun: false }, { id: "cli" })),
  ).toBe("other-args");
  await runs.emit(p.review, "pr-9", "ping", { n: 1 });
  const emitted = (await openRun(p.runRoot, "review", "pr-9")).record;
  expect(emitted).toMatchObject({ version: 1, events: true });
  expect(emitted.args).toBeUndefined();
  await runs.start(p.review, { pr: 8 });
  expect((await openRun(p.runRoot, "review", "pr-8")).record).toMatchObject({
    version: 2,
    events: true,
    args: { pr: 8 },
    argv: [],
  });
});
