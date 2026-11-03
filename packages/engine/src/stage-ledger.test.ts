import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StageRecord, TurnRecord } from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
import type { RunEventBody } from "./run-event-log";
import { readStageRecords } from "./runs";
import { type OpenStage, StageLedger } from "./stage-ledger";
import { lastRedo } from "./stage-plan";
import { WorkflowStopped } from "./stopped";

import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

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

const turn = (stage: string | undefined, session: string): TurnRecord => ({
  version: 1,
  attempt: 1,
  kind: "turn",
  agent: "worker",
  operationId: session,
  execution: { harness: "codex", model: "m" },
  ...(stage === undefined ? {} : { stage }),
  outcome: "answered",
  // The agent's sessions as of then: an earlier one, then the one it ran on.
  sessions: [
    { harness: "codex", id: "s0" },
    { harness: "codex", id: session },
  ],
});

test("a stage's sessions are the ones its own turns ran on", async () => {
  const runDir = runDirs.tempRunDir();
  const turns = [turn("doc-review", "s1"), turn(undefined, "s2"), turn("implement", "s3")];
  const ledger = new StageLedger({ runDir, attempt: 1, turns: () => turns });
  await (await run(ledger, "doc-review")).succeed(undefined);
  await (await run(ledger, "implement")).succeed(undefined);
  const records = await readStageRecords(runDir);
  expect(records.get("doc-review")?.sessions).toEqual([
    { agent: "worker", harness: "codex", session: "s1" },
  ]);
  expect(records.get("implement")?.sessions).toEqual([
    { agent: "worker", harness: "codex", session: "s3" },
  ]);
});

test("closing waits for a record already being written, and ends a stage once", async () => {
  const runDir = runDirs.tempRunDir();
  const ledger = new StageLedger({ runDir, attempt: 1, turns: () => [] });
  const qa = await run(ledger, "qa");
  void qa.fail("qa broke");
  await ledger.close();
  expect((await readStageRecords(runDir)).get("qa")).toMatchObject({
    outcome: "failed",
    reason: "qa broke",
  });
  // A later end changes nothing.
  await qa.succeed(undefined);
  expect((await readStageRecords(runDir)).get("qa")).toMatchObject({ outcome: "failed" });
});

test("a sealed ledger fails the open stage with its reason when closed, and enters no other", async () => {
  const runDir = runDirs.tempRunDir();
  const ledger = new StageLedger({ runDir, attempt: 1, turns: () => [] });
  await run(ledger, "qa");
  ledger.seal("Deadline exceeded");
  await expect(run(ledger, "mr")).rejects.toThrow(
    "stage mr was entered after the workflow ended: Deadline exceeded",
  );
  await ledger.close();
  expect([...(await readStageRecords(runDir)).values()]).toEqual([
    expect.objectContaining({ stage: "qa", outcome: "failed", reason: "Deadline exceeded" }),
  ]);
  expect(ledger.summaries.map(({ stage, outcome }) => [stage, outcome])).toEqual([
    ["qa", "failed"],
  ]);
});

test("a misuse leaves no stage entered or open", async () => {
  const ledger = new StageLedger({ runDir: runDirs.tempRunDir(), attempt: 1, turns: () => [] });
  await expect(run(ledger, "Bad")).rejects.toThrow("is not a stage's name");
  const qa = await run(ledger, "qa");
  await expect(run(ledger, "mr")).rejects.toThrow("while stage qa is open");
  await qa.succeed(undefined);
  await expect(run(ledger, "qa")).rejects.toThrow("entered twice");
  await (await run(ledger, "mr")).succeed(undefined);
  expect(ledger.progress().stages.map(({ stage }) => stage)).toEqual(["qa", "mr"]);
});

test("a stage whose start point can't move the records it outdates is not entered, and leaves none open", async () => {
  const runDir = runDirs.tempRunDir();
  await mkdir(join(runDir, "stages"));
  await writeFile(join(runDir, "stages", "old.json"), "torn");
  const ledger = new StageLedger({ runDir, attempt: 2, turns: () => [] });
  await expect(run(ledger, "qa")).rejects.toThrow("old.json could not be read");
  await rm(join(runDir, "stages", "old.json"));
  await (await run(ledger, "mr")).succeed(undefined);
  await ledger.close();
  expect([...(await readStageRecords(runDir)).keys()]).toEqual(["mr"]);
  expect(ledger.progress().stages.map(({ stage }) => stage)).toEqual(["mr"]);
});

