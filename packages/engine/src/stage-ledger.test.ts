import { afterAll, describe, expect, test } from "bun:test";
import { type RunLine, type RunView, readRun, type StageLine } from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
import type { RunEventBody } from "./run-event-log";
import { claimRunLines, type RunLines, readRunLines } from "./run-lines";
import { type OpenStage, StageLedger } from "./stage-ledger";
import { WorkflowStopped } from "./stopped";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

/** A run's `run.jsonl` in memory: each attempt claims it, as on disk, and appends to it. */
class Lines {
  readonly all: unknown[] = [];

  claim(attempt: number): RunLines {
    this.all.push({ kind: "claimed", attempt, at: new Date().toISOString() });
    return {
      attempt,
      append: async (line: RunLine) => {
        if (line.attempt !== attempt)
          throw new Error(`attempt ${attempt} wrote ${line.attempt}'s line`);
        this.all.push(line);
      },
    };
  }

  get view(): RunView {
    return readRun(this.all);
  }
}

/** A ledger of attempt `attempt`, which claims `lines` and reads them as the attempt begins. */
function ledgerOf(
  lines: Lines,
  attempt: number,
  options: Omit<ConstructorParameters<typeof StageLedger>[0], "lines" | "run"> = {},
): StageLedger {
  const claimed = lines.claim(attempt);
  return new StageLedger({ lines: claimed, run: lines.view, ...options });
}

/** A stage line of attempt `attempt`, as an earlier attempt left it. */
const line = (name: string, attempt: number, fields: Partial<StageLine> = {}): StageLine => ({
  kind: "stage",
  attempt,
  at: "2026-10-04T10:01:00Z",
  name,
  outcome: "succeeded",
  started: "2026-10-04T10:00:00Z",
  ...fields,
});

/** `lines` with attempt `attempt` having written `written`. */
async function wrote(lines: Lines, attempt: number, ...written: StageLine[]): Promise<Lines> {
  const writer = lines.claim(attempt);
  for (const each of written) await writer.append(each);
  return lines;
}

/** Enters `name` to run it, as a stage with nothing recorded is. */
async function run(ledger: StageLedger, name: string): Promise<OpenStage> {
  const entered = await ledger.enter(name, { summary: () => undefined });
  if (entered.kind !== "run") throw new Error(`${name} was reused`);
  return entered.stage;
}

const PATH: JsonSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
};

test("closing waits for a line already being written, and ends a stage once", async () => {
  const lines = new Lines();
  const ledger = ledgerOf(lines, 1);
  const qa = await run(ledger, "qa");
  void qa.fail("qa broke");
  await ledger.close();
  expect(lines.view.stages.qa?.history).toEqual([
    expect.objectContaining({ outcome: "failed", reason: "qa broke" }),
  ]);
  // A later end changes nothing.
  await qa.succeed(undefined);
  expect(lines.view.stages.qa?.history).toHaveLength(1);
});

test("a stage's line starts at the clock read its stage-started logs, and ends when it ended", async () => {
  const lines = new Lines();
  const logged: { body: RunEventBody; at: number | undefined }[] = [];
  let now = Date.parse("2026-10-04T10:00:00.123Z");
  const ledger = ledgerOf(lines, 1, {
    now: () => new Date(now),
    event: (body, at) => logged.push({ body, at }),
  });
  const qa = await run(ledger, "qa");
  now += 5_000;
  await qa.succeed({ path: "a" }, "a");
  expect(lines.view.stages.qa?.last).toEqual({
    kind: "stage",
    attempt: 1,
    at: "2026-10-04T10:00:05.123Z",
    name: "qa",
    outcome: "succeeded",
    started: "2026-10-04T10:00:00.123Z",
    summary: "a",
    value: { path: "a" },
    // The first stage a plain run runs is where its attempt starts.
    redo: true,
  });
  expect(logged[0]).toEqual({
    body: { kind: "stage-started", stage: "qa" },
    at: Date.parse("2026-10-04T10:00:00.123Z"),
  });
});

