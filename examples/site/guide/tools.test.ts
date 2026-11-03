import { expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import deadCode from "./tools";

test("each finding the agent records reaches the workflow, and it can read them back", async () => {
  const run = await testWorkflow(deadCode, {
    agents: {
      reviewer: answer(async (turn) => {
        expect(
          await turn.tool("add_finding", {
            file: "src/a.ts",
            line: 12,
            problem: "unused export",
          }),
        ).toEqual({ kind: "result", output: "Recorded; 1 so far." });
        expect(await turn.tool("list_findings")).toEqual({
          kind: "result",
          output: "src/a.ts:12  unused export",
        });
        return "One finding.";
      }),
    },
  });
  expect(run.value).toEqual({
    findings: [{ file: "src/a.ts", line: 12, problem: "unused export" }],
    ended: "answered",
  });
});

test("input that doesn't fit is refused before the handler runs; a throw fails only the call", async () => {
  const seen: unknown[] = [];
  const run = await testWorkflow(deadCode, {
    agents: {
      reviewer: answer(async (turn) => {
        seen.push(
          await turn.tool("add_finding", {
            file: "src/a.ts",
            line: 0,
            problem: "x",
          }),
        );
        await turn.tool("add_finding", {
          file: "src/a.ts",
          line: 3,
          problem: "unused",
        });
        seen.push(
          await turn.tool("add_finding", {
            file: "src/a.ts",
            line: 3,
            problem: "again",
          }),
        );
        return "Done.";
      }),
    },
  });
  expect(seen).toEqual([
    {
      kind: "refused",
      code: "invalid-input",
      error: expect.stringContaining("line"),
    },
    {
      kind: "failed",
      outcome: "failed",
      error: "src/a.ts:3 is already recorded",
    },
  ]);
  expect(run.value.findings).toHaveLength(1);
  expect(run.value.ended).toBe("answered");
});
