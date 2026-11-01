import { expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import askTheArchitect, { CHANGE } from "./messaging";

const change = { summary: "Retries in the queue.", files: ["src/queue.ts"] };

test("a question starts the architect's first turn, and its reply continues the implementer", async () => {
  // #region script
  const run = await testWorkflow(askTheArchitect, null, {
    agents: {
      implementer: answer(CHANGE, async (turn) => {
        const answered = await turn.send("architect", "Client or queue?", { awaitReply: true });
        return answered.kind === "replied" ? change : { summary: answered.kind, files: [] };
      }),
    },
    messages: { architect: (message) => message.reply("The queue: the client is shared.") },
  });
  // #endregion script
  expect(run.value).toEqual({ ...change, questions: 1 });
  expect(run.messagesOf("architect")).toEqual([
    { from: "implementer", awaitReply: true, end: "replied" },
  ]);
  expect(run.turnsOf("architect").map((turn) => turn.cause)).toEqual([
    { message: { from: "implementer" } },
  ]);
  // The reply is a turn of its own for the implementer, sharing its turn's number.
  expect(run.turnsOf("implementer").map((turn) => turn.n)).toEqual([1, 1]);
});

test("an architect nobody asks never runs", async () => {
  const run = await testWorkflow(askTheArchitect, null, {
    agents: { implementer: answer(CHANGE, change) },
  });
  expect(run.value).toEqual({ ...change, questions: 0 });
  expect(run.turnsOf("architect")).toEqual([]);
});

test("the route is one way: the architect answers, but can't start a conversation", async () => {
  const run = await testWorkflow(askTheArchitect, null, {
    agents: {
      implementer: answer(CHANGE, async (turn) => {
        const answered = await turn.send("architect", "Client or queue?", { awaitReply: true });
        return { summary: answered.kind === "replied" ? answered.text : answered.kind, files: [] };
      }),
    },
    messages: {
      architect: async (message) => {
        const sent = await message.send("implementer", "Also, rename the file.");
        return message.reply(sent.kind === "refused" ? sent.code : sent.kind);
      },
    },
  });
  expect(run.value.summary).toBe("no-route");
});
