import { describe, expect, test } from "bun:test";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import Type from "typebox";
import { fork } from "./workflow";

const NOTED = Type.Object({ noted: Type.Boolean() }, { additionalProperties: false });
const RECALLED = Type.Object(
  { codename: Type.String(), release: Type.String() },
  { additionalProperties: false },
);
const noted = answer(NOTED, { noted: true });
const args = { codename: "V-1234", release: "G-5678" };

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
            answer(RECALLED, { codename: "V-1234", release: "G-5678" }),
          ],
          "fork:claude-headless:compact": [
            answer(RECALLED, { codename: "V-1234", release: "unknown" }),
          ],
        },
      },
    );
    expect(run.value).toEqual([
      {
        name: "claude-headless:compact",
        fork: { codename: "V-1234", release: "unknown" },
        worker: { codename: "V-1234", release: "G-5678" },
      },
    ]);
    expect(run.compactionsOf("worker:claude-headless:compact")).toHaveLength(1);
    expect(run.agentOf("fork:claude-headless:compact").forkedFrom).toEqual({
      key: "worker:claude-headless:compact",
      turns: 1,
    });
  });

  test("a pane worker forks headless, and a headless one into a pane", async () => {
    const run = await testWorkflow(
      fork,
      {
        ...args,
        cases: [
          { runtime: "claude", compact: false, into: "headless" },
          { runtime: "codex-headless", compact: false, into: "pane" },
        ],
      },
      {
        agents: {
          "worker:*": [noted, noted, answer(RECALLED, { codename: "V-1234", release: "G-5678" })],
          "fork:*": [answer(RECALLED, { codename: "V-1234", release: "unknown" })],
        },
      },
    );
    expect(run.value.map((check) => check.problem)).toEqual([undefined, undefined]);
    expect(run.agentOf("fork:claude>headless").execution).toMatchObject({
      placement: "headless",
      metered: true,
    });
    expect(run.agentOf("fork:codex-headless>pane").execution).not.toHaveProperty("placement");
  });
});
