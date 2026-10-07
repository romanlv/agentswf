import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import Type from "typebox";
import { forkCaller } from "./workflow";

const RECALLED = Type.Object({ working_on: Type.String() }, { additionalProperties: false });

describe("fork-caller", () => {
  test("forks the session waiting on the run, on its model, and asks it what it knows", async () => {
    const run = await testWorkflow(forkCaller, null, {
      caller: { harness: "claude", model: "claude-opus-5-5", here: false },
      agents: { fork: answer(RECALLED, { working_on: "story 027" }) },
    });
    expect(run.value).toEqual({ model: "claude-opus-5-5", workingOn: "story 027" });
    expect(run.agentOf("fork").forkedFrom).toEqual({ caller: true, turns: 0 });
  });

  test("refuses where the run was not started from an agent's shell", async () => {
    const run = await testWorkflow(forkCaller, null);
    expect(() => run.value).toThrow("no session to fork");
  });
});
