import { afterAll, expect, test } from "bun:test";
import type { TurnRecord } from "@agentswf/contract/records";
import { readStageRecords } from "./runs";
import { StageLedger } from "./stage-ledger";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

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
  await ledger.enter("doc-review").succeed(undefined);
  await ledger.enter("implement").succeed(undefined);
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
  const qa = ledger.enter("qa");
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
  ledger.enter("qa");
  ledger.seal("Deadline exceeded");
  expect(() => ledger.enter("mr")).toThrow(
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
  expect(() => ledger.enter("Bad")).toThrow("a stage's name is lowercase");
  const qa = ledger.enter("qa");
  expect(() => ledger.enter("mr")).toThrow("while stage qa is open");
  await qa.succeed(undefined);
  expect(() => ledger.enter("qa")).toThrow("entered twice");
  await ledger.enter("mr").succeed(undefined);
  expect(ledger.entered).toEqual(["qa", "mr"]);
});
