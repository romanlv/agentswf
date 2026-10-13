import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import { BUILT, CASES, messaging, REVIEW } from "./workflow";

const built = answer(BUILT, { file: "slug.mjs" });
const right = CASES.map(({ title, slug }) => ({ title, slug }));

describe("messaging", () => {
  test("the reviewer asks for the fix by message, and the reply wakes its next turn", async () => {
    const run = await testWorkflow(
      messaging,
      { runtime: "codex" },
      {
        agents: {
          implementer: built,
          reviewer: answer(REVIEW, async (turn) => {
            const fixed = await turn.send("implementer", "Use underscores.", { awaitReply: true });
            return fixed.kind === "replied"
              ? { approved: true, outputs: right }
              : { approved: false, outputs: [] };
          }),
        },
        messages: { implementer: (message) => message.reply("Fixed.") },
      },
    );
    expect(run.value.approved).toBe(true);
    expect(run.value.revisions).toBe(1);
    expect(run.value.checks.every(({ expected, got }) => expected === got)).toBe(true);
    expect(run.messagesOf("implementer")).toEqual([
      { from: "reviewer", awaitReply: true, end: "replied" },
    ]);
  });

  test("a slug the reviewer did not get right is shown wrong", async () => {
    const run = await testWorkflow(
      messaging,
      { runtime: "codex" },
      {
        agents: {
          implementer: built,
          reviewer: answer(REVIEW, {
            approved: false,
            outputs: [{ title: "Hello, World!", slug: "hello-world" }],
          }),
        },
      },
    );
    expect(run.value).toMatchObject({ approved: false, revisions: 0 });
    expect(run.value.checks[0]).toEqual({
      title: "Hello, World!",
      expected: "hello_world",
      got: "hello-world",
    });
    expect(run.value.checks[1]!.got).toBeUndefined();
  });

  test("the implementer cannot message the reviewer", async () => {
    const run = await testWorkflow(
      messaging,
      { runtime: "codex" },
      {
        agents: {
          implementer: answer(BUILT, async (turn) => {
            const sent = await turn.send("reviewer", "done?");
            return { file: sent.kind === "refused" ? sent.code : sent.kind };
          }),
          reviewer: answer(REVIEW, { approved: true, outputs: right }),
        },
      },
    );
    expect(run.turnsOf("reviewer")[0]!.prompt).toStartWith("Review no-route.");
  });
});
