import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import Type from "typebox";
import { effort } from "./workflow";

const ANSWER = Type.Object(
  { word: Type.String(), shell: Type.String() },
  { additionalProperties: false },
);

describe("effort", () => {
  test("each agent runs its first turn at its effort, then at the one set, then on the model set", async () => {
    const run = await testWorkflow(
      effort,
      { runtimes: ["codex", "pi-headless"], word: "pelican" },
      {
        agents: {
          "effort:*": [
            answer(ANSWER, { word: "pelican", shell: "" }),
            answer(ANSWER, { word: "ok", shell: "" }),
            answer(ANSWER, { word: "pelican", shell: "" }),
          ],
        },
      },
    );
    const settings = (key: string) =>
      run.turnsOf(key).map(({ model, effort: level }) => `${model}@${level}`);

    expect(settings("effort:codex")).toEqual([
      "gpt-6-luna@low",
      "gpt-6-luna@high",
      "gpt-5.6-luna@high",
    ]);
    expect(settings("effort:pi-headless")).toEqual([
      "openai-codex/gpt-5.6-terra@low",
      "openai-codex/gpt-5.6-terra@high",
      "openai-codex/gpt-5.6-luna@high",
    ]);
    const codex = run.value.checks.find((check) => check.runtime === "codex")!;
    expect(codex.problem).toBeUndefined();
    expect(
      codex.steps.map((step) => `${step.kind} ${step.execution.model}@${step.execution.effort}`),
    ).toEqual([
      "turn gpt-6-luna@low",
      "set gpt-6-luna@high",
      "turn gpt-6-luna@high",
      "set gpt-5.6-luna@high",
      "turn gpt-5.6-luna@high",
    ]);
  });
});