test("closing waits for every record without reporting again one its stage already threw", async () => {
  const runDir = runDirs.tempRunDir();
  const ledger = new StageLedger({ runDir, attempt: 1, turns: () => [] });
  const qa = await run(ledger, "qa");
  // A file where the folder goes: every record from now on fails to be written.
  await writeFile(join(runDir, "stages"), "");
  await expect(qa.succeed(undefined)).rejects.toThrow();
  const mr = await run(ledger, "mr");
  void mr.succeed(undefined).catch(() => undefined);
  await ledger.close();
  expect(ledger.summaries).toMatchObject([
    { stage: "qa", outcome: "failed" },
    { stage: "mr", outcome: "failed" },
  ]);
  // The stage still open when the attempt ends is closing's own to report.
  const other = runDirs.tempRunDir();
  const open = new StageLedger({ runDir: other, attempt: 1, turns: () => [] });
  await run(open, "qa");
  await writeFile(join(other, "stages"), "");
  await expect(open.close()).rejects.toThrow();
});

test("a stage the plan stops as it is entered shows stopped, in the view as in the summaries", async () => {
  const record = {
    version: 1 as const,
    stage: "qa",
    attempt: 1,
    outcome: "failed" as const,
    started: "2026-10-04T10:00:00Z",
    ended: "2026-10-04T10:01:00Z",
    sessions: [],
  };
  const ledger = new StageLedger({
    runDir: runDirs.tempRunDir(),
    attempt: 2,
    turns: () => [],
    records: new Map([["qa", record]]),
    fromStage: "mr",
  });
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
});

