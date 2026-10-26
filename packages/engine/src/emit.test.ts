import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptRecord, RunsJson, TickResultJson } from "@agentswf/contract/records";
import type { OutputSchema } from "@agentswf/contract/workflow";
import { EmitError, type EmitTarget, emitEvent } from "./emit";
import { emitCommand } from "./emit-command";
import { writeJson } from "./files";
import { keyLockFile, withKeyLock } from "./key-lock";
import { appendMailbox, foldMailbox, readMailbox } from "./mailbox";
import { listProjects, projectOf } from "./projects";
import { createRun, openRun, processStart, type Run, readAttempts } from "./runs";
import { runsCommand } from "./runs-command";
import { createTempRunDirs } from "./testing";
import { tickCommand } from "./tick-command";
import { attemptEnvironment, type Launch, STUCK_AFTER, wake } from "./wake";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

const Changes: OutputSchema<{ case: string }> = {
  type: "object",
  properties: { case: { type: "string" } },
  required: ["case"],
};
const Closed: OutputSchema<{ case: string }> = Changes;

/** A project holding `.awf/`, a workflow file in it, and a home for `~/.awf/projects`. */
function project() {
  const root = dirs.tempRunDir();
  mkdirSync(join(root, ".awf"));
  mkdirSync(join(root, "flows"));
  const file = join(root, "flows", "case.ts");
  writeFileSync(file, "// the target; its definition is given to emitEvent directly\n");
  const home = dirs.tempRunDir();
  const target: EmitTarget = {
    file,
    definition: {
      meta: { name: "dd-case", description: "A case." },
      file,
      events: { "dd.changes": Changes, "dd.closed": Closed },
      key: (e) => (e.data as { case: string }).case,
      starts: ["dd.changes"],
      run: async () => null,
    },
  };
  return { root, home, file, target, runRoot: join(root, ".awf", "runs") };
}

const ALIVE = { pid: process.pid, processStart: processStart(process.pid)! };
const GONE = { pid: Bun.spawnSync(["true"]).pid, processStart: "2026-10-11T09:00:00Z" };

/** A launch that claims the attempt as `awf run --continue` would, and counts the launches. */
function fakeLaunch(): Launch & { launched: string[] } {
  const launched: string[] = [];
  const launch = (async (run: Run, file: string) => {
    launched.push(file);
    await attempt(run, { ...ALIVE });
  }) as Launch & { launched: string[] };
  launch.launched = launched;
  return launch;
}

async function attempt(run: Run, fields: Partial<AttemptRecord>): Promise<void> {
  const n = (await readAttempts(run)).length + 1;
  mkdirSync(join(run.dir, "attempts"), { recursive: true });
  await writeJson(join(run.dir, "attempts", `${n}.json`), {
    version: 1,
    attempt: n,
    file: "/flows/case.ts",
    flags: {},
    ...GONE,
    started: new Date().toISOString(),
    ...fields,
  });
}

function emit(
  p: ReturnType<typeof project>,
  name: string,
  data: unknown,
  extra: { id?: string; launch?: Launch; nudge?: (run: Run) => Promise<boolean> } = {},
) {
  const { launch, nudge, id } = extra;
  return emitEvent(
    p.target,
    { name, data: data as never, ...(id === undefined ? {} : { id }) },
    {
      from: "operator",
      home: p.home,
      environment: { PATH: "/usr/bin:/bin" },
      ...(launch ? { launch } : {}),
      ...(nudge ? { nudge } : {}),
    },
  );
}

const runOf = (p: ReturnType<typeof project>, key: string) =>
  openRun(p.runRoot, "dd-case", `dd-case.${key}`);
const eventsOf = async (run: Run) =>
  [...foldMailbox(await readMailbox(run.dir)).events.values()].map((e) => e.id);

