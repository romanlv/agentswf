import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import Type from "typebox";
import { paneLayout } from "./workflow";

const NAMED = Type.Object({ name: Type.String() }, { additionalProperties: false });

describe("pane-layout", () => {
  test("a lead's tab in front, two reviewers stacked right of it", async () => {
    const run = await testWorkflow(paneLayout, {
      agents: {
        lead: [answer(NAMED, { name: "Ada" })],
        security: [answer(NAMED, { name: "Sec" })],
        style: [answer(NAMED, { name: "Sty" })],
      },
    });
    expect(run.value.answered).toEqual(["Ada", "Sec", "Sty"]);
    expect(run.agentOf("lead").pane).toEqual({ tab: "review", front: true });
    expect(run.agentOf("security").pane).toEqual({ beside: "lead", side: "right" });
    expect(run.agentOf("style").pane).toEqual({ beside: "security", side: "below" });
    expect(run.agents.some((agent) => agent.keptPane)).toBe(false);
  });
});