test("a sealed ledger fails the open stage with its reason when closed, and enters no other", async () => {
  const lines = new Lines();
  const ledger = ledgerOf(lines, 1);
  await run(ledger, "qa");
  ledger.seal("Deadline exceeded");
  await expect(run(ledger, "mr")).rejects.toThrow(
    "stage mr was entered after the workflow ended: Deadline exceeded",
  );
  await ledger.close();
  expect(Object.values(lines.view.stages).map(({ last }) => last)).toEqual([
    expect.objectContaining({ name: "qa", outcome: "failed", reason: "Deadline exceeded" }),
  ]);
  expect(ledger.summaries.map(({ stage, outcome }) => [stage, outcome])).toEqual([
    ["qa", "failed"],
  ]);
});

test("a misuse leaves no stage entered or open", async () => {
  const ledger = ledgerOf(new Lines(), 1);
  await expect(run(ledger, "Bad")).rejects.toThrow("is not a stage's name");
  const qa = await run(ledger, "qa");
  await expect(run(ledger, "mr")).rejects.toThrow("while stage qa is open");
  await qa.succeed(undefined);
  await expect(run(ledger, "qa")).rejects.toThrow("entered twice");
  await (await run(ledger, "mr")).succeed(undefined);
  expect(ledger.progress().stages.map(({ stage }) => stage)).toEqual(["qa", "mr"]);
});

test("closing waits for every line without reporting again one its stage already threw", async () => {
  // Every line from now on fails to be written.
  const failing = { attempt: 1, append: () => Promise.reject(new Error("disk full")) };
  const ledger = new StageLedger({ lines: failing });
  const qa = await run(ledger, "qa");
  await expect(qa.succeed(undefined)).rejects.toThrow("disk full");
  const mr = await run(ledger, "mr");
  void mr.succeed(undefined).catch(() => undefined);
  await ledger.close();
  expect(ledger.summaries).toMatchObject([
    { stage: "qa", outcome: "failed" },
    { stage: "mr", outcome: "failed" },
  ]);
  // The stage still open when the attempt ends is closing's own to report.
  const open = new StageLedger({ lines: failing });
  await run(open, "qa");
  await expect(open.close()).rejects.toThrow("disk full");
});

test("a stage the plan stops as it is entered shows stopped, in the view as in the summaries", async () => {
  const lines = await wrote(new Lines(), 1, line("qa", 1, { outcome: "failed" }));
  const ledger = ledgerOf(lines, 2, { fromStage: "mr" });
  await expect(ledger.enter("qa", { result: PATH, summary: () => undefined })).rejects.toThrow(
    "qa did not succeed in attempt 1",
  );
  expect(ledger.summaries).toEqual([
    { stage: "qa", source: "ran", outcome: "stopped", attempt: 2, spanMs: 0 },
  ]);
  expect(ledger.progress()).toEqual({
    stages: [expect.objectContaining({ stage: "qa", outcome: "stopped" })],
    upcoming: [],
  });
  // It ran nothing, so it wrote no line.
  expect(lines.view.stages.qa?.history).toHaveLength(1);
});