describe("outcomes", () => {
  test("a starting event with no run starts one in the file's project, recorded once", async () => {
    const p = project();
    const launch = fakeLaunch();
    expect(await emit(p, "dd.changes", { case: "kombo" }, { id: "c1", launch })).toEqual({
      v: 1,
      outcome: "accepted",
      run: "dd-case/dd-case.kombo",
      id: "c1",
      did: "started",
    });
    const run = await runOf(p, "kombo");
    expect(run.record).toMatchObject({
      key: "kombo",
      cwd: realpathSync(p.root),
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(launch.launched).toEqual([p.file]);
    expect(await listProjects(p.home)).toEqual([realpathSync(p.root)]);
  });

  test("a repeated id is a duplicate, in any state, and is not appended", async () => {
    const p = project();
    const launch = fakeLaunch();
    await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch });
    const again = await emit(
      p,
      "dd.changes",
      { case: "k" },
      { id: "c1", launch, nudge: async () => true },
    );
    // Not appended; a live run has it already, so it isn't nudged for it.
    expect(again).toMatchObject({ outcome: "duplicate", did: "none" });
    expect(await eventsOf(await runOf(p, "k"))).toEqual(["c1"]);
  });

  test("no run and not a starting event, or a run that returned: refused, not appended", async () => {
    const p = project();
    expect(await emit(p, "dd.closed", { case: "k" })).toMatchObject({
      outcome: "refused",
      did: "none",
      why: "not-a-start",
    });
    const launch = fakeLaunch();
    await emit(p, "dd.changes", { case: "done" }, { id: "c1", launch });
    const run = await runOf(p, "done");
    await writeJson(join(run.dir, "attempts", "1.json"), {
      ...(await readAttempts(run))[0],
      ...GONE,
      ended: new Date().toISOString(),
      outcome: "completed",
    });
    expect(await emit(p, "dd.changes", { case: "done" }, { id: "c2", launch })).toMatchObject({
      outcome: "refused",
      why: "returned",
    });
    expect(await eventsOf(run)).toEqual(["c1"]);
  });

  test("without an id, awf makes one and nothing deduplicates it", async () => {
    const p = project();
    const launch = fakeLaunch();
    const first = await emit(p, "dd.changes", { case: "k" }, { launch });
    const second = await emit(p, "dd.changes", { case: "k" }, { launch, nudge: async () => true });
    expect(first.id).toMatch(/^awf\.[0-9a-f]{16}$/);
    expect(second.outcome).toBe("accepted");
    expect(await eventsOf(await runOf(p, "k"))).toEqual([first.id, second.id]);
  });

  test.each([
    ["an undeclared name", "dd.opened", { case: "k" }, {}, "declares no event dd.opened"],
    ["a colon", "agent:ended", { case: "k" }, {}, "a name with a colon is awf's own"],
    ["data its schema refuses", "dd.changes", { other: 1 }, {}, "does not fit its schema"],
    ["an id outside the grammar", "dd.changes", { case: "k" }, { id: "Abc" }, "the id"],
    ["an id of awf's", "dd.changes", { case: "k" }, { id: "awf.x" }, "are awf's own"],
    ["a key outside the grammar", "dd.changes", { case: "K" }, {}, 'the key "K"'],
  ])("%s is an error, not an outcome", async (_what, name, data, extra, message) => {
    const p = project();
    const error = await emit(p, name, data, extra).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmitError);
    expect(String(error)).toContain(message);
  });

  test("a definition with events and no file is refused", async () => {
    const p = project();
    const { file: _file, ...definition } = p.target.definition;
    const error = await emitEvent(
      { file: p.file, definition: definition as EmitTarget["definition"] },
      { name: "dd.changes", data: { case: "k" } },
      { from: "operator", home: p.home, environment: {} },
    ).catch((caught: unknown) => caught);
    expect(String(error)).toContain("gives file: import.meta.path");
  });
});

