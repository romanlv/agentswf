import { expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import investigate, { FINDINGS } from "./people";

test("the investigator reports, asks, and its next turn has the coordinator's answer", async () => {
  // #region script
  const run = await testWorkflow(investigate, null, {
    agents: {
      investigator: answer(FINDINGS, async (turn) => {
        await turn.send("coordinator", "Pool exhaustion after deploy 8f3c.");
        const asked = await turn.send(
          "coordinator",
          "Merge with yesterday's incident, or keep two?",
          {
            awaitReply: true,
          },
        );
        const answered = asked.kind === "replied" ? asked.text : asked.kind;
        return { cause: "pool exhaustion", incidents: [answered] };
      }),
    },
    participants: {
      coordinator: (event) =>
        event.kind === "message" && event.asks
          ? event.reply("Keep two, and link them.")
          : undefined,
    },
  });
  // #endregion script
  expect(run.value).toEqual({
    cause: "pool exhaustion",
    incidents: ["Keep two, and link them."],
  });
  expect(run.messagesOf("coordinator")).toEqual([
    { from: "investigator", awaitReply: false, end: "delivered" },
    { from: "investigator", awaitReply: true, end: "replied" },
  ]);
});
