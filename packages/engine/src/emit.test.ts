import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AttemptRecord,
  emitOk,
  type RunLine,
  type RunsJson,
  type TickResultJson,
} from "@agentswf/contract/records";
import { defineWorkflow, type OutputSchema } from "@agentswf/contract/workflow";
import { EmitError, emitEvent } from "./emit";
import { emitCommand } from "./emit-command";
import { writeJson } from "./files";
import { readIn } from "./in-lines";
import { logsCommand } from "./logs-command";
import { listProjects, projectOf } from "./projects";
import { runLinesFile } from "./run-lines";
import { runLockFile, withRunLock } from "./run-lock";
import { STUCK_AFTER } from "./run-state";
import { createRun, openRun, processStart, type Run, readAttemptFiles, readAttempts } from "./runs";
import { runsCommand } from "./runs-command";
import { createTempRunDirs, writeAttempt } from "./testing";
import { tickCommand } from "./tick-command";
import { attemptEnvironment, type Launch, wake } from "./wake";
import type { EventWorkflow } from "./workflow-loader";

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
  const defined = defineWorkflow({
    meta: { name: "dd-case", description: "A case." },
    file,
    events: { "dd.changes": Changes, "dd.closed": Closed },
    starts: ["dd.changes"],
    run: async () => null,
  });
  // Its run's context is its own events', which no wider type takes: the engine sees any workflow.
  const target = defined as unknown as EventWorkflow;
  return { root, home, file, target, runRoot: join(root, ".awf", "runs") };
}

const ALIVE = { pid: process.pid, processStart: processStart(process.pid)! };
const GONE = { pid: Bun.spawnSync(["true"]).pid, processStart: "2026-10-11T09:00:00Z" };

/** A launch that claims the attempt as `awf run --continue` would, and counts the launches. */
function fakeLaunch(): Launch & { launched: string[] } {
  const launched: string[] = [];
  const launch = (async (run: Run, file: string, _launch: string) => {
    launched.push(file);
    await attempt(run, { ...ALIVE });
  }) as Launch & { launched: string[] };
  launch.launched = launched;
  return launch;
}

const attempt = (run: Run, fields: Partial<AttemptRecord>) =>
  writeAttempt(run, { ...GONE, ...fields });

function emit(
  p: ReturnType<typeof project>,
  name: string,
  data: unknown,
  extra: { id?: string; launch?: Launch; nudge?: (run: Run) => Promise<boolean> } = {},
) {
  const { launch, nudge, id } = extra;
  // The sender names the run; these tests name it as the case's own field says.
  const run = (data as { case?: unknown } | null)?.case;
  return emitEvent(
    p.target,
    {
      run: typeof run === "string" ? run : "k",
      name,
      data: data as never,
      ...(id === undefined ? {} : { id }),
    },
    {
      from: "operator",
      home: p.home,
      environment: { PATH: "/usr/bin:/bin" },
      ...(launch ? { launch } : {}),
      ...(nudge ? { nudge } : {}),
    },
  );
}

const runOf = (p: ReturnType<typeof project>, key: string) => openRun(p.runRoot, "dd-case", key);
const eventsOf = async (run: Run) => (await readIn(run.dir)).map((e) => e.id);

/** What attempt 1 settled, as a run would have written it: its lines, at `at`. */
const settled = (run: Run, at: string, lines: Record<string, unknown>[]) =>
  appendFile(
    runLinesFile(run.dir),
    lines.map((line) => `${JSON.stringify({ attempt: 1, at, ...line } as RunLine)}\n`).join(""),
  );

test.each([
  ["accepted", undefined, true],
  ["duplicate", undefined, true],
  // The run has the event; whether a wait takes it now is the workflow's.
  ["accepted", "nothing-due", true],
  ["accepted", "nudge-failed", true],
  // A resend to a run that returned: the event was taken the first time.
  ["duplicate", "returned", true],
  ["refused", "returned", false],
  ["refused", "not-a-start", false],
  ["accepted", "launch-failed", false],
  ["duplicate", "launch-failed", false],
  ["accepted", "stuck", false],
  ["accepted", "stopped", false],
  ["accepted", "cancelled", false],
] as const)("an emit %s, %s, is ok: %p", (outcome, why, ok) => {
  expect(emitOk(outcome, why)).toBe(ok);
});