describe("wake, from an emit", () => {
  /** A run with one attempt in the state given, for the next emit to wake. */
  async function runIn(fields: Partial<AttemptRecord>[]) {
    const p = project();
    const launch = fakeLaunch();
    await emit(p, "dd.changes", { case: "k" }, { id: "c0", launch });
    const run = await runOf(p, "k");
    const [first] = await readAttempts(run);
    // The started attempt, rewritten as the state wanted, then any more.
    const [head, ...rest] = fields;
    await writeJson(join(run.dir, "attempts", "1.json"), { ...first, ...head });
    for (const each of rest) await attempt(run, each);
    launch.launched.length = 0;
    return { p, run, launch };
  }
  const ended = (outcome: AttemptRecord["outcome"]) => ({
    ...GONE,
    ended: new Date().toISOString(),
    outcome,
  });

  test("live: nudged; a nudge that fails isn't an error, and the event is kept", async () => {
    const { p, run, launch } = await runIn([{ ...ALIVE }]);
    expect(
      await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch, nudge: async () => true }),
    ).toMatchObject({ did: "nudged" });
    expect(
      await emit(p, "dd.changes", { case: "k" }, { id: "c2", launch, nudge: async () => false }),
    ).toMatchObject({
      outcome: "accepted",
      did: "none",
      why: "nudge-failed",
    });
    expect(await eventsOf(run)).toEqual(["c0", "c1", "c2"]);
    expect(launch.launched).toEqual([]);
  });

  test("parked: continued, as an event is now unacknowledged", async () => {
    const { p, launch } = await runIn([ended("parked")]);
    expect(await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch })).toMatchObject({
      did: "continued",
    });
    expect(launch.launched).toEqual([p.file]);
  });

  test("crashed, or failed under the limit: continued", async () => {
    for (const state of [{ ...GONE }, ended("failed")]) {
      const { p, launch } = await runIn([state]);
      expect(await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch })).toMatchObject({
        did: "continued",
      });
    }
  });

  test(`failed or crashed ${STUCK_AFTER} in a row: stuck, the event only appended; a parked ending resets it`, async () => {
    const { p, run, launch } = await runIn([ended("failed"), { ...GONE }, ended("failed")]);
    expect(await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch })).toMatchObject({
      outcome: "accepted",
      did: "none",
      why: "stuck",
    });
    expect(await eventsOf(run)).toContain("c1");
    const reset = await runIn([ended("failed"), ended("failed"), ended("parked"), ended("failed")]);
    expect(
      await emit(reset.p, "dd.changes", { case: "k" }, { id: "c1", launch: reset.launch }),
    ).toMatchObject({ did: "continued" });
  });

  test("stopped or cancelled: nothing, for the operator to continue", async () => {
    for (const outcome of ["stopped", "cancelled"] as const) {
      const { p, launch } = await runIn([ended(outcome)]);
      expect(await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch })).toMatchObject({
        outcome: "accepted",
        did: "none",
        why: outcome,
      });
      expect(launch.launched).toEqual([]);
    }
  });
});

describe("a launch that never claims an attempt", () => {
  test("is an accepted event that woke nothing, recorded, and counted toward stuck", async () => {
    const p = project();
    const failing: Launch = async () => {
      throw new Error("SyntaxError in case.ts");
    };
    const first = await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch: failing });
    expect(first).toMatchObject({
      outcome: "accepted",
      did: "none",
      why: "launch-failed",
      error: "SyntaxError in case.ts",
    });
    for (const id of ["c2", "c3"])
      await emit(p, "dd.changes", { case: "k" }, { id, launch: failing });
    // Three failed launches in a row: the run is stuck, and the event only appended.
    const launch = fakeLaunch();
    expect(await emit(p, "dd.changes", { case: "k" }, { id: "c4", launch })).toMatchObject({
      outcome: "accepted",
      why: "stuck",
    });
    expect(launch.launched).toEqual([]);
    const run = await runOf(p, "k");
    expect(run.record.file).toBe(p.file);
    expect(await eventsOf(run)).toEqual(["c1", "c2", "c3", "c4"]);
  });
});