test("a value given is recorded as provided, handed back, and kept at the start point", async () => {
  const runDir = runDirs.tempRunDir();
  const ledger = new StageLedger({
    runDir,
    attempt: 1,
    turns: () => [],
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
  const records = await readStageRecords(runDir);
  expect(records.get("plan")).toMatchObject({
    attempt: 1,
    outcome: "succeeded",
    summary: "docs/a.md",
    value: { path: "docs/a.md" },
    provided: true,
    sessions: [],
  });
  expect(records.get("notify")).toMatchObject({ outcome: "succeeded", provided: true });
  expect(records.get("notify")).not.toHaveProperty("value");
  expect(
    ledger.summaries.map(({ stage, source, provided }) => ({ stage, source, provided })),
  ).toEqual([
    { stage: "plan", source: "reused", provided: true },
    { stage: "notify", source: "reused", provided: true },
    { stage: "qa", source: "ran", provided: undefined },
  ]);
});

test("a stage with no value hands back a stand-in, and the start point stops for every one missing", async () => {
  const ledger = new StageLedger({
    runDir: runDirs.tempRunDir(),
    attempt: 1,
    turns: () => [],
    fromStage: "qa",
  });
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

test("a stage provided is open while its record is written: none enters beside it", async () => {
  const ledger = new StageLedger({
    runDir: runDirs.tempRunDir(),
    attempt: 1,
    turns: () => [],
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
  const ledger = new StageLedger({
    runDir: runDirs.tempRunDir(),
    attempt: 1,
    turns: () => [],
    fromStage: "qa",
  });
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

test("a value given over a failed record keeps that record in replaced/", async () => {
  const runDir = runDirs.tempRunDir();
  const failed = {
    version: 1 as const,
    stage: "plan",
    attempt: 1,
    outcome: "failed" as const,
    reason: "broke",
    started: "2026-10-04T10:00:00Z",
    ended: "2026-10-04T10:01:00Z",
    sessions: [],
  };
  await mkdir(join(runDir, "stages"), { recursive: true });
  await writeFile(join(runDir, "stages", "plan.json"), JSON.stringify(failed));
  const ledger = new StageLedger({
    runDir,
    attempt: 2,
    turns: () => [],
    records: new Map([["plan", failed]]),
    fromStage: "qa",
    values: new Map([["plan", { path: "a" }]]),
  });
  const plan = await ledger.enter("plan", { result: PATH, summary: () => undefined });
  if (plan.kind === "reuse") plan.release();
  expect((await readStageRecords(runDir)).get("plan")).toMatchObject({
    attempt: 2,
    provided: true,
  });
  expect(JSON.parse(await Bun.file(join(runDir, "replaced", "plan.1.json")).text())).toEqual(
    failed,
  );
});

test("a reused stage shows the view when its record ended, without its value", async () => {
  const record = {
    version: 1 as const,
    stage: "plan",
    attempt: 1,
    outcome: "succeeded" as const,
    started: "2026-10-04T10:00:00Z",
    ended: "2026-10-04T10:01:00Z",
    sessions: [],
    value: { path: "docs/a.md" },
  };
  const ledger = new StageLedger({
    runDir: runDirs.tempRunDir(),
    attempt: 2,
    turns: () => [],
    records: new Map([["plan", record]]),
    fromStage: "mr",
  });
  const entered = await ledger.enter("plan", { result: PATH, summary: () => undefined });
  expect(entered).toMatchObject({ kind: "reuse", value: { path: "docs/a.md" } });
  if (entered.kind === "reuse") entered.release();
  const [shown] = ledger.progress().stages;
  expect(shown).toMatchObject({ source: "reused", recordedAt: Date.parse(record.ended) });
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
  const byContent = (runDir: string, attempt: number, records?: Map<string, StageRecord>) =>
    new StageLedger({
      runDir,
      attempt,
      turns: () => [],
      byContent: true,
      workflowVersion: `${attempt}.0.0`,
      ...(records ? { records } : {}),
    });
  const enter = (ledger: StageLedger, name: string, result?: JsonSchema) =>
    ledger.enter(name, { ...(result ? { result } : {}), summary: () => undefined });

  test("a stage entered twice in one attempt runs once, and the second gets its value", async () => {
    const runDir = runDirs.tempRunDir();
    const ledger = byContent(runDir, 1);
    const first = await enter(ledger, "close-e1", PATH);
    if (first.kind !== "run") throw new Error("reused");
    await first.stage.succeed({ path: "a" });
    const again = await enter(ledger, "close-e1", PATH);
    expect(again).toMatchObject({ kind: "reuse", value: { path: "a" } });
    if (again.kind === "reuse") again.release();
    expect(ledger.summaries.map((s) => [s.stage, s.source])).toEqual([["close-e1", "ran"]]);
  });

  test("a continue that runs a new stage first still reuses the old ones after it", async () => {
    const runDir = runDirs.tempRunDir();
    const one = byContent(runDir, 1);
    const old = await enter(one, "post-f1@abc", PATH);
    if (old.kind !== "run") throw new Error("reused");
    await old.stage.succeed({ path: "p" });
    await one.close();

    const two = byContent(runDir, 2, await readStageRecords(runDir));
    const fresh = await enter(two, "post-f2@def", PATH);
    expect(fresh.kind).toBe("run");
    if (fresh.kind === "run") await fresh.stage.succeed({ path: "q" });
    // Recorded under 1.0.0 and entered under 2.0.0: reused, as its value still fits.
    const reused = await enter(two, "post-f1@abc", PATH);
    expect(reused).toMatchObject({ kind: "reuse", value: { path: "p" } });
    if (reused.kind === "reuse") reused.release();
    await two.close();
    expect([...(await readStageRecords(runDir)).keys()].sort()).toEqual([
      "post-f1@abc",
      "post-f2@def",
    ]);
  });

  test("a failed stage runs again, its record replaced and kept, twice in one attempt too", async () => {
    const runDir = runDirs.tempRunDir();
    const one = byContent(runDir, 1);
    const failing = await enter(one, "notify");
    if (failing.kind !== "run") throw new Error("reused");
    await failing.stage.fail("slack down");
    await one.close();

    const two = byContent(runDir, 2, await readStageRecords(runDir));
    for (const reason of ["still down", "down again"]) {
      const entered = await enter(two, "notify");
      if (entered.kind !== "run") throw new Error("reused");
      await entered.stage.fail(reason);
    }
    const last = await enter(two, "notify");
    if (last.kind !== "run") throw new Error("reused");
    await last.stage.succeed(undefined);
    await two.close();

    expect((await readStageRecords(runDir)).get("notify")).toMatchObject({
      outcome: "succeeded",
      attempt: 2,
    });
    expect((await readdir(join(runDir, "replaced"))).sort()).toEqual([
      "notify.1.json",
      "notify.2+2.json",
      "notify.2.json",
    ]);
  });

  test("a record whose value no longer fits stops the attempt", async () => {
    const runDir = runDirs.tempRunDir();
    const one = byContent(runDir, 1);
    const entered = await enter(one, "write-up");
    if (entered.kind !== "run") throw new Error("reused");
    await entered.stage.succeed("text");
    await one.close();
    const two = byContent(runDir, 2, await readStageRecords(runDir));
    await expect(enter(two, "write-up", PATH)).rejects.toThrow(
      "write-up's record no longer fits its result schema",
    );
  });

  test("a misfit stops the attempt whatever the version, and the view shows it stopped", async () => {
    const runDir = runDirs.tempRunDir();
    const one = new StageLedger({
      runDir,
      attempt: 1,
      turns: () => [],
      byContent: true,
      workflowVersion: "1.0.0",
    });
    const entered = await enter(one, "write-up");
    if (entered.kind !== "run") throw new Error("reused");
    await entered.stage.succeed("text");
    await one.close();
    const two = new StageLedger({
      runDir,
      attempt: 2,
      turns: () => [],
      byContent: true,
      workflowVersion: "1.0.0",
      records: await readStageRecords(runDir),
    });
    const stopped = await enter(two, "write-up", PATH).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(WorkflowStopped);
    expect(two.summaries).toMatchObject([{ stage: "write-up", outcome: "stopped" }]);
  });

  test("the event log: a reuse across attempts once, none within one, and nothing upcoming", async () => {
    const runDir = runDirs.tempRunDir();
    const one = byContent(runDir, 1);
    const ran = await enter(one, "close-e1");
    if (ran.kind !== "run") throw new Error("reused");
    await ran.stage.succeed(undefined);
    await one.close();
    const lines: RunEventBody[] = [];
    const two = new StageLedger({
      runDir,
      attempt: 2,
      turns: () => [],
      byContent: true,
      records: await readStageRecords(runDir),
      event: (body) => lines.push(body),
    });
    for (let i = 0; i < 2; i++) {
      const again = await enter(two, "close-e1");
      if (again.kind === "reuse") again.release();
    }
    expect(lines).toEqual([
      { kind: "stage-ended", stage: "close-e1", outcome: "succeeded", source: "reused" },
    ]);
    expect(byContent(runDir, 3, await readStageRecords(runDir)).progress().upcoming).toEqual([]);
  });

  /**
   * A run's attempts as a script: each one entered stages in order, `ok` or `fail`, or `crash`,
   * where its process dies with the stage running and its attempt record keeps no stages, with the
   * `--from-stage` it was given; each sees the redo `lastRedo` finds as a later attempt does.
   */
  const story = (runDir: string) => {
    const attempts: {
      attempt: number;
      flags: { fromStage?: string };
      stages?: { stage: string; source: "ran" | "reused" }[];
    }[] = [];
    return async (
      steps: readonly (readonly [string, "ok" | "fail" | "crash"])[],
      fromStage?: string,
    ): Promise<{ ran: string[]; reused: string[] }> => {
      const attempt = attempts.length + 1;
      const records = await readStageRecords(runDir);
      const redo = lastRedo(attempts, records, attempt);
      const record: (typeof attempts)[number] = {
        attempt,
        flags: fromStage === undefined ? {} : { fromStage },
      };
      attempts.push(record);
      const ledger = new StageLedger({
        runDir,
        attempt,
        turns: () => [],
        byContent: true,
        records,
        ...(fromStage === undefined ? {} : { fromStage }),
        ...(redo === undefined ? {} : { redo }),
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
      record.stages = ledger.summaries.map(({ stage, source }) => ({ stage, source }));
      return { ran, reused };
    };
  };
  const attemptsOf = async (runDir: string) =>
    Object.fromEntries([...(await readStageRecords(runDir))].map(([name, r]) => [name, r.attempt]));

  test("--from-stage reuses what comes before it, and reruns it and each stage after it as reached", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
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
    // Entered again by content after the redo: this attempt's record.
    expect(redo).toEqual({ ran: ["build", "ship"], reused: ["plan", "build"] });
    expect(await attemptsOf(runDir)).toEqual({ plan: 1, build: 2, ship: 2 });
    expect((await readdir(join(runDir, "replaced"))).sort()).toEqual([
      "build.1.json",
      "ship.1.json",
    ]);
  });

  test("a stage later in the program but earlier on the clock reruns: a caught failure before it", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
    // S fails, caught, and X runs; a wake runs S again and reuses X, so X's record is the older.
    await attempt([
      ["s", "fail"],
      ["x", "ok"],
    ]);
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    expect(await attemptsOf(runDir)).toEqual({ s: 2, x: 1 });
    const redo = await attempt(
      [
        ["s", "ok"],
        ["x", "ok"],
      ],
      "s",
    );
    expect(redo.ran).toEqual(["s", "x"]);
    expect(await attemptsOf(runDir)).toEqual({ s: 3, x: 3 });
  });

  test("a stage later in the program but earlier on the clock reruns: a new version adds S before it", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
    await attempt([["x", "ok"]]);
    // Version 2 adds S before X: S runs, X is reused, its record the older.
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

  test("records written in the same millisecond are told apart by attempt, not time", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
    await attempt([
      ["a", "ok"],
      ["b", "ok"],
    ]);
    const records = await readStageRecords(runDir);
    for (const record of records.values())
      await writeFile(
        join(runDir, "stages", `${record.stage}.json`),
        JSON.stringify({
          ...record,
          started: "2026-11-01T00:00:00.000Z",
          ended: "2026-11-01T00:00:00.000Z",
        }),
      );
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
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    // Redone from S, parked at a wait before X.
    expect(await attempt([["s", "ok"]], "s")).toEqual({ ran: ["s"], reused: [] });
    // A wake, with no flag: X's record is older than the redo, so it reruns; S is reused.
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

  test("stages before the redo's stage, or never entered after it, keep their records", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
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
    expect(await attemptsOf(runDir)).toEqual({ "handle-e1": 1, sync: 2, "handle-e2": 1 });
    expect(await readdir(join(runDir, "replaced"))).toEqual(["sync.1.json"]);
  });

  test("a later --from-stage supersedes an earlier one", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
    await attempt([
      ["s", "ok"],
      ["t", "ok"],
      ["x", "ok"],
    ]);
    await attempt([["s", "ok"]], "s");
    // Redone from T: X, older than both redos, reruns after T; S, whose record is attempt 2's, stays.
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
    expect(
      lastRedo(
        [
          { attempt: 2, flags: { fromStage: "s" } },
          { attempt: 3, flags: { fromStage: "t" } },
        ],
        await readStageRecords(runDir),
        4,
      ),
    ).toEqual({ stage: "t", attempt: 3 });
  });

  test("a redo whose stage failed and ran again on a wake is still the redo", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
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

  test("a redo whose attempt dies while its stage runs leaves the old record, and no redo", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
    await attempt([
      ["s", "ok"],
      ["x", "ok"],
    ]);
    await attempt([["s", "crash"]], "s");
    expect(await attemptsOf(runDir)).toEqual({ s: 1, x: 1 });
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

  test("a redo whose attempt dies after its stage's record is written still holds", async () => {
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
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
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
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
    const runDir = runDirs.tempRunDir();
    const attempt = story(runDir);
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

  test("without events, a name is still entered once per attempt", async () => {
    const runDir = runDirs.tempRunDir();
    const ledger = new StageLedger({ runDir, attempt: 1, turns: () => [] });
    await (await run(ledger, "qa")).succeed(undefined);
    await expect(run(ledger, "qa")).rejects.toThrow("stage qa was entered twice");
  });
});