describe("outcomes", () => {
  test("without starts, any event starts its run", async () => {
    const p = project();
    const { starts: _, ...rest } = p.target;
    p.target = rest;
    const launch = fakeLaunch();
    expect(await emit(p, "dd.closed", { case: "a" }, { id: "c1", launch })).toMatchObject({
      outcome: "accepted",
      ref: "dd-case/a",
      did: "started",
    });
    expect(await eventsOf(await runOf(p, "a"))).toEqual(["c1"]);
  });

  test("a starting event with no run starts one in the file's project, recorded once", async () => {
    const p = project();
    const launch = fakeLaunch();
    expect(await emit(p, "dd.changes", { case: "kombo" }, { id: "c1", launch })).toEqual({
      v: 1,
      ok: true,
      outcome: "accepted",
      ref: "dd-case/kombo",
      eventId: "c1",
      did: "started",
    });
    const run = await runOf(p, "kombo");
    expect(run.record).toMatchObject({
      events: true,
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
    expect(first.eventId).toMatch(/^awf\.[0-9a-f]{16}$/);
    expect(second.outcome).toBe("accepted");
    expect(await eventsOf(await runOf(p, "k"))).toEqual([first.eventId, second.eventId]);
  });

  test.each([
    ["an undeclared name", "dd.opened", { case: "k" }, {}, "declares no event dd.opened"],
    ["a colon", "agent:ended", { case: "k" }, {}, "a name with a colon is awf's own"],
    ["data its schema refuses", "dd.changes", { other: 1 }, {}, "does not fit its schema"],
    ["an id outside the grammar", "dd.changes", { case: "k" }, { id: "Abc" }, "the id"],
    ["an id of awf's", "dd.changes", { case: "k" }, { id: "awf.x" }, "are awf's own"],
    ["a run id outside the grammar", "dd.changes", { case: "a/b" }, {}, '"a/b" is not a valid id'],
  ])("%s is an error, not an outcome", async (_what, name, data, extra, message) => {
    const p = project();
    const error = await emit(p, name, data, extra).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmitError);
    expect(String(error)).toContain(message);
  });

  test("an event that may start a run is refused when prepare refuses no argv", async () => {
    const p = project();
    const target = {
      ...p.target,
      prepare: () => {
        throw new Error("a case needs its key");
      },
    };
    const error = await emitEvent(
      target,
      { run: "k", name: "dd.changes", data: { case: "k" } },
      { from: "operator", home: p.home, environment: {} },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmitError);
    expect(String(error)).toContain(
      "a run an event starts has no arguments, which its prepare refuses: a case needs its key",
    );
  });

  test("an event for a run there already lands though prepare refuses no argv", async () => {
    const p = project();
    await emit(p, "dd.changes", { case: "k" }, { id: "c0", launch: fakeLaunch() });
    const target = {
      ...p.target,
      prepare: () => {
        throw new Error("a case needs its key");
      },
    };
    const result = await emitEvent(
      target,
      { run: "k", name: "dd.changes", data: { case: "k" } },
      { from: "operator", home: p.home, environment: {}, launch: fakeLaunch() },
    );
    expect(result.outcome).toBe("accepted");
  });

  test("a definition with events and no file is refused", async () => {
    const p = project();
    const { file: _file, ...definition } = p.target;
    const error = await emitEvent(
      definition as EventWorkflow,
      { run: "k", name: "dd.changes", data: { case: "k" } },
      { from: "operator", home: p.home, environment: {} },
    ).catch((caught: unknown) => caught);
    expect(String(error)).toContain("a workflow with starts gives file: import.meta.path");
  });

  test("one without starts may leave out its file, but a sender holding it can't find it", async () => {
    const p = project();
    const { file: _file, starts: _starts, ...definition } = p.target;
    const error = await emitEvent(
      definition as EventWorkflow,
      { run: "k", name: "dd.changes", data: { case: "k" } },
      { from: "operator", home: p.home, environment: {} },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmitError);
    expect(String(error)).toContain(
      "gives no file, by which a sender holding it finds it: file: import.meta.path",
    );
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
  test("one whose attempt claimed its number after all is not a failed launch", async () => {
    const p = project();
    // The launcher gave up, but the child had claimed: its link is refused, and the launch started it.
    const late: Launch = async (run) => {
      await attempt(run, { ...ALIVE });
      throw new Error("did not start within 60 s");
    };
    expect(await emit(p, "dd.changes", { case: "k" }, { id: "c1", launch: late })).toMatchObject({
      outcome: "accepted",
      did: "started",
    });
    const files = await readAttemptFiles(await runOf(p, "k"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: "attempt" });
  });

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
    // Each failed launch is the attempt it never claimed, failed, with no process: what stuck counts.
    const attempts = await readAttemptFiles(run);
    expect(attempts).toMatchObject(
      [1, 2, 3].map((n) => ({
        attempt: n,
        kind: "failed-launch",
        outcome: "failed",
        reason: "SyntaxError in case.ts",
      })),
    );
    expect(attempts.some((each) => "pid" in each)).toBe(false);
    expect(await readAttempts(run)).toEqual([]);
    expect(new Set(attempts.map((each) => each.launch)).size).toBe(3);
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

describe("the run's lock", () => {
  test("two events for one key at once start one run, and the other is kept in its in.jsonl", async () => {
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
    const file = runLockFile(p.runRoot, "dd-case", "k");
    mkdirSync(join(p.runRoot, "dd-case"), { recursive: true });
    await writeJson(file, { ...GONE, at: new Date().toISOString() });
    const started = Date.now();
    expect(await withRunLock(file, async () => "held")).toBe("held");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a live holder is waited for, and a waiter in the same process queues", async () => {
    const file = join(dirs.tempRunDir(), "x.lock");
    const order: string[] = [];
    await Promise.all([
      withRunLock(file, async () => {
        order.push("a in");
        await Bun.sleep(30);
        order.push("a out");
      }),
      withRunLock(file, async () => {
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
        'import { defineWorkflow } from "agentswf/workflow";',
        'const Changes = { type: "object", properties: { case: { type: "string" } }, required: ["case"] };',
        "export default defineWorkflow({",
        '  meta: { name: "dd-case", description: "A case." }, file: import.meta.path,',
        '  events: { "dd.changes": Changes }, starts: ["dd.changes"],',
        "  run: async () => null });",
      ].join("\n"),
    );
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
    const context = { home: p.home, environment: { PATH: "/bin" }, launch: fakeLaunch() };
    expect(
      await emitCommand(
        ["--target", p.file, "--id", "k", "dd.changes", '{"case":"k"}', "--event-id", "c1"],
        p.root,
        io,
        context,
      ),
    ).toBe(0);
    expect(
      await emitCommand(
        ["--target", p.file, "--id", "k", "dd.changes", '{"case":"k"}', "--event-id", "c1"],
        p.root,
        io,
        context,
      ),
    ).toBe(0);
    expect(out).toEqual(["accepted dd-case/k: started", "duplicate dd-case/k"]);
    expect(
      await emitCommand(
        ["--target", p.file, "--id", "k", "dd.changes", '{"case":1}'],
        p.root,
        io,
        context,
      ),
    ).toBe(2);
    expect(err.at(-1)).toContain("does not fit its schema");
    out.length = 0;
    expect(
      await emitCommand(
        ["--target", p.file, "--id", "j", "dd.changes", '{"case":"j"}', "--json"],
        p.root,
        io,
        context,
      ),
    ).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ v: 1, outcome: "accepted", did: "started" });
  });

  test("--json prints a refusal for a failure, its sentence still on stderr; without, nothing", async () => {
    const p = project();
    writeFileSync(p.file, "export default 1;\n");
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };
    const context = { home: p.home, environment: { PATH: "/bin" }, launch: fakeLaunch() };
    const refused = async (argv: string[]) => {
      out.length = 0;
      err.length = 0;
      const exit = await emitCommand([...argv, "--json"], p.root, io, context);
      expect(out).toHaveLength(1);
      const refusal = JSON.parse(out[0]!) as { v: number; code: string; error: string };
      expect(err[0]).toStartWith(`awf: ${refusal.error}`);
      return { exit, ...refusal };
    };
    // A file that isn't a workflow; a run of a workflow whose file is gone.
    expect(await refused(["--target", p.file, "--id", "k", "dd.changes", "{}"])).toMatchObject({
      exit: 1,
      v: 1,
      code: "file",
      error: expect.stringContaining("default export"),
    });
    await createRun(p.runRoot, {
      id: "gone",
      workflow: "dd-case",
      argv: [],
      cwd: p.root,
      sandbox: null,
      events: true,
      file: join(p.root, "flows", "gone.ts"),
    });
    expect(await refused(["dd-case/gone", "slack:reply", '{"text":"hi"}'])).toMatchObject({
      exit: 1,
      code: "file",
    });
    expect(await refused(["dd-case/gone", "dd.changes", "{}"])).toMatchObject({
      exit: 2,
      code: "event",
    });
    expect(await refused(["--target", p.file, "--nope"])).toMatchObject({ exit: 2, code: "usage" });
    err.length = 0;
    out.length = 0;
    expect(await emitCommand(["dd-case/nope", "dd.changes"], p.root, io, context)).toBe(1);
    expect(out).toEqual([]);
    expect(err[0]).toStartWith("awf: no run dd-case/nope");
  });
});

describe("wake, directly", () => {
  test("parked at a race: woken only by what it names, an event or its timer", async () => {
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
    const due = Date.parse("2026-10-25T12:00:00Z");
    const at = new Date(due - 60_000).toISOString();
    await settled(run, at, [
      { kind: "timer", name: "ask@nudge", due: new Date(due).toISOString(), when: "1m" },
      {
        kind: "wait",
        race: "ask",
        takes: [{ name: "dd.closed" }, { name: "timer:due", from: "ask@nudge" }],
      },
    ]);
    launch.launched.length = 0;
    const context = { home: p.home, environment: {}, launch };
    // c0 waits unacknowledged, but the race doesn't name it.
    expect(await wake(run, { ...context, now: () => due - 1 })).toEqual({
      did: "none",
      why: "nothing-due",
    });
    expect(await wake(run, { ...context, now: () => due })).toEqual({
      did: "continued",
      cause: "timer",
    });
  });

  test("parked: continued once its timer is due, else nothing due", async () => {
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
    const due = new Date(until).toISOString();
    await settled(run, new Date().toISOString(), [
      { kind: "timer", name: "retry", due, when: due },
      { kind: "wait" },
      { kind: "took", took: [{ id: "c0" }] },
      { kind: "wait", acks: ["c0"] },
    ]);
    launch.launched.length = 0;
    const context = { home: p.home, environment: {}, launch };
    expect(await wake(run, { ...context, now: () => until - 1 })).toEqual({
      did: "none",
      why: "nothing-due",
    });
    expect(await wake(run, { ...context, now: () => until })).toEqual({
      did: "continued",
      cause: "timer",
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
      `import { defineWorkflow } from "agentswf/workflow";\nexport default defineWorkflow(${body});\n`,
    );
    return p;
  };
  const base = (over: string) =>
    `{ meta: { name: "dd-case", description: "A case." }, file: import.meta.path, events: { "dd.changes": { type: "object", properties: {} } }, starts: ["dd.changes"], run: async () => null, ${over} }`;

  test.each([
    [
      'events: { "dd:changes": { type: "object", properties: {} } }, starts: ["dd:changes"]',
      "has a colon",
    ],
    ["starts: []", "starts lists the events"],
    ['starts: ["dd.opened"]', "starts lists the events"],
    ['file: "/elsewhere/case.ts"', "gives file: import.meta.path"],
  ])("a definition with %s is refused at load", async (over, message) => {
    const p = write(base(over));
    const err: string[] = [];
    const io = { stdout: () => undefined, stderr: (t: string) => err.push(t) };
    const code = await emitCommand(
      ["--target", p.file, "--id", "k", "dd.changes", "{}"],
      p.root,
      io,
      {
        home: p.home,
        environment: {},
        launch: fakeLaunch(),
      },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toContain(message);
  });

  test("awf emit exits 1, saying why, when the attempt doesn't start; the event is kept", async () => {
    const p = write(base(""));
    const err: string[] = [];
    const out: string[] = [];
    const code = await emitCommand(
      ["--target", p.file, "--id", "k", "dd.changes", "{}", "--event-id", "c1"],
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
    expect(out).toEqual(["accepted dd-case/k: launch-failed"]);
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

describe("the run's lock, across processes", () => {
  test("a holder in another process is waited for", async () => {
    const file = join(dirs.tempRunDir(), "k.lock");
    const holder = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "hold-run-lock.fixture.ts"), file, "400"],
      stdout: "pipe",
    });
    const reader = holder.stdout.getReader();
    await reader.read();
    const started = Date.now();
    await withRunLock(file, async () => undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    await holder.exited;
  });

  test("a lock taken over from a holder is not removed by that holder", async () => {
    const file = join(dirs.tempRunDir(), "k.lock");
    await withRunLock(file, async () => {
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
  /** An event run with its attempts as given, its project recorded, as an emit would leave it. */
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
  const tick = async (
    p: ReturnType<typeof project>,
    launch: Launch,
    args: string[] = [],
    cwd = p.root,
  ) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await tickCommand(
      ["--json", ...args],
      cwd,
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
      { home: p.home, environment: {}, launch },
    );
    const woke = out[0] === undefined ? [] : (JSON.parse(out[0]) as TickResultJson).woke;
    return { code, woke, err };
  };

  test("wakes each run that is due in its own project", async () => {
    const p = project();
    const parkedDue = await keyedRun(p, "due", [ended("parked")]);
    const past = new Date(Date.now() - 1_000).toISOString();
    await settled(parkedDue, past, [
      { kind: "took", took: [{ id: "due-0" }] },
      { kind: "timer", name: "retry", due: past, when: past },
      { kind: "wait", acks: ["due-0"] },
    ]);
    const quiet = await keyedRun(p, "quiet", [ended("parked")]);
    await settled(quiet, past, [
      { kind: "took", took: [{ id: "quiet-0" }] },
      { kind: "wait", acks: ["quiet-0"] },
    ]);
    await keyedRun(p, "crashed", [{ ...GONE }]);
    await keyedRun(p, "failed", [ended("failed")]);
    await keyedRun(p, "stuck", [ended("failed"), ended("failed"), ended("failed")]);
    await keyedRun(p, "stopped", [ended("stopped")]);
    await keyedRun(p, "live", [{ ...ALIVE }]);
    const launch = fakeLaunch();
    const { code, woke } = await tick(p, launch);
    expect(code).toBe(0);
    expect(woke.sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
      { ref: "dd-case/crashed", did: "continued", why: "crashed" },
      { ref: "dd-case/due", did: "continued", why: "timer" },
      { ref: "dd-case/failed", did: "continued", why: "failed" },
    ]);
    expect(launch.launched).toHaveLength(3);
  });

  test("wakes its own project's runs, and --all every project's", async () => {
    const p = project();
    const other = { ...project(), home: p.home };
    await keyedRun(p, "here", [{ ...GONE }]);
    await keyedRun(other, "there", [{ ...GONE }]);
    const launch = fakeLaunch();
    expect((await tick(p, launch)).woke.map((w) => w.ref)).toEqual(["dd-case/here"]);
    expect((await tick(p, launch, ["--cwd", other.root])).woke.map((w) => w.ref)).toEqual([
      "dd-case/there",
    ]);
    const empty = dirs.tempRunDir();
    expect(await tick(p, launch, [], empty)).toMatchObject({ code: 0, woke: [] });
    await keyedRun(p, "again", [{ ...GONE }]);
    await keyedRun(other, "again", [{ ...GONE }]);
    const all = await tick(p, launch, ["--all"], empty);
    expect(all.code).toBe(0);
    expect(all.woke.map((w) => w.ref).sort()).toEqual(["dd-case/again", "dd-case/again"]);
  });

  test("--all takes no place of its own", async () => {
    const p = project();
    const { code, err } = await tick(p, fakeLaunch(), ["--all", "--cwd", p.root]);
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--all wakes every project's runs");
  });

  test("a run never started and a parked run with an untaken event are woken; a run without events is not, and a project that's gone fails only --all", async () => {
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
    await settled(waiting, new Date().toISOString(), [{ kind: "wait" }]);
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
    expect(await tick(p, fakeLaunch(), [], dirs.tempRunDir())).toMatchObject({ code: 0, err: [] });
    const { code, woke, err } = await tick(p, launch, ["--all"]);
    expect(woke.sort((a, b) => a.ref.localeCompare(b.ref))).toEqual([
      { ref: "dd-case/never", did: "started", why: "event" },
      { ref: "dd-case/waiting", did: "continued", why: "event" },
    ]);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("is gone");
  });

  test("tick --all passes over a project only plain runs registered, whatever its engine", async () => {
    const p = project();
    const plainOnly = dirs.tempRunDir();
    // Declared and not installed: a project with event runs would be refused.
    await Bun.write(
      join(plainOnly, "package.json"),
      JSON.stringify({ devDependencies: { agentswf: "9.9.9" } }),
    );
    await createRun(join(plainOnly, ".awf", "runs"), {
      id: "p1",
      workflow: "plain",
      argv: [],
      args: null,
      cwd: plainOnly,
      sandbox: null,
    });
    await Bun.write(join(p.home, ".awf", "projects"), `${plainOnly}\n`);
    expect(await tick(p, fakeLaunch(), ["--all"])).toMatchObject({ code: 0, err: [] });
  });

  test("tick --all hands a project on another engine over, though its records are too new to read", async () => {
    const p = project();
    const newer = dirs.tempRunDir();
    mkdirSync(join(newer, "node_modules", "agentswf"), { recursive: true });
    await Bun.write(
      join(newer, "node_modules", "agentswf", "package.json"),
      JSON.stringify({ version: "9.9.9", bin: { awf: "./missing.ts" } }),
    );
    await Bun.write(
      join(newer, ".awf", "runs", "wf", "r1", "run.json"),
      JSON.stringify({ format: 99, events: true, id: "r1", workflow: "wf" }),
    );
    await Bun.write(join(p.home, ".awf", "projects"), `${newer}\n`);
    // Handed to its engine, which is missing here: a failure, not a project passed over.
    expect((await tick(p, fakeLaunch(), ["--all"])).code).toBe(1);
  });

  test("a run an earlier awf made is unreadable: listed so, never woken, sent to or read", async () => {
    const p = project();
    const old = await keyedRun(p, "old", [ended("parked")]);
    const current = await keyedRun(p, "current", [ended("parked")]);
    // As an awf before format 1 left it: run.json with a version and no format.
    const { format: _format, ...record } = old.record;
    await writeJson(join(old.dir, "run.json"), { version: 1, ...record });
    const why = "an earlier awf made it, before run.json had a format; this awf does not read it";
    const launch = fakeLaunch();
    const ticked = await tick(p, launch);
    // Not an error: it is named, and the run beside it, parked with its event untaken, is woken.
    expect(ticked).toMatchObject({ code: 0, err: [] });
    expect(ticked.woke.map((each) => each.ref)).toEqual(["dd-case/current"]);
    const out: string[] = [];
    const err: string[] = [];
    const json = await tickCommand(
      ["--json"],
      p.root,
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
      { home: p.home, environment: {}, launch },
    );
    expect(json).toBe(0);
    expect((JSON.parse(out[0]!) as TickResultJson).unreadable).toEqual(["dd-case/old"]);
    err.length = 0;
    const text = await tickCommand(
      [],
      p.root,
      { stdout: () => undefined, stderr: (t) => err.push(t) },
      { home: p.home, environment: {}, launch },
    );
    expect(text).toBe(0);
    expect(err).toEqual([
      "awf: 1 run with events can't be read and is not woken; awf runs says why",
    ]);
    await expect(emit(p, "dd.changes", { case: "old" }, { launch })).rejects.toThrow(
      `dd-case/old is unreadable: ${why}`,
    );
    const runs = async (argv: string[]) => {
      const out: string[] = [];
      await runsCommand(
        argv,
        p.root,
        { stdout: (t) => out.push(t), stderr: (t) => out.push(t) },
        Date.now(),
        p.home,
      );
      return out.join("\n");
    };
    // Listed where it was made, among the runs that read.
    expect((JSON.parse(await runs(["--json"])) as RunsJson).runs).toEqual([
      expect.objectContaining({ ref: "dd-case/current" }),
      { ref: "dd-case/old", unreadable: why },
    ]);
    expect((await runs([])).split("\n")).toContainEqual(`dd-case/old      unreadable: ${why}`);
    for (const ref of ["dd-case/old", "old"]) {
      expect(await runs([ref])).toBe(`awf: dd-case/old is unreadable: ${why}`);
      const err: string[] = [];
      const code = await logsCommand(
        [ref],
        p.root,
        { stdout: () => undefined, stderr: (t) => err.push(t) },
        undefined,
        p.home,
      );
      expect({ code, err }).toEqual({ code: 3, err: [`awf: dd-case/old is unreadable: ${why}`] });
    }
    expect(current.record.format).toBe(1);
  });

  test("a ref an earlier awf's run holds here finds a current run of it in another project", async () => {
    const p = project();
    await keyedRun(p, "shared", [ended("parked")]);
    // Here, under the shell's folder: an old run with the same ref.
    const here = dirs.tempRunDir();
    const old = await createRun(join(here, ".awf", "runs"), {
      id: "shared",
      workflow: "dd-case",
      argv: [],
      cwd: here,
      sandbox: null,
    });
    const { format: _format, ...record } = old.record;
    await writeJson(join(old.dir, "run.json"), { version: 1, ...record });
    for (const ref of ["dd-case/shared", "shared"]) {
      const out: string[] = [];
      const code = await runsCommand(
        [ref, "--json"],
        here,
        { stdout: (t) => out.push(t), stderr: (t) => out.push(t) },
        Date.now(),
        p.home,
      );
      expect(code).toBe(0);
      expect(JSON.parse(out[0]!).attempts).toMatchObject([{ attempt: 1, state: "parked" }]);
    }
    // With no current run anywhere, the old one says why it isn't read.
    const err: string[] = [];
    await runsCommand(
      ["dd-case/shared"],
      here,
      { stdout: () => undefined, stderr: (t) => err.push(t) },
      Date.now(),
      dirs.tempRunDir(),
    );
    expect(err.join("\n")).toContain("dd-case/shared is unreadable");
  });

  test("awf runs shows an event run that keeps failing as stuck", async () => {
    const p = project();
    await keyedRun(p, "k", [ended("failed"), ended("failed"), { ...GONE }]);
    const out: string[] = [];
    await runsCommand(
      ["--json"],
      p.root,
      { stdout: (t) => out.push(t), stderr: () => undefined },
      Date.now(),
      p.home,
    );
    expect((JSON.parse(out[0]!) as RunsJson).runs).toMatchObject([
      { ref: "dd-case/k", state: "stuck" },
    ]);
  });

  test("an emit and a tick at once continue a parked run once", async () => {
    const p = project();
    const run = await keyedRun(p, "k", [ended("parked")]);
    const past = new Date(Date.now() - 1_000).toISOString();
    await settled(run, past, [
      { kind: "took", took: [{ id: "k-0" }] },
      { kind: "timer", name: "retry", due: past, when: past },
      { kind: "wait", acks: ["k-0"] },
    ]);
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