test("an attempt gets who and where the engineer is and the recorded PATH; .env gives the rest", () => {
  const run = { record: { env: { PATH: "/recorded" } } } as Run;
  expect(
    attemptEnvironment(
      {
        HOME: "/home/e",
        USER: "e",
        LC_ALL: "C",
        PATH: "/sender",
        ANTHROPIC_API_KEY: "sk-sender",
        AWF_HERDR_SESSION: "other",
      },
      run,
    ),
  ).toEqual({
    HOME: "/home/e",
    USER: "e",
    LC_ALL: "C",
    AWF_HERDR_SESSION: "other",
    PATH: "/recorded",
  });
});

describe("the key's lock", () => {
  test("two events for one key at once start one run, and the other lands in its mailbox", async () => {
    const p = project();
    const launch = fakeLaunch();
    const nudge = async () => true;
    const results = await Promise.all([
      emit(p, "dd.changes", { case: "k" }, { id: "a", launch, nudge }),
      emit(p, "dd.changes", { case: "k" }, { id: "b", launch, nudge }),
    ]);
    expect(results.map((r) => r.did).sort()).toEqual(["nudged", "started"]);
    expect(launch.launched).toHaveLength(1);
    expect((await eventsOf(await runOf(p, "k"))).sort()).toEqual(["a", "b"]);
  });

  test("a lock a killed process left is taken over", async () => {
    const p = project();
    const file = keyLockFile(p.runRoot, "dd-case", "dd-case.k");
    mkdirSync(join(p.runRoot, "dd-case"), { recursive: true });
    await writeJson(file, { ...GONE, at: new Date().toISOString() });
    const started = Date.now();
    expect(await withKeyLock(file, async () => "held")).toBe("held");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a live holder is waited for, and a waiter in the same process queues", async () => {
    const file = join(dirs.tempRunDir(), "x.lock");
    const order: string[] = [];
    await Promise.all([
      withKeyLock(file, async () => {
        order.push("a in");
        await Bun.sleep(30);
        order.push("a out");
      }),
      withKeyLock(file, async () => {
        order.push("b in");
      }),
    ]);
    expect(order).toEqual(["a in", "a out", "b in"]);
  });
});

describe("awf emit", () => {
  test("prints what became of the event and what wake did; an error for the target exits 2", async () => {
    const p = project();
    writeFileSync(
      p.file,
      [
        'import { defineEventWorkflow } from "agentswf/workflow";',
        'const Changes = { type: "object", properties: { case: { type: "string" } }, required: ["case"] };',
        "export default defineEventWorkflow({ definition: {",
        '  meta: { name: "dd-case", description: "A case." }, file: import.meta.path,',
        '  events: { "dd.changes": Changes }, key: (e) => e.data.case, starts: ["dd.changes"],',
        "  run: async () => null } });",
      ].join("\n"),
    );
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
    const context = { home: p.home, environment: { PATH: "/bin" }, launch: fakeLaunch() };
    expect(
      await emitCommand(
        ["--target", p.file, "dd.changes", '{"case":"k"}', "--id", "c1"],
        p.root,
        io,
        context,
      ),
    ).toBe(0);
    expect(
      await emitCommand(
        ["--target", p.file, "dd.changes", '{"case":"k"}', "--id", "c1"],
        p.root,
        io,
        context,
      ),
    ).toBe(0);
    expect(out).toEqual(["accepted dd-case/dd-case.k: started", "duplicate dd-case/dd-case.k"]);
    expect(
      await emitCommand(["--target", p.file, "dd.changes", '{"case":1}'], p.root, io, context),
    ).toBe(2);
    expect(err.at(-1)).toContain("does not fit its schema");
    out.length = 0;
    expect(
      await emitCommand(
        ["--target", p.file, "dd.changes", '{"case":"j"}', "--json"],
        p.root,
        io,
        context,
      ),
    ).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ v: 1, outcome: "accepted", did: "started" });
  });
});

