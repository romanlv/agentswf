import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import Type from "typebox";
import { paneLayout } from "./workflow";

const NAMED = Type.Object({ name: Type.String() }, { additionalProperties: false });

describe("pane-layout", () => {
  test("a lead's tab where awf run was typed, two reviewers stacked right of it, the lead kept", async () => {
    const run = await testWorkflow(
      paneLayout,
      { workspace: "origin" },
      {
        agents: {
          lead: [answer(NAMED, { name: "Ada" })],
          security: [answer(NAMED, { name: "Sec" })],
          style: [answer(NAMED, { name: "Sty" })],
        },
      },
    );
    expect(run.value.answered).toEqual(["Ada", "Sec", "Sty"]);
    expect(run.agentOf("lead")).toMatchObject({
      layout: { workspace: "origin", tab: "review" },
      keepPane: "always",
      keptPane: true,
    });
    expect(run.agentOf("security").layout).toEqual({ beside: "lead", side: "right" });
    expect(run.agentOf("style").layout).toEqual({ beside: "security", side: "below" });
    expect(run.agentOf("style")).not.toHaveProperty("keptPane");
  });
});
