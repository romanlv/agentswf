import { afterAll, describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "../packages/contract/src/workflow";
import { PLAIN, progressEvents, renderProgress } from "../packages/engine/src/progress-view";
import { createTempRunDirs, future, submit } from "../packages/engine/src/testing";
import { startWorkflow, type WorkflowRunSnapshot } from "../packages/engine/src/workflow-runner";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const SOL = { harness: "codex", model: "gpt-6-sol" };

function agent(key: string, stage: number, turn?: NonNullable<Agent["turn"]>): Agent {
  return {
    key,
    execution: SOL,
    state: turn?.outcome === undefined ? "working" : "idle",
    observedAt: 0,
    stage,
    turns: turn ? 1 : 0,
    ...(turn ? { turn } : {}),
  };
}
type Agent = WorkflowRunSnapshot["agents"][number];

const MID_RUN: WorkflowRunSnapshot = {
  state: "running",
  stages: [
    { label: "Lenses", total: 2, started: 2, done: 2, startedAt: 0, endedAt: 150_000 },
    { label: "Verify", total: 4, started: 2, done: 1, startedAt: 150_000 },
  ],
  agents: [
    agent("lens:authz", 0, { startedAt: 0, settledAt: 120_000, outcome: "answered" }),
    agent("lens:infra", 0, {
      startedAt: 0,
      settledAt: 149_000,
      outcome: "timed-out",
      reason: "operation deadline exceeded",
    }),
    agent("verifier:0", 1, { startedAt: 150_000, settledAt: 190_000, outcome: "answered" }),
    agent("verifier:1", 1, { startedAt: 150_000 }),
  ],
};

describe("run progress", () => {
  test("the terminal block names each stage, and under it what runs or went wrong", () => {
    expect(
      renderProgress(MID_RUN, { name: "review", startedAt: 0, now: 200_000, paint: PLAIN }),
    ).toEqual([
      "review · 3m 20s · 1 working",
      "✗ Lenses 2/2 · 2m 30s · 1 failed",
      "    ✗ lens:infra  gpt-6-sol  2m 29s  timed-out: operation deadline exceeded",
      "⠋ Verify 1/4 · 2 queued",
      "    ✓ verifier:0  gpt-6-sol     40s",
      "    ⠋ verifier:1  gpt-6-sol     50s",
    ]);
  });

  test("without a terminal, each change is one line", () => {
    const view = { startedAt: 0, now: 200_000 };
    const first = progressEvents(undefined, MID_RUN, view);
    expect(first).toEqual([
      "[3:20] ▶ Lenses (2)",
      "[3:20] ▶ Verify (4)",
      "[3:20] ✓ lens:authz · 2m 00s",
      "[3:20] ✗ lens:infra · 2m 29s · timed-out: operation deadline exceeded",
      "[3:20] ✓ verifier:0 · 40s",
      "[3:20] ▶ verifier:1 · gpt-6-sol",
      "[3:20] ■ Lenses done 2/2 in 2m 30s, 1 failed",
    ]);
    expect(progressEvents(MID_RUN, MID_RUN, view)).toEqual([]);
  });

  test("a run's snapshot tracks labelled parallel stages and each agent's turn", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          if (context.activation.key === "b") throw new Error("b broke");
          await submit(context.binding!, "done");
        },
      }),
    });
    const definition: WorkflowDefinition<null, string[]> = {
      meta: { name: "fixture", description: "fixture" },
      async run(workflow) {
        return workflow.parallel(
          ["a", "b"],
          async (key) => {
            const opened = await workflow.agents.open({ key, runtime: "fake" });
            const { outcome } = await opened.run({ prompt: "go" });
            return outcome.kind;
          },
          { label: "Pair", concurrency: 1 },
        );
      },
    };

    const handle = await startWorkflow(definition, null, {
      runRoot: runDirs.tempRunDir(),
      runtime: {
        aliases: { fake: { harness: "fake", model: "m" } },
        host: createSingleSessionHostFactory(adapter),
      },
      deadline: future(),
      cwd: "/repo",
    });
    const result = await handle.result;
    const snapshot = handle.inspect();

    expect(result.value).toEqual(["answered", "failed"]);
    expect(snapshot.stages).toMatchObject([{ label: "Pair", total: 2, started: 2, done: 2 }]);
    expect(snapshot.stages[0]?.endedAt).toBeNumber();
    expect(snapshot.agents.map((a) => [a.key, a.stage, a.turns, a.turn?.outcome]).sort()).toEqual([
      ["a", 0, 1, "answered"],
      ["b", 0, 1, "failed"],
    ]);
  });
});