test("a value given is written as provided, handed back, and kept at the start point", async () => {
  const lines = new Lines();
  const ledger = ledgerOf(lines, 1, {
    fromStage: "qa",
    values: new Map([["plan", { path: "docs/a.md" }]]),
  });
  const shape = { result: PATH, summary: (value: unknown) => (value as { path: string }).path };
  const plan = await ledger.enter("plan", shape);
  expect(plan).toMatchObject({ kind: "reuse", value: { path: "docs/a.md" } });
  if (plan.kind === "reuse") plan.release();
  // One with no result is passed without a value.
  const notify = await ledger.enter("notify", { summary: () => undefined });
  if (notify.kind === "reuse") notify.release();
  await (await run(ledger, "qa")).succeed(undefined);
  await ledger.close();
  const { stages } = lines.view;
  expect(stages.plan?.last).toMatchObject({
    attempt: 1,
    outcome: "succeeded",
    summary: "docs/a.md",
    value: { path: "docs/a.md" },
    provided: true,
  });
  expect(stages.plan?.last.started).toBe(stages.plan?.last.at);
  expect(stages.notify?.last).toMatchObject({ outcome: "succeeded", provided: true });
  expect(stages.notify?.last).not.toHaveProperty("value");
  // The start point is `--from-stage`'s: its line is the redo.
  expect(stages.qa?.last.redo).toBe(true);
  expect(stages.plan?.last).not.toHaveProperty("redo");
  expect(
    ledger.summaries.map(({ stage, source, provided }) => ({ stage, source, provided })),
  ).toEqual([
    { stage: "plan", source: "reused", provided: true },
    { stage: "notify", source: "reused", provided: true },
    { stage: "qa", source: "ran", provided: undefined },
  ]);
});

test("a stage with no value hands back a stand-in, and the start point stops for every one missing", async () => {
  const ledger = ledgerOf(new Lines(), 1, { fromStage: "qa" });
  const plan = await ledger.enter("plan", { result: PATH, summary: () => undefined });
  expect(plan).toMatchObject({ kind: "reuse", value: { path: "" } });
  if (plan.kind === "reuse") plan.release();
  const count = await ledger.enter("count", {
    result: { type: "integer", minimum: 2 },
    summary: () => undefined,
  });
  expect(count).toMatchObject({ kind: "reuse", value: 2 });
  if (count.kind === "reuse") count.release();
  const stopped = await run(ledger, "qa").catch((error: unknown) => error);
  expect(stopped).toMatchObject({
    reason: "nothing recorded for plan",
    stage: "plan",
    redo: false,
    needs: [
      { stage: "plan", schema: PATH },
      { stage: "count", schema: { type: "integer", minimum: 2 } },
    ],
  });
  // Nor may a turn start once it has looked on: the same stop.
  expect(() => ledger.checkOperation()).toThrow(stopped as Error);
  // The first is shown stopped; the rest were only looked at.
  expect(ledger.summaries.map(({ stage, outcome }) => [stage, outcome])).toEqual([
    ["plan", "stopped"],
  ]);
});

test("a stage provided is open while its line is written: none enters beside it", async () => {
  const ledger = ledgerOf(new Lines(), 1, {
    fromStage: "qa",
    values: new Map([
      ["plan", { path: "a" }],
      ["notes", { path: "b" }],
    ]),
  });
  const entry = { result: PATH, summary: () => undefined };
  const [first, second] = await Promise.allSettled([
    ledger.enter("plan", entry),
    ledger.enter("notes", entry),
  ]);
  expect(first?.status).toBe("fulfilled");
  expect(second).toMatchObject({ status: "rejected" });
  expect(String((second as PromiseRejectedResult).reason)).toContain("while stage plan is open");
});

test("looking on, a caught stop doesn't end the look: every value missing is still named", async () => {
  const ledger = ledgerOf(new Lines(), 1, { fromStage: "qa" });
  const entry = { result: PATH, summary: () => undefined };
  const plan = await ledger.enter("plan", entry);
  if (plan.kind === "reuse") plan.release();
  // A turn refused, its error caught by the workflow, which goes on to the next stage.
  expect(() => ledger.checkOperation()).toThrow();
  const notes = await ledger.enter("notes", entry);
  if (notes.kind === "reuse") notes.release();
  const stopped = await run(ledger, "qa").catch((error: unknown) => error);
  expect(stopped).toMatchObject({ needs: [{ stage: "plan" }, { stage: "notes" }] });
});

test("a value given over a failed line is written after it, which stays in the stage's history", async () => {
  const failed = line("plan", 1, { outcome: "failed", reason: "broke" });
  const lines = await wrote(new Lines(), 1, failed);
  const ledger = ledgerOf(lines, 2, {
    fromStage: "qa",
    values: new Map([["plan", { path: "a" }]]),
  });
  const plan = await ledger.enter("plan", { result: PATH, summary: () => undefined });
  if (plan.kind === "reuse") plan.release();
  expect(lines.view.stages.plan?.history).toEqual([
    failed,
    expect.objectContaining({ attempt: 2, provided: true, value: { path: "a" } }),
  ]);
});

