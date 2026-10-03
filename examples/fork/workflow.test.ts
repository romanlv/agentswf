import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import Type from "typebox";
import { fork } from "./workflow";

const NOTED = Type.Object({ noted: Type.Boolean() }, { additionalProperties: false });
const RECALLED = Type.Object(
  { vault: Type.String(), gate: Type.String() },
  { additionalProperties: false },
);
const noted = answer(NOTED, { noted: true });
const args = { vault: "V-1234", gate: "G-5678" };

describe("fork", () => {
  test("the fork knows what its worker knew when it forked, and the worker what it learned after", async () => {
    const run = await testWorkflow(
      fork,
      { ...args, cases: [{ runtime: "claude-headless", compact: true }] },
      {
        agents: {
          "worker:claude-headless:compact": [
            noted,
            noted,
            answer(RECALLED, { vault: "V-1234", gate: "G-5678" }),
          ],
          "fork:claude-headless:compact": [answer(RECALLED, { vault: "V-1234", gate: "unknown" })],
        },
      },
    );
    expect(run.value).toEqual([
      {
        name: "claude-headless:compact",
        fork: { vault: "V-1234", gate: "unknown" },
        worker: { vault: "V-1234", gate: "G-5678" },
      },
    ]);
    expect(run.compactionsOf("worker:claude-headless:compact")).toHaveLength(1);
    expect(run.agentOf("fork:claude-headless:compact").forkedFrom).toEqual({
      key: "worker:claude-headless:compact",
      turns: 1,
    });
  });

  test("a fork its host refuses fails the run, as an agent that will not open does", async () => {
    const run = await testWorkflow(
      fork,
      { ...args, cases: [{ runtime: "claude-headless", compact: false, into: "pane" }] },
      { agents: { "worker:claude-headless>pane": [noted] } },
    );
    expect(() => run.value).toThrow("pane agents cannot continue a forked session yet");
  });
});
