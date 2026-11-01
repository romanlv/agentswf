import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import reviewLoop, { DONE, VERDICT } from "./index";

const args = { task: "Add a --dry-run flag" };
const done = answer(DONE, { summary: "Added --dry-run" });

describe("the landing page's review loop", () => {
  test("revises until the reviewer approves, handing the implementer the changes asked for", async () => {
    let reviews = 0;
    const run = await testWorkflow(reviewLoop, args, {
      agents: {
        implementer: done,
        reviewer: answer(VERDICT, () =>
          ++reviews === 1
            ? { approved: false, changes: ["Print what would change", "Test the flag"] }
            : { approved: true, changes: [] },
        ),
      },
    });
    expect(run.value).toEqual({ approved: true, rounds: 2 });
    expect(run.turnsOf("implementer").map((turn) => turn.prompt)).toEqual([
      "Implement this task: Add a --dry-run flag",
      "Make these changes:\nPrint what would change\nTest the flag",
    ]);
    // No placement: a pane, the default.
    const implementer = run.agentOf("implementer").execution;
    expect(implementer.harness).toBe("claude");
    expect(implementer).not.toHaveProperty("placement");
    expect(run.agentOf("reviewer").execution).toMatchObject({
      harness: "codex",
      placement: "headless",
    });
  });

  test("gives up after three rounds without approval", async () => {
    const run = await testWorkflow(reviewLoop, args, {
      agents: {
        implementer: done,
        reviewer: answer(VERDICT, { approved: false, changes: ["Not yet"] }),
      },
    });
    expect(run.value).toEqual({ approved: false, rounds: 3 });
  });

  test("an implementer that fails stops the run, naming it", async () => {
    const run = await testWorkflow(reviewLoop, args, {
      agents: { implementer: reply.failed("harness crashed") },
    });
    expect(run.stopped?.reason).toBe("implementer: harness crashed");
  });
});