test("a stage that failed and then succeeded keeps both lines, and its last is the success", async () => {
  const lines = await wrote(new Lines(), 1, line("qa", 1, { outcome: "failed" }));
  const ledger = ledgerOf(lines, 2);
  await (await run(ledger, "qa")).succeed(undefined);
  const qa = lines.view.stages.qa;
  expect(qa?.history.map(({ attempt, outcome }) => [attempt, outcome])).toEqual([
    [1, "failed"],
    [2, "succeeded"],
  ]);
  expect(qa?.last).toBe(qa?.settled);
  expect(qa?.last).toMatchObject({ attempt: 2, outcome: "succeeded" });
});

test("a line from another major version stops the attempt; the version is its attempt's", async () => {
  const lines = await wrote(new Lines(), 1, line("plan", 1));
  const ledger = ledgerOf(lines, 2, {
    workflowVersion: "2.0.0",
    versions: new Map([[1, "1.4.0"]]),
  });
  await expect(ledger.enter("plan", { summary: () => undefined })).rejects.toThrow(
    "plan was recorded by 1.4.0; this is 2.0.0",
  );
});

test("a line an earlier attempt appended after a later claim is fenced, and not reused", async () => {
  const runDir = runDirs.tempRunDir();
  const one = await claimRunLines(runDir, 1, new Date().toISOString());
  await one.append(line("plan", 1));
  const two = await claimRunLines(runDir, 2, new Date().toISOString());
  // Attempt 1's process, thought gone, finishes a stage after attempt 2 claimed the run.
  await one.append(line("build", 1));
  const { view } = await readRunLines(runDir);
  expect(view.fenced).toBe(1);
  const ledger = new StageLedger({ lines: two, run: view });
  const plan = await ledger.enter("plan", { summary: () => undefined });
  expect(plan.kind).toBe("reuse");
  if (plan.kind === "reuse") plan.release();
  expect((await ledger.enter("build", { summary: () => undefined })).kind).toBe("run");
});

test("a reused stage shows the view when its line was written, without its value", async () => {
  const record = line("plan", 1, { value: { path: "docs/a.md" } });
  const lines = await wrote(new Lines(), 1, record);
  const ledger = ledgerOf(lines, 2, { fromStage: "mr" });
  const entered = await ledger.enter("plan", { result: PATH, summary: () => undefined });
  expect(entered).toMatchObject({ kind: "reuse", value: { path: "docs/a.md" } });
  if (entered.kind === "reuse") entered.release();
  const [shown] = ledger.progress().stages;
  expect(shown).toMatchObject({ source: "reused", recordedAt: Date.parse(record.at) });
  expect(shown).not.toHaveProperty("value");
  expect(ledger.summaries).toEqual([
    {
      stage: "plan",
      source: "reused",
      outcome: "succeeded",
      attempt: 1,
      spanMs: 0,
      value: { path: "docs/a.md" },
    },
  ]);
});

