import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnRecord } from "@agentswf/contract/records";
import { readStageRecords } from "./runs";
import { type OpenStage, StageLedger } from "./stage-ledger";

import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

/** Enters `name` to run it, as a stage with nothing recorded is. */
async function run(ledger: StageLedger, name: string): Promise<OpenStage> {
  const entered = await ledger.enter(name, () => undefined);
  if (entered.kind !== "run") throw new Error(`${name} was reused`);
  return entered.stage;
}

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
  await expect(run(ledger, "qa")).rejects.toThrow("qa did not succeed in attempt 1");
  expect(ledger.summaries).toEqual([
    { stage: "qa", source: "ran", outcome: "stopped", attempt: 2, spanMs: 0 },
  ]);
  expect(ledger.progress()).toEqual({
    stages: [expect.objectContaining({ stage: "qa", outcome: "stopped" })],
    upcoming: [],
  });
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
  const entered = await ledger.enter("plan", () => undefined);
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