describe("wake, directly", () => {
  test("parked: continued once its until has passed, else nothing due", async () => {
    const p = project();
    const launch = fakeLaunch();
    await emit(p, "dd.changes", { case: "k" }, { id: "c0", launch });
    const run = await runOf(p, "k");
    const [first] = await readAttempts(run);
    await writeJson(join(run.dir, "attempts", "1.json"), {
      ...first,
      ...GONE,
      ended: new Date().toISOString(),
      outcome: "parked",
    });
    const until = Date.parse("2026-10-25T12:00:00Z");
    await appendMailbox(run.dir, {
      version: 1,
      at: new Date().toISOString(),
      kind: "wait",
      attempt: 1,
      until: new Date(until).toISOString(),
    });
    await appendMailbox(run.dir, {
      version: 1,
      at: new Date().toISOString(),
      kind: "took",
      attempt: 1,
      ids: ["c0"],
    });
    await appendMailbox(run.dir, {
      version: 1,
      at: new Date().toISOString(),
      kind: "wait",
      attempt: 1,
      until: new Date(until).toISOString(),
    });
    launch.launched.length = 0;
    const context = { home: p.home, environment: {}, launch };
    expect(await wake(run, { ...context, now: () => until - 1 })).toEqual({
      did: "none",
      why: "nothing-due",
    });
    expect(await wake(run, { ...context, now: () => until })).toEqual({
      did: "continued",
      cause: "until",
    });
    // No file named: the last attempt's.
    expect(launch.launched).toEqual(["/flows/case.ts"]);
  });
});

describe("refusals before a run", () => {
  const write = (body: string) => {
    const p = project();
    writeFileSync(
      p.file,
      `import { defineEventWorkflow } from "agentswf/workflow";\nexport default defineEventWorkflow({ definition: ${body} });\n`,
    );
    return p;
  };
  const base = (over: string) =>
    `{ meta: { name: "dd-case", description: "A case." }, file: import.meta.path, events: { "dd.changes": { type: "object", properties: {} } }, key: (e) => "k", starts: ["dd.changes"], run: async () => null, ${over} }`;

  test.each([
    ['meta: { name: "dd.case", description: "x" }', 'has a "."'],
    [
      'events: { "dd:changes": { type: "object", properties: {} } }, starts: ["dd:changes"]',
      "has a colon",
    ],
    ['key: "k"', "has key(event)"],
    ["starts: []", "starts lists the events"],
    ['starts: ["dd.opened"]', "starts lists the events"],
    ['file: "/elsewhere/case.ts"', "gives file: import.meta.path"],
  ])("a definition with %s is refused at load", async (over, message) => {
    const p = write(base(over));
    const err: string[] = [];
    const io = { stdout: () => undefined, stderr: (t: string) => err.push(t) };
    const code = await emitCommand(["--target", p.file, "dd.changes", "{}"], p.root, io, {
      home: p.home,
      environment: {},
      launch: fakeLaunch(),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(message);
  });

  test("awf emit exits 1, saying why, when the attempt doesn't start; the event is kept", async () => {
    const p = write(base(""));
    const err: string[] = [];
    const out: string[] = [];
    const code = await emitCommand(
      ["--target", p.file, "dd.changes", "{}", "--id", "c1"],
      p.root,
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
      {
        home: p.home,
        environment: {},
        launch: async () => {
          throw new Error("it broke");
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toEqual(["accepted dd-case/dd-case.k: launch-failed"]);
    expect(err).toEqual(["awf: the run's attempt did not start: it broke"]);
    expect(await eventsOf(await runOf(p, "k"))).toEqual(["c1"]);
  });

  test("a project is never awf's own ~/.awf: with no .awf nearer, the file's directory", async () => {
    const home = dirs.tempRunDir();
    mkdirSync(join(home, ".awf"));
    mkdirSync(join(home, "work"));
    expect(await projectOf(join(home, "work", "case.ts"), home)).toBe(
      realpathSync(join(home, "work")),
    );
    mkdirSync(join(home, "work", ".awf"));
    mkdirSync(join(home, "work", "flows"));
    expect(await projectOf(join(home, "work", "flows", "case.ts"), home)).toBe(
      realpathSync(join(home, "work")),
    );
  });
});

describe("the key's lock, across processes", () => {
  test("a holder in another process is waited for", async () => {
    const file = join(dirs.tempRunDir(), "k.lock");
    const holder = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "hold-key-lock.fixture.ts"), file, "400"],
      stdout: "pipe",
    });
    const reader = holder.stdout.getReader();
    await reader.read();
    const started = Date.now();
    await withKeyLock(file, async () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    await holder.exited;
  });

  test("a lock taken over from a holder is not removed by that holder", async () => {
    const file = join(dirs.tempRunDir(), "k.lock");
    await withKeyLock(file, async () => {
      // Another takes it over, as if this process had looked gone.
      await writeJson(file, { pid: 1, processStart: "2026-01-01T00:00:00Z", at: "now" });
    });
    expect(JSON.parse(await Bun.file(file).text())).toMatchObject({ pid: 1 });
  });
});

test("a duplicate of an event a parked run never took continues it: a retry after a failed launch", async () => {
  const p = project();
  await emit(
    p,
    "dd.changes",
    { case: "k" },
    {
      id: "c1",
      launch: async () => {
        throw new Error("down");
      },
    },
  );
  const launch = fakeLaunch();
  expect(await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch })).toMatchObject({
    outcome: "duplicate",
    did: "started",
  });
});