describe("stages by content, in a run with events", () => {
  const byContent = (lines: Lines, attempt: number) =>
    ledgerOf(lines, attempt, { byContent: true, workflowVersion: `${attempt}.0.0` });
  const enter = (ledger: StageLedger, name: string, result?: JsonSchema) =>
    ledger.enter(name, { ...(result ? { result } : {}), summary: () => undefined });

  test("a stage entered twice in one attempt runs once, and the second gets its value", async () => {
    const ledger = byContent(new Lines(), 1);
    const first = await enter(ledger, "close-e1", PATH);
    if (first.kind !== "run") throw new Error("reused");
    await first.stage.succeed({ path: "a" });
    const again = await enter(ledger, "close-e1", PATH);
    expect(again).toMatchObject({ kind: "reuse", value: { path: "a" } });
    if (again.kind === "reuse") again.release();
    expect(ledger.summaries.map((s) => [s.stage, s.source])).toEqual([["close-e1", "ran"]]);
  });

  test("a continue that runs a new stage first still reuses the old ones after it", async () => {
    const lines = new Lines();
    const one = byContent(lines, 1);
    const old = await enter(one, "post-f1@abc", PATH);
    if (old.kind !== "run") throw new Error("reused");
    await old.stage.succeed({ path: "p" });
    await one.close();

    const two = byContent(lines, 2);
    const fresh = await enter(two, "post-f2@def", PATH);
    expect(fresh.kind).toBe("run");
    if (fresh.kind === "run") await fresh.stage.succeed({ path: "q" });
    // Written under 1.0.0 and entered under 2.0.0: reused, as its value still fits.
    const reused = await enter(two, "post-f1@abc", PATH);
    expect(reused).toMatchObject({ kind: "reuse", value: { path: "p" } });
    if (reused.kind === "reuse") reused.release();
    await two.close();
    expect(Object.keys(lines.view.stages).sort()).toEqual(["post-f1@abc", "post-f2@def"]);
  });

  test("a failed stage runs again, each end its own line, twice in one attempt too", async () => {
    const lines = new Lines();
    const one = byContent(lines, 1);
    const failing = await enter(one, "notify");
    if (failing.kind !== "run") throw new Error("reused");
    await failing.stage.fail("slack down");
    await one.close();

    const two = byContent(lines, 2);
    for (const reason of ["still down", "down again"]) {
      const entered = await enter(two, "notify");
      if (entered.kind !== "run") throw new Error("reused");
      await entered.stage.fail(reason);
    }
    const last = await enter(two, "notify");
    if (last.kind !== "run") throw new Error("reused");
    await last.stage.succeed(undefined);
    await two.close();

    const notify = lines.view.stages.notify;
    expect(
      notify?.history.map(({ attempt, outcome, reason }) => [attempt, outcome, reason]),
    ).toEqual([
      [1, "failed", "slack down"],
      [2, "failed", "still down"],
      [2, "failed", "down again"],
      [2, "succeeded", undefined],
    ]);
    expect(notify?.last).toBe(notify?.settled);
    // Reused from now on.
    expect((await enter(byContent(lines, 3), "notify")).kind).toBe("reuse");
  });

  test("a line whose value no longer fits stops the attempt", async () => {
    const lines = new Lines();
    const one = byContent(lines, 1);
    const entered = await enter(one, "write-up");
    if (entered.kind !== "run") throw new Error("reused");
    await entered.stage.succeed("text");
    await one.close();
    const two = byContent(lines, 2);
    await expect(enter(two, "write-up", PATH)).rejects.toThrow(
      "write-up's line no longer fits its result schema",
    );
  });

  test("a misfit stops the attempt whatever the version, and the view shows it stopped", async () => {
    const lines = new Lines();
    const one = ledgerOf(lines, 1, { byContent: true, workflowVersion: "1.0.0" });
    const entered = await enter(one, "write-up");
    if (entered.kind !== "run") throw new Error("reused");
    await entered.stage.succeed("text");
    await one.close();
    const two = ledgerOf(lines, 2, { byContent: true, workflowVersion: "1.0.0" });
    const stopped = await enter(two, "write-up", PATH).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(WorkflowStopped);
    expect(two.summaries).toMatchObject([{ stage: "write-up", outcome: "stopped" }]);
  });

  test("the event log: a reuse across attempts once, none within one, and nothing upcoming", async () => {
    const lines = new Lines();
    const one = byContent(lines, 1);
    const ran = await enter(one, "close-e1");
    if (ran.kind !== "run") throw new Error("reused");
    await ran.stage.succeed(undefined);
    await one.close();
    const logged: RunEventBody[] = [];
    const two = ledgerOf(lines, 2, { byContent: true, event: (body) => logged.push(body) });
    for (let i = 0; i < 2; i++) {
      const again = await enter(two, "close-e1");
      if (again.kind === "reuse") again.release();
    }
    expect(logged).toEqual([
      { kind: "stage-ended", stage: "close-e1", outcome: "succeeded", source: "reused" },
    ]);
    expect(byContent(lines, 3).progress().upcoming).toEqual([]);
  });

  /**
   * A run's attempts as a script: each one entered stages in order, `ok` or `fail`, or `crash`,
   * where its process dies with the stage running and writes no line, with the `--from-stage` it
   * was given; each reads the lines as a later attempt does.
   */
  const story = (lines: Lines) => {
    let attempt = 0;
    return async (
      steps: readonly (readonly [string, "ok" | "fail" | "crash"])[],
      fromStage?: string,
    ): Promise<{ ran: string[]; reused: string[] }> => {
      attempt += 1;
      const ledger = ledgerOf(lines, attempt, {
        byContent: true,
        ...(fromStage === undefined ? {} : { fromStage }),
      });
      const ran: string[] = [];
      const reused: string[] = [];
      for (const [name, how] of steps) {
        const entered = await enter(ledger, name);
        if (entered.kind === "reuse") {
          reused.push(name);
          entered.release();
          continue;
        }
        ran.push(name);
        if (how === "crash") return { ran, reused };
        if (how === "ok") await entered.stage.succeed(undefined);
        else await entered.stage.fail("caught");
      }
      await ledger.close();
      return { ran, reused };
    };
  };
  /** Each stage's latest line's attempt. */
  const attemptsOf = (lines: Lines) =>
    Object.fromEntries(
      Object.entries(lines.view.stages).map(([name, s]) => [name, s.last.attempt]),
    );
  const historyOf = (lines: Lines, name: string) =>
    lines.view.stages[name]?.history.map((each) => each.attempt);

  test("--from-stage reuses what comes before it, and reruns it and each stage after it as reached", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([
      ["plan", "ok"],
      ["build", "ok"],
      ["ship", "ok"],
    ]);
    const redo = await attempt(
      [
        ["plan", "ok"],
        ["build", "ok"],
        ["ship", "ok"],
        ["build", "ok"],
      ],
      "build",
    );
    // Entered again by content after the redo: this attempt's line.
    expect(redo).toEqual({ ran: ["build", "ship"], reused: ["plan", "build"] });
    expect(attemptsOf(lines)).toEqual({ plan: 1, build: 2, ship: 2 });
    expect([historyOf(lines, "build"), historyOf(lines, "ship")]).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(lines.view.stages.build?.last.redo).toBe(true);
    expect(lines.view.redo).toEqual({ attempt: 2, stage: "build" });
  });

  test("a stage later in the program but earlier on the clock reruns: a caught failure before it", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    // S fails, caught, and X runs; a wake runs S again and reuses X, so X's line is the older.
    await attempt([
      ["s", "fail"],
      ["x", "ok"],
    ]);
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    expect(attemptsOf(lines)).toEqual({ s: 2, x: 1 });
    const redo = await attempt(
      [
        ["s", "ok"],
        ["x", "ok"],
      ],
      "s",
    );
    expect(redo.ran).toEqual(["s", "x"]);
    expect(attemptsOf(lines)).toEqual({ s: 3, x: 3 });
  });

  test("a stage later in the program but earlier on the clock reruns: a new version adds S before it", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([["x", "ok"]]);
    // Version 2 adds S before X: S runs, X is reused, its line the older.
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    const redo = await attempt(
      [
        ["s", "ok"],
        ["x", "ok"],
      ],
      "s",
    );
    expect(redo.ran).toEqual(["s", "x"]);
  });

  test("lines written in the same millisecond are told apart by attempt, not time", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([
      ["a", "ok"],
      ["b", "ok"],
    ]);
    for (const [n, each] of lines.all.entries()) {
      const written = each as RunLine;
      if (written.kind === "stage") {
        const at = "2026-11-01T00:00:00.000Z";
        lines.all[n] = { ...written, started: at, at };
      }
    }
    const redo = await attempt(
      [
        ["a", "ok"],
        ["b", "ok"],
      ],
      "a",
    );
    expect(redo.ran).toEqual(["a", "b"]);
  });

  test("a redo that parks after its stage carries to the next attempt, which reruns what follows", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    // Redone from S, parked at a wait before X.
    expect(await attempt([["s", "ok"]], "s")).toEqual({ ran: ["s"], reused: [] });
    // A wake, with no flag: X's line is older than the redo, so it reruns; S is reused.
    expect(
      await attempt([
        ["s", "ok"],
        ["x", "ok"],
      ]),
    ).toEqual({ ran: ["x"], reused: ["s"] });
    // And after that, both are reused.
    expect(
      await attempt([
        ["s", "ok"],
        ["x", "ok"],
      ]),
    ).toEqual({ ran: [], reused: ["s", "x"] });
  });

  test("stages before the redo's stage, or never entered after it, keep their lines", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    // A receive loop: a stage per event, whose batch is acknowledged and never handed back.
    await attempt([
      ["handle-e1", "ok"],
      ["sync", "ok"],
      ["handle-e2", "ok"],
    ]);
    const redo = await attempt(
      [
        ["handle-e1", "ok"],
        ["sync", "ok"],
      ],
      "sync",
    );
    expect(redo).toEqual({ ran: ["sync"], reused: ["handle-e1"] });
    expect(attemptsOf(lines)).toEqual({ "handle-e1": 1, sync: 2, "handle-e2": 1 });
    expect(historyOf(lines, "sync")).toEqual([1, 2]);
  });

  test("a later --from-stage supersedes an earlier one", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([
      ["s", "ok"],
      ["t", "ok"],
      ["x", "ok"],
    ]);
    await attempt([["s", "ok"]], "s");
    // Redone from T: X, older than both redos, reruns after T; S, whose line is attempt 2's, stays.
    expect(
      await attempt(
        [
          ["s", "ok"],
          ["t", "ok"],
          ["x", "ok"],
        ],
        "t",
      ),
    ).toEqual({ ran: ["t", "x"], reused: ["s"] });
    expect(lines.view.redo).toEqual({ stage: "t", attempt: 3 });
  });

  test("a redo whose stage failed and ran again on a wake is still the redo", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    await attempt([["s", "fail"]], "s");
    expect(
      await attempt([
        ["s", "ok"],
        ["x", "ok"],
      ]),
    ).toEqual({ ran: ["s", "x"], reused: [] });
  });

  test("a redo whose attempt dies while its stage runs leaves the old line, and no redo", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    await attempt([["s", "crash"]], "s");
    expect(attemptsOf(lines)).toEqual({ s: 1, x: 1 });
    // Nothing was redone: the wakes after it reuse both, and the operator issues it again.
    for (let n = 0; n < 2; n++)
      expect(
        await attempt([
          ["s", "ok"],
          ["x", "ok"],
        ]),
      ).toEqual({ ran: [], reused: ["s", "x"] });
    expect(
      await attempt(
        [
          ["s", "ok"],
          ["x", "ok"],
        ],
        "s",
      ),
    ).toEqual({ ran: ["s", "x"], reused: [] });
  });

  test("a redo whose attempt dies after its stage's line is written still holds", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    await attempt(
      [
        ["s", "ok"],
        ["x", "crash"],
      ],
      "s",
    );
    expect(
      await attempt([
        ["s", "ok"],
        ["x", "ok"],
      ]),
    ).toEqual({ ran: ["x"], reused: ["s"] });
  });

  test("a --from-stage that stopped never reached is no redo, though a wake later runs its stage", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([["x", "ok"]]);
    // Stopped "never reached s": s isn't in the code yet.
    await attempt([["x", "ok"]], "s");
    // A new version adds s, which a wake runs for the first time, after the stopped attempt.
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    expect(
      await attempt([
        ["s", "ok"],
        ["x", "ok"],
      ]),
    ).toEqual({ ran: [], reused: ["s", "x"] });
  });

  test("a stage entered before the redo's stage and again after it runs once in the attempt", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([
      ["x", "ok"],
      ["s", "ok"],
    ]);
    expect(
      await attempt(
        [
          ["x", "ok"],
          ["s", "ok"],
          ["x", "ok"],
        ],
        "s",
      ),
    ).toEqual({ ran: ["s"], reused: ["x", "x"] });
  });

  test("a --from-stage stage that fails and runs again in its attempt is the redo once", async () => {
    const lines = new Lines();
    const attempt = story(lines);
    await attempt([["s", "ok"]]);
    await attempt(
      [
        ["s", "fail"],
        ["s", "ok"],
      ],
      "s",
    );
    expect(
      lines.view.stages.s?.history.map(({ attempt: n, outcome, redo }) => [n, outcome, redo]),
    ).toEqual([
      [1, "succeeded", undefined],
      [2, "failed", true],
      [2, "succeeded", undefined],
    ]);
    expect(lines.view.redo).toEqual({ attempt: 2, stage: "s" });
  });

  test("without events, a name is still entered once per attempt", async () => {
    const ledger = ledgerOf(new Lines(), 1);
    await (await run(ledger, "qa")).succeed(undefined);
    await expect(run(ledger, "qa")).rejects.toThrow("stage qa was entered twice");
  });
});

