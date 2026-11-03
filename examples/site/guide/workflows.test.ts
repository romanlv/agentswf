import { expect, test } from "bun:test";
import { answer, noAnswer, testWorkflow } from "agentswf/testing";
import checkDocs, { CHECK } from "./workflows";

const args = { files: ["README.md", "docs/setup.md"] };

test("prepare turns the words after -- into args, and refuses none", () => {
  expect(
    checkDocs.prepare({ argv: ["README.md", "docs/setup.md"], cwd: "/repo" }),
  ).toEqual(args);
  expect(() => checkDocs.prepare({ argv: [], cwd: "/repo" })).toThrow(
    "name the files to check",
  );
});

test("one agent checks each file in turn; present and report render the result", async () => {
  const run = await testWorkflow(checkDocs, args, {
    agents: {
      checker: answer(CHECK, (turn) => ({
        problems: turn.prompt.includes("README.md")
          ? ["`awf go` is not a command"]
          : [],
      })),
    },
  });
  expect(run.value).toEqual({
    checked: [
      { file: "README.md", problems: ["`awf go` is not a command"] },
      { file: "docs/setup.md", problems: [] },
    ],
  });
  expect(run.turnsOf("checker")).toHaveLength(2);
  const ending = { kind: "completed" as const, value: run.value, stages: [] };
  expect(checkDocs.present?.(run.value, ending)).toBe(
    "README.md: 1\ndocs/setup.md: ok",
  );
  expect(checkDocs.report?.(run.value, ending)).toContain(
    "- `awf go` is not a command",
  );
});

test("a file with no answer stops the run with the reason, and the report hands it off", async () => {
  const run = await testWorkflow(checkDocs, args, {
    agents: { checker: noAnswer.failed("codex exited") },
  });
  expect(run.ending).toMatchObject({
    kind: "stopped",
    reason: "README.md: failed: codex exited",
  });
  expect(run.turnsOf("checker")).toHaveLength(1);
  const report = checkDocs.report?.(undefined, run.ending);
  expect(report).toStartWith(
    "# Check stopped\n\nREADME.md: failed: codex exited",
  );
});
