import { describe, expect, test } from "bun:test";
import {
  defineExecutableWorkflow,
  EXECUTABLE_WORKFLOW_KIND,
  isAnswered,
  type TurnOutcome,
  type TurnUsage,
  type WorkflowDefinition,
} from "./index";

const usage: TurnUsage = {
  callPath: [],
  agent: "reviewer",
  operationId: "review",
  execution: { harness: "fake", model: "fake" },
};

describe("author helpers", () => {
  test("defineExecutableWorkflow owns the protocol discriminator", () => {
    const definition: WorkflowDefinition<null, null> = {
      meta: { name: "test", description: "test workflow" },
      async run() {
        return null;
      },
    };

    const executable = defineExecutableWorkflow({
      definition,
      prepare: () => null,
    });

    expect(executable.kind).toBe(EXECUTABLE_WORKFLOW_KIND);
    expect(executable.definition).toBe(definition);
  });

  test("isAnswered narrows only accepted answers", () => {
    const answered: TurnOutcome<string> = { kind: "answered", value: "done", usage };
    const failed: TurnOutcome<string> = {
      kind: "failed",
      reason: "no result",
      retryable: false,
      usage,
    };

    expect(isAnswered(answered)).toBe(true);
    expect(isAnswered(failed)).toBe(false);
  });
});
