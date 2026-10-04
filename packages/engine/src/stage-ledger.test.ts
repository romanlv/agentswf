import { afterAll, expect, test } from "bun:test";
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
  expect(ledger.entered).toEqual(["qa"]);
});

test("a misuse leaves no stage entered or open", async () => {
  const ledger = new StageLedger({ runDir: runDirs.tempRunDir(), attempt: 1, turns: () => [] });
  await expect(run(ledger, "Bad")).rejects.toThrow("is not a stage's name");
  const qa = await run(ledger, "qa");
  await expect(run(ledger, "mr")).rejects.toThrow("while stage qa is open");
  await qa.succeed(undefined);
  await expect(run(ledger, "qa")).rejects.toThrow("entered twice");
  await (await run(ledger, "mr")).succeed(undefined);
  expect(ledger.entered).toEqual(["qa", "mr"]);
});
