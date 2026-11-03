import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import testMyChange, { CHANGED, TESTED } from "./calling-session";
import describeChange from "./calling-session-fork";

describe("test-my-change", () => {
  test("the calling session says what changed and fixes what the tester found failing", async () => {
    const run = await testWorkflow(testMyChange, null, {
      caller: { harness: "claude" },
      agents: {
        author: [
          answer(CHANGED, {
            files: ["src/cache.ts"],
            summary: "The cache expires entries.",
          }),
          answer("Fixed: expiry used seconds, not milliseconds."),
        ],
        tester: answer(TESTED, { failing: ["expires after ttl"] }),
      },
    });
    expect(run.value).toEqual({
      files: ["src/cache.ts"],
      failing: ["expires after ttl"],
    });
    expect(run.turnsOf("tester")[0]?.prompt).toContain("src/cache.ts");
    expect(run.turnsOf("author")[1]?.prompt).toContain("expires after ttl");
  });

  test("started without --here, there is no calling session, and it says how to start", async () => {
    const run = await testWorkflow(testMyChange, null);
    expect(run.stopped?.reason).toContain("awf run --here");
  });
});

describe("describe-change", () => {
  test("a fork of the session waiting on the run writes the description", async () => {
    const run = await testWorkflow(describeChange, null, {
      caller: { harness: "claude", model: "claude-opus-5-5", here: false },
      agents: { writer: answer("Expire cache entries after their ttl.") },
    });
    expect(run.value).toBe("Expire cache entries after their ttl.");
    expect(run.agentOf("writer").forkedFrom).toEqual({
      caller: true,
      turns: 0,
    });
  });

  test("with no session to fork, forkCaller answers null", async () => {
    const run = await testWorkflow(describeChange, null);
    expect(run.stopped?.reason).toContain("no session to fork");
  });
});