describe("a redo without events", () => {
  /** Enters each stage in order, `ok`, `fail` caught by the code, or `crash` with it running. */
  const attempt = async (
    lines: Lines,
    n: number,
    steps: readonly (readonly [string, "ok" | "fail" | "crash"])[],
  ) => {
    const ledger = ledgerOf(lines, n);
    const ran: string[] = [];
    for (const [name, how] of steps) {
      const entered = await ledger.enter(name, { summary: () => undefined });
      if (entered.kind === "reuse") {
        entered.release();
        continue;
      }
      ran.push(name);
      if (how === "crash") return ran;
      if (how === "ok") await entered.stage.succeed(undefined);
      else await entered.stage.fail("caught");
    }
    await ledger.close();
    return ran;
  };

  test("every start point is a redo: what a crash after it left older reruns", async () => {
    const lines = new Lines();
    // b fails and the code goes on; d fails the attempt.
    expect(
      await attempt(lines, 1, [
        ["a", "ok"],
        ["b", "fail"],
        ["c", "ok"],
        ["d", "fail"],
      ]),
    ).toEqual(["a", "b", "c", "d"]);
    // A continue starts at b, the first stage it doesn't reuse, and dies in c.
    expect(
      await attempt(lines, 2, [
        ["a", "ok"],
        ["b", "ok"],
        ["c", "crash"],
      ]),
    ).toEqual(["b", "c"]);
    expect(lines.view.redo).toEqual({ attempt: 2, stage: "b" });
    // c's line is attempt 1's, made against the b that failed: it runs, and d after it.
    expect(
      await attempt(lines, 3, [
        ["a", "ok"],
        ["b", "ok"],
        ["c", "ok"],
        ["d", "ok"],
      ]),
    ).toEqual(["c", "d"]);
  });

  test("carries to a later continue: what follows its stage, older than it, runs again", async () => {
    const lines = await wrote(new Lines(), 1, line("a", 1), line("b", 1), line("c", 1));
    // `--from-stage b`, which dies once b's line is written.
    await wrote(lines, 2, line("b", 2, { redo: true }));
    const ledger = ledgerOf(lines, 3);
    const kinds: string[] = [];
    for (const name of ["a", "b", "c"]) {
      const entered = await ledger.enter(name, { summary: () => undefined });
      kinds.push(entered.kind);
      if (entered.kind === "reuse") entered.release();
      else await entered.stage.succeed(undefined);
    }
    expect(kinds).toEqual(["reuse", "reuse", "run"]);
  });
});
