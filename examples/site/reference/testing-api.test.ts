import { expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import { BRANCH, caseRun, DOC, flow, investigate, QA } from "./testing-api";

test("a coordinator's script answers the investigator's question", async () => {
  const run = await testWorkflow(investigate, {
    agents: {
      investigator: answer(async (turn) => {
        const asked = await turn.send("coordinator", "One incident or two?", { awaitReply: true });
        return asked.kind === "replied" ? asked.text : asked.kind;
      }),
    },
    participants: {
      coordinator: (event) =>
        event.kind === "message" && event.asks
          ? event.reply("Keep two, and link them.")
          : undefined,
    },
  });
  expect(run.value).toBe("Keep two, and link them.");
});

test("a reply during the first turn gets a second, then the run parks", async () => {
  const run = await testWorkflow(caseRun, {
    id: "checkout-timeouts", // the run, as a sender names it
    event: { name: "case.changed", data: { case: "checkout-timeouts" } }, // starts it
    files: { cases: { "checkout-timeouts": { "case.md": "# checkout\n" } } }, // laid out first
    agents: { investigator: answer("case.md updated") },
    events: [
      { during: "investigator#1", name: "thread:reply", data: { text: "is it the index?" } },
    ],
  });
  expect(run.ending).toMatchObject({
    kind: "parked",
    label: "waiting on the thread about checkout-timeouts",
  });
  expect(run.turnsOf("investigator")[1]?.prompt).toContain("is it the index?");
  expect(run.emits).toEqual([]);
});

test("a continue reuses the recorded stages and doesn't repeat implement's compaction", async () => {
  const run = await testWorkflow(flow, {
    earlier: { stages: { "doc-review": { path: "docs/a.md" }, implement: { branch: "feat/a" } } },
    agents: { worker: answer(QA, { preview: "ok" }) },
  });
  expect(run.compactions).toEqual([]); // a compaction inside implement isn't repeated
  expect(run.value).toBe("ok");
});

test("a first attempt compacts inside implement", async () => {
  const run = await testWorkflow(flow, {
    agents: {
      worker: [
        answer(DOC, { path: "docs/a.md" }),
        answer(BRANCH, { branch: "feat/a" }),
        answer(QA, { preview: "ok" }),
      ],
    },
  });
  expect(run.compactionsOf("worker")).toHaveLength(1);
});
