// #region first
import { expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import releaseNotes, { CHECK, NOTES } from "./release-notes";

const args = { range: "v1.2.0...HEAD" };

test("notes with no breaking change take one agent and one turn", async () => {
  const run = await testWorkflow(releaseNotes, args, {
    agents: { writer: answer(NOTES, { notes: "Faster startup.", breaking: false }) },
  });
  expect(run.value).toEqual({ notes: "Faster startup.", breaking: false, checked: false });
  expect(run.agents.map((agent) => agent.key)).toEqual(["writer"]);
  expect(run.turnsOf("writer")[0]!.prompt).toContain("v1.2.0...HEAD");
});
// #endregion first

// #region checker
test("a claimed breaking change goes to a checker on codex, which can overrule it", async () => {
  const run = await testWorkflow(releaseNotes, args, {
    agents: {
      writer: answer(NOTES, { notes: "Removed --legacy.", breaking: true }),
      checker: answer(CHECK, (turn) => ({
        breaking: !turn.prompt.includes("--legacy"),
        why: "--legacy was deprecated two releases ago",
      })),
    },
  });
  expect(run.value).toEqual({ notes: "Removed --legacy.", breaking: false, checked: true });
  expect(run.agentOf("checker").execution.alias).toBe("codex");
});
// #endregion checker

// #region outcomes
test("a writer that never answers is nudged once, then the run stops with why", async () => {
  const run = await testWorkflow(releaseNotes, args, { agents: { writer: reply.silent() } });
  expect(run.turnsOf("writer").map((turn) => turn.nudge)).toEqual([false, true]);
  expect(run.stopped?.reason).toStartWith("no notes: ");
  expect(() => run.value).toThrow();
});

test("a checker whose harness fails leaves the writer's word, marked unchecked", async () => {
  const run = await testWorkflow(releaseNotes, args, {
    agents: {
      writer: answer(NOTES, { notes: "Removed --legacy.", breaking: true }),
      checker: reply.failed("harness crashed"),
    },
  });
  expect(run.value).toMatchObject({ breaking: true, checked: false });
  expect(run.turnsOf("checker")[0]!.outcome).toBe("failed");
});
// #endregion outcomes

// #region prepare
test("the range is the first argument, origin/main...HEAD without one", () => {
  expect(releaseNotes.prepare({ argv: [], cwd: "/repo" })).toEqual({ range: "origin/main...HEAD" });
  expect(releaseNotes.prepare({ argv: ["v1.2.0...HEAD"], cwd: "/repo" })).toEqual(args);
});
// #endregion prepare