test("a workflow file directly in home has no project", async () => {
  const home = dirs.tempRunDir();
  await expect(projectOf(join(home, "case.ts"), home)).rejects.toThrow("directly in home");
});

describe("awf tick", () => {
  /** A keyed run with its attempts as given, its project recorded, as an emit would leave it. */
  async function keyedRun(
    p: ReturnType<typeof project>,
    key: string,
    fields: Partial<AttemptRecord>[],
  ) {
    await emit(p, "dd.changes", { case: key }, { id: `${key}-0`, launch: fakeLaunch() });
    const run = await runOf(p, key);
    const [first] = await readAttempts(run);
    const [head, ...rest] = fields;
    await writeJson(join(run.dir, "attempts", "1.json"), { ...first, ...head });
    for (const each of rest) await attempt(run, each);
    return run;
  }
  const ended = (outcome: AttemptRecord["outcome"]) => ({
    ...GONE,
    ended: new Date().toISOString(),
    outcome,
  });
  const tick = async (p: ReturnType<typeof project>, launch: Launch) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await tickCommand(
      ["--json"],
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
      { home: p.home, environment: {}, launch },
    );
    return { code, woke: (JSON.parse(out[0]!) as TickResultJson).woke, err };
  };

  test("wakes each run that is due, from every project awf started one in", async () => {
    const p = project();
    const parkedDue = await keyedRun(p, "due", [ended("parked")]);
    const past = new Date(Date.now() - 1_000).toISOString();
    await appendMailbox(parkedDue.dir, {
      version: 1,
      at: past,
      kind: "took",
      attempt: 1,
      ids: ["due-0"],
    });
    await appendMailbox(parkedDue.dir, {
      version: 1,
      at: past,
      kind: "wait",
      attempt: 1,
      until: past,
    });
    const quiet = await keyedRun(p, "quiet", [ended("parked")]);
    await appendMailbox(quiet.dir, {
      version: 1,
      at: past,
      kind: "took",
      attempt: 1,
      ids: ["quiet-0"],
    });
    await appendMailbox(quiet.dir, { version: 1, at: past, kind: "wait", attempt: 1 });
    await keyedRun(p, "crashed", [{ ...GONE }]);
    await keyedRun(p, "failed", [ended("failed")]);
    await keyedRun(p, "stuck", [ended("failed"), ended("failed"), ended("failed")]);
    await keyedRun(p, "stopped", [ended("stopped")]);
    await keyedRun(p, "live", [{ ...ALIVE }]);
    const launch = fakeLaunch();
    const { code, woke } = await tick(p, launch);
    expect(code).toBe(0);
    expect(woke.sort((a, b) => a.run.localeCompare(b.run))).toEqual([
      { run: "dd-case/dd-case.crashed", did: "continued", why: "crashed" },
      { run: "dd-case/dd-case.due", did: "continued", why: "until" },
      { run: "dd-case/dd-case.failed", did: "continued", why: "failed" },
    ]);
    expect(launch.launched).toHaveLength(3);
  });

  test("a run never started and a parked run with an untaken event are woken; a run without events, and a project that's gone, are not", async () => {
    const p = project();
    await emit(
      p,
      "dd.changes",
      { case: "never" },
      {
        id: "n0",
        launch: async () => {
          throw new Error("down");
        },
      },
    );
    const waiting = await keyedRun(p, "waiting", [ended("parked")]);
    await appendMailbox(waiting.dir, {
      version: 1,
      at: new Date().toISOString(),
      kind: "wait",
      attempt: 1,
    });
    // A crashed run of a workflow without events, in the same project: left as it is.
    const plain = await createRun(p.runRoot, {
      id: "r1",
      workflow: "plain",
      argv: [],
      cwd: p.root,
      sandbox: null,
    });
    await attempt(plain, { ...GONE });
    const gone = join(dirs.tempRunDir(), "gone");
    await Bun.write(
      join(p.home, ".awf", "projects"),
      `${await Bun.file(join(p.home, ".awf", "projects")).text()}${gone}\n`,
    );
    const launch = fakeLaunch();
    const { code, woke, err } = await tick(p, launch);
    expect(woke.sort((a, b) => a.run.localeCompare(b.run))).toEqual([
      { run: "dd-case/dd-case.never", did: "started", why: "event" },
      { run: "dd-case/dd-case.waiting", did: "continued", why: "event" },
    ]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("is gone");
  });

  test("awf runs shows a keyed run that keeps failing as stuck", async () => {
    const p = project();
    await keyedRun(p, "k", [ended("failed"), ended("failed"), { ...GONE }]);
    const out: string[] = [];
    await runsCommand(["--json"], p.root, { stdout: (t) => out.push(t), stderr: () => undefined });
    expect((JSON.parse(out[0]!) as RunsJson).runs).toMatchObject([
      { ref: "dd-case/dd-case.k", state: "stuck" },
    ]);
  });

  test("an emit and a tick at once continue a parked run once", async () => {
    const p = project();
    const run = await keyedRun(p, "k", [ended("parked")]);
    const past = new Date(Date.now() - 1_000).toISOString();
    await appendMailbox(run.dir, { version: 1, at: past, kind: "took", attempt: 1, ids: ["k-0"] });
    await appendMailbox(run.dir, { version: 1, at: past, kind: "wait", attempt: 1, until: past });
    const launch = fakeLaunch();
    const [emitted, ticked] = await Promise.all([
      emit(p, "dd.changes", { case: "k" }, { id: "k-1", launch, nudge: async () => true }),
      tick(p, launch),
    ]);
    expect(launch.launched).toHaveLength(1);
    // Whichever came second found it running: the emit nudged it, or the tick left it.
    expect(ticked.woke).toHaveLength(emitted.did === "continued" ? 0 : 1);
    expect(emitted.did === "continued" || emitted.did === "nudged").toBe(true);
  });
});
