import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import Type from "typebox";
import { callingSession } from "./workflow";

const PICKED = Type.Object(
  { number: Type.Integer({ minimum: 1000, maximum: 9999 }) },
  { additionalProperties: false },
);
const DOUBLED = Type.Object({ answer: Type.Integer() }, { additionalProperties: false });
const RECALLED = Type.Object(
  { number: Type.Integer(), agrees: Type.Boolean() },
  { additionalProperties: false },
);

describe("calling-session", () => {
  test("the calling session picks, a helper doubles, the session recalls and checks it", async () => {
    const run = await testWorkflow(
      callingSession,
      { helper: true },
      {
        caller: { harness: "pi" },
        agents: {
          author: [
            answer(PICKED, { number: 4827 }),
            answer(RECALLED, { number: 4827, agrees: true }),
          ],
          helper: answer(DOUBLED, { answer: 9654 }),
        },
      },
    );
    expect(run.value).toEqual({
      harness: "pi",
      picked: 4827,
      doubled: 9654,
      recalled: 4827,
      agrees: true,
    });
    expect(run.turnsOf("author")[1]?.prompt).toContain("doubles to 9654");
  });

  test("without a calling session it says how to start one", async () => {
    const run = await testWorkflow(callingSession, { helper: false });
    expect(() => run.value).toThrow("start this workflow with awf run --here");
  });

  test("an interrupted step ends the run, and says so", async () => {
    const run = await testWorkflow(
      callingSession,
      { helper: false },
      { caller: { harness: "codex" }, agents: { author: reply.interrupted() } },
    );
    expect(() => run.value).toThrow("no number: cancelled");
  });
});
