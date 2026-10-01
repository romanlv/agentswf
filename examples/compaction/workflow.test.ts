import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import Type from "typebox";
import { compaction } from "./workflow";

const NOTED = Type.Object({ noted: Type.Boolean() }, { additionalProperties: false });
const RECALLED = Type.Object(
  { codename: Type.String(), colour: Type.String() },
  { additionalProperties: false },
);
const args = { colour: "teal", codename: "HERON-1234" };
const recalled = answer(RECALLED, { codename: "HERON-1234", colour: "teal" });

describe("compaction", () => {
  test("each agent notes, compacts with the codename as its focus, then recalls", async () => {
    const run = await testWorkflow(
      compaction,
      { ...args, runtimes: ["claude", "pi"] },
      {
        agents: {
          "compact:claude": [answer(NOTED, { noted: true }), recalled],
          "compact:pi": [
            answer(NOTED, { noted: true }),
            answer(NOTED, { noted: true }),
            answer(NOTED, { noted: true }),
            recalled,
          ],
        },
        compactions: { "compact:claude": answer("codename HERON-1234; the shed is teal") },
      },
    );
    expect(run.value).toMatchObject({ codename: "HERON-1234", colour: "teal" });
    expect(run.value.checks).toEqual([
      {
        runtime: "claude",
        compacted: "answered",
        summary: "codename HERON-1234; the shed is teal",
        recalled: { codename: "HERON-1234", colour: "teal" },
      },
      {
        runtime: "pi",
        compacted: "answered",
        summary: "",
        recalled: { codename: "HERON-1234", colour: "teal" },
      },
    ]);
    const [focus] = run.compactionsOf("compact:claude");
    expect(focus?.focus).toContain("HERON-1234");
    // pi is given history older than its last 20k tokens, the others are not.
    expect(run.turnsOf("compact:pi")[2]?.prompt).toContain("inventory line 2000:");
    expect(run.turnsOf("compact:claude")).toHaveLength(2);
  });

  test("cursor's compaction fails, is reported, and the agent is still asked", async () => {
    const run = await testWorkflow(
      compaction,
      { ...args, runtimes: ["cursor"] },
      {
        agents: { "compact:cursor": [answer(NOTED, { noted: true }), recalled] },
      },
    );
    expect(run.value.checks).toEqual([
      {
        runtime: "cursor",
        compacted: "failed",
        reason: "cursor has no compaction of its own",
        recalled: { codename: "HERON-1234", colour: "teal" },
      },
    ]);
  });
});
