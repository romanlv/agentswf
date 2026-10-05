import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnRecord } from "@agentswf/contract/records";
import type { JsonSchema } from "@agentswf/contract/schema";
import { readStageRecords } from "./runs";
import { type OpenStage, StageLedger } from "./stage-ledger";

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
