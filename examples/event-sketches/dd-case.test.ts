import { expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import caseRun, { type Case, DAY, needsTurn } from "./dd-case";

// The case's files are declared in the sketch; task 9 of story 034 gives them a body, and these run.
declare function caseWith(state: {
  notes?: boolean;
  unseen?: number;
  newSignal?: boolean;
  gapBefore?: number;
  closed?: boolean;
  closeAsked?: boolean;
  replies?: number;
}): Case;
declare function fixture(name: string): { [name: string]: string };
declare const DD_CASES: string;

test.todo("occurrences of a known signal wait for the threshold", () => {
  expect(needsTurn(caseWith({ notes: true, unseen: 30 }))).toBe(false);
  expect(needsTurn(caseWith({ notes: true, unseen: 50 }))).toBe(true);
  expect(needsTurn(caseWith({ notes: true, unseen: 1, newSignal: true }))).toBe(true);
  expect(needsTurn(caseWith({ notes: true, unseen: 1, gapBefore: 8 * DAY }))).toBe(true);
});

test.todo("a closed case is written up once, then answers replies and ignores occurrences", () => {
  expect(needsTurn(caseWith({ notes: true, closed: true }))).toBe(true);
  expect(needsTurn(caseWith({ notes: true, closed: true, closeAsked: true, unseen: 80 }))).toBe(
    false,
  );
  expect(needsTurn(caseWith({ notes: true, closed: true, replies: 1 }))).toBe(true);
});

test.todo("a reply during a turn gets the next turn", async () => {
  const run = await testWorkflow(caseRun, {
    id: "kombo-unique",
    event: { name: "dd.changes", data: { case: "kombo-unique" } },
    files: { [DD_CASES]: fixture("open-case") },
    agents: { investigator: answer("case.md updated") },
    events: [
      {
        during: "investigator#1",
        name: "participant:reply",
        from: "thread",
        data: { text: "is it the unique index?" },
      },
    ],
  });
  expect(run.turnsOf("investigator")[1]?.prompt).toContain("is it the unique index?");
});

// What tsc refuses: an event the case run doesn't declare, and data its schema doesn't take.
async function refused(): Promise<void> {
  // @ts-expect-error The case run declares no dd.opened.
  await testWorkflow(caseRun, { id: "x", event: { name: "dd.opened", data: { case: "x" } } });
  // @ts-expect-error A close needs its status, why and by.
  await testWorkflow(caseRun, { id: "x", event: { name: "dd.closed", data: { case: "x" } } });
  // @ts-expect-error A reply comes from a participant: `from` is required.
  await testWorkflow(caseRun, {
    id: "x",
    event: { name: "dd.changes", data: { case: "x" } },
    events: [{ during: "investigator#1", name: "participant:reply", data: { text: "hi" } }],
  });
  // @ts-expect-error awf writes agent:ended; a test doesn't script one.
  await testWorkflow(caseRun, {
    id: "x",
    event: { name: "dd.changes", data: { case: "x" } },
    events: [{ during: "investigator#1", name: "agent:ended", from: "investigator", data: {} }],
  });
  // @ts-expect-error A reply's data is its text.
  await testWorkflow(caseRun, {
    id: "x",
    event: { name: "dd.changes", data: { case: "x" } },
    events: [{ during: "investigator#1", name: "participant:reply", from: "thread", data: {} }],
  });
}
void refused;
