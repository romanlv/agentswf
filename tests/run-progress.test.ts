import { afterAll, describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "../packages/contract/src/workflow";
import { PLAIN, progressEvents, renderProgress } from "../packages/engine/src/progress-view";
import { createRun, writeStageRecord } from "../packages/engine/src/runs";
import { createTempRunDirs, future, startNew, submit } from "../packages/engine/src/testing";
import { startWorkflow, type WorkflowRunSnapshot } from "../packages/engine/src/workflow-runner";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const SOL = { harness: "codex", model: "gpt-6-sol" };

type Turn = Omit<NonNullable<Agent["turn"]>, "kind">;

function agent(key: string, group: number, turn?: Turn): Agent {
  return {
    key,
    execution: SOL,
    state: turn?.outcome === undefined ? "working" : "idle",
    observedAt: 0,
    group,
    turns: turn ? 1 : 0,
    ...(turn ? { turn: { kind: "turn", ...turn } } : {}),
  };
}
type Agent = WorkflowRunSnapshot["agents"][number];

const MID_RUN: WorkflowRunSnapshot = {
  state: "running",
  stages: [],
  upcoming: [],
  groups: [
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

const OPUS = { harness: "claude", model: "claude-opus-5-5" };

/** Attempt 2 of a run, in qa: two stages reused, review done, mr recorded and still to come. */
const CONTINUED: WorkflowRunSnapshot = {
  state: "running",
  groups: [],
  upcoming: ["mr"],
  stages: [
    {
      stage: "doc-review",
      source: "reused",
      attempt: 1,
      startedAt: 0,
      endedAt: 0,
      outcome: "succeeded",
      summary: "docs/AIRS-1515.md",
      // Old enough that its age is shown, as the next one's is not.
      recordedAt: -2 * 24 * 60 * 60_000,
    },
    {
      stage: "implement",
      source: "reused",
      attempt: 1,
      startedAt: 0,
      endedAt: 0,
      outcome: "succeeded",
      recordedAt: -10 * 60_000,
    },
    {
      stage: "review",
      source: "ran",
      attempt: 2,
      startedAt: 0,
      endedAt: 240_000,
      outcome: "succeeded",
      summary: "2 findings",
    },
    { stage: "qa", source: "ran", attempt: 2, startedAt: 240_000 },
  ],
  agents: [
    {
      key: "worker",
      execution: OPUS,
      state: "working",
      observedAt: 0,
      turns: 3,
      turn: { kind: "turn", startedAt: 250_000, stage: "qa", label: "preview" },
    },
    {
      key: "tester",
      execution: { ...OPUS, placement: "headless" },
      state: "idle",
      observedAt: 0,
      turns: 1,
      turn: {
        kind: "turn",
        startedAt: 241_000,
        settledAt: 245_000,
        outcome: "answered",
        stage: "qa",
      },
    },
    {
      key: "reviewer",
      execution: OPUS,
      state: "idle",
      observedAt: 0,
      turns: 1,
      turn: { kind: "turn", startedAt: 1, settledAt: 2, outcome: "answered", stage: "review" },
    },
  ],
};

describe("run progress by stage", () => {
  test("a continued run mid-stage: reused, done, current with its agents, and still to come", () => {
    expect(
      renderProgress(CONTINUED, {
        name: "implement-ticket AIRS-1515 · attempt 2",
        startedAt: 0,
        now: 300_000,
        paint: PLAIN,
      }),
    ).toEqual([
      "implement-ticket AIRS-1515 · attempt 2 · qa · 5m 00s · 1 working",
      "↺ doc-review   docs/AIRS-1515.md   attempt 1 · 2d ago",
      "↺ implement                        attempt 1",
      "✓ review       4m 00s              2 findings",
      expect.stringMatching(/^. qa {11}1m 00s$/),
      expect.stringMatching(/^ {4}. worker {2}claude-opus-5-5 · pane {2}preview {2}50s$/),
      "    · tester  claude-opus-5-5 · headless  4s  waiting",
      "· mr",
    ]);
  });

  test("once the run is over, each stage that ran agents shows what they cost, as does what ran between stages, and a clean group folds into its stage", () => {
    const over: WorkflowRunSnapshot = {
      ...CONTINUED,
      state: "closed",
      groups: [
        { label: "Checks", total: 1, started: 1, done: 1, startedAt: 240_000, endedAt: 245_000 },
      ],
      stages: [
        ...CONTINUED.stages.slice(0, 3),
        {
          stage: "qa",
          source: "ran",
          attempt: 2,
          startedAt: 240_000,
          endedAt: 300_000,
          outcome: "failed",
        },
      ],
      agents: [{ ...CONTINUED.agents[1]!, group: 0 }],
    };
    expect(
      renderProgress(over, {
        name: "flow",
        startedAt: 0,
        now: 300_000,
        paint: PLAIN,
        figures: new Map([
          ["review", "1 agent · 90k tokens · ~$0.30"],
          ["(no stage)", "1 agent · 2k tokens · ~$0.01"],
        ]),
      }).slice(1),
    ).toEqual([
      "↺ doc-review   docs/AIRS-1515.md                        attempt 1 · 2d ago",
      "↺ implement                                             attempt 1",
      "✓ review       4m 00s · 1 agent · 90k tokens · ~$0.30   2 findings",
      "✗ qa           1m 00s",
      // What ran between stages, so the stages add up to the run.
      "· (no stage)   1 agent · 2k tokens · ~$0.01",
    ]);
  });

  test("the same run, without a terminal, as one line per change", () => {
    const started = { ...CONTINUED, stages: CONTINUED.stages.slice(0, 3), agents: [] };
    expect(progressEvents(undefined, started, { startedAt: 0, now: 0 })).toEqual([
      "[0:00] ↺ stage doc-review · docs/AIRS-1515.md · attempt 1",
      "[0:00] ↺ stage implement · attempt 1",
      "[0:00] ▶ stage review",
      "[0:00] ✓ stage review · 4m 00s · 2 findings",
    ]);
    expect(progressEvents(started, CONTINUED, { startedAt: 0, now: 300_000 })).toEqual([
      "[5:00] ✓ reviewer · 0s",
      "[5:00] ▶ stage qa",
      "[5:00] ✓ tester · 4s",
      "[5:00] ▶ worker · claude-opus-5-5",
    ]);
    const stopped = {
      ...CONTINUED,
      stages: [
        ...CONTINUED.stages.slice(0, 3),
        {
          stage: "qa",
          source: "ran" as const,
          attempt: 2,
          startedAt: 240_000,
          endedAt: 360_000,
          outcome: "stopped" as const,
        },
      ],
    };
    expect(progressEvents(CONTINUED, stopped, { startedAt: 0, now: 360_000 })).toEqual([
      "[6:00] ■ stage qa · 2m 00s",
    ]);
  });

  test("a labelled parallel in the current stage counts its failures, though its agents are listed under the stage", () => {
    const inQa = (key: string, turn: Turn) => agent(key, 0, { ...turn, stage: "qa" });
    const snapshot: WorkflowRunSnapshot = {
      ...CONTINUED,
      groups: [
        { label: "Checks", total: 2, started: 2, done: 2, startedAt: 240_000, endedAt: 260_000 },
      ],
      agents: [
        inQa("check:a", { startedAt: 240_000, settledAt: 250_000, outcome: "answered" }),
        inQa("check:b", {
          startedAt: 240_000,
          settledAt: 255_000,
          outcome: "failed",
          reason: "boom",
        }),
      ],
    };
    const lines = renderProgress(snapshot, {
      name: "flow",
      startedAt: 0,
      now: 300_000,
      paint: PLAIN,
    });
    expect(lines).toContain("✗ Checks 2/2 · 20s · 1 failed");
    expect(lines.filter((line) => line.includes("check:b"))).toHaveLength(1);
  });

  test("in one poll, a stage's end follows its turns, and the next stage starts after it", () => {
    const before = { ...CONTINUED, agents: [] };
    const after: WorkflowRunSnapshot = {
      ...CONTINUED,
      upcoming: [],
      stages: [
        ...CONTINUED.stages.slice(0, 3),
        {
          stage: "qa",
          source: "ran",
          attempt: 2,
          startedAt: 240_000,
          endedAt: 290_000,
          outcome: "succeeded",
        },
        { stage: "mr", source: "ran", attempt: 2, startedAt: 290_000 },
      ],
      agents: [CONTINUED.agents[1]!],
    };
    expect(progressEvents(before, after, { startedAt: 0, now: 300_000 })).toEqual([
      "[5:00] ✓ tester · 4s",
      "[5:00] ✓ stage qa · 50s",
      "[5:00] ▶ stage mr",
    ]);
  });

  test("a continue's snapshot: a stage reused with its attempt, one failed, none left to come", async () => {
    const runRoot = runDirs.tempRunDir();
    const { dir } = await createRun(runRoot, {
      id: "r1",
      workflow: "staged",
      argv: [],
      cwd: runRoot,
      sandbox: null,
    });
    await writeStageRecord(dir, {
      version: 1,
      stage: "implement",
      attempt: 1,
      outcome: "succeeded",
      started: "2026-10-02T16:00:00Z",
      ended: "2026-10-02T16:10:00Z",
      sessions: [],
      summary: "feat/a",
    });
    await writeStageRecord(dir, {
      version: 1,
      stage: "qa",
      attempt: 1,
      outcome: "failed",
      started: "2026-10-02T16:11:00Z",
      ended: "2026-10-02T16:12:00Z",
      sessions: [],
    });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "staged", description: "stages" },
      async run(context) {
        await context.stage("implement", async () => {
          throw new Error("implement's work was called");
        });
        await context.stage("qa", async () => {
          throw new Error("qa broke");
        });
        return null;
      },
    };
    const handle = await startWorkflow(workflow, null, {
      runRoot,
      run: { dir, id: "r1", attempt: 2 },
      runtime: {
        aliases: {},
        host: createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) })),
      },
      deadline: future(),
    });
    await handle.result.catch(() => undefined);
    const { stages, upcoming } = handle.inspect();
    expect(stages).toMatchObject([
      { stage: "implement", source: "reused", attempt: 1, summary: "feat/a" },
      { stage: "qa", source: "ran", attempt: 2, outcome: "failed" },
    ]);
    expect(upcoming).toEqual([]);
  });

  test("a stage the run's stop ends is shown ended, as its record is", async () => {
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "staged", description: "stages" },
      async run(context) {
        await context.stage("qa", async () => {
          entered();
          // Nothing cancelling the run rejects.
          await new Promise(() => {});
        });
        return null;
      },
    };
    const handle = await startNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      runtime: {
        aliases: {},
        host: createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) })),
      },
      deadline: future(),
    });
    await inside;
    await handle.stop("SIGINT");
    expect(handle.inspect().stages).toMatchObject([{ stage: "qa", outcome: "failed" }]);
  });

  test("a live run's snapshot names its stages and each turn's stage and label", async () => {
    const adapter = createFakeAdapter({
      harnesses: ["codex"],
      script: (context) => ({
        act: async () => {
          await submit(context.binding!, "done");
        },
      }),
    });
    let seen: WorkflowRunSnapshot | undefined;
    let handle: Awaited<ReturnType<typeof startWorkflow>> | undefined;
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "staged", description: "stages" },
      async run(context) {
        const worker = await context.agents.open({ key: "worker", runtime: "codex" });
        await context.stage("implement", async () => {
          await worker.run({ prompt: "Do it.", label: "build" });
          seen = handle?.inspect();
        });
        return null;
      },
    };
    handle = await startNew(workflow, null, {
      runRoot: runDirs.tempRunDir(),
      runtime: {
        aliases: { codex: SOL },
        host: createSingleSessionHostFactory(adapter),
      },
      deadline: future(),
    });
    await handle.result;
    expect(seen?.stages).toMatchObject([{ stage: "implement", source: "ran" }]);
    expect(seen?.agents[0]?.turn).toMatchObject({ stage: "implement", label: "build" });
    expect(handle.inspect().stages[0]).toMatchObject({ outcome: "succeeded" });
  });
});

describe("run progress", () => {
  test("the terminal block names each labelled parallel, and under it what runs or went wrong", () => {
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
      "[3:20] ✓ lens:authz · 2m 00s",
      "[3:20] ✗ lens:infra · 2m 29s · timed-out: operation deadline exceeded",
      "[3:20] ✗ Lenses done 2/2 in 2m 30s, 1 failed",
      "[3:20] ▶ Verify (4)",
      "[3:20] ▶ verifier:1 · gpt-6-sol",
      "[3:20] ✓ verifier:0 · 40s",
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

    const handle = await startNew(definition, null, {
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
    expect(snapshot.groups).toMatchObject([{ label: "Pair", total: 2, started: 2, done: 2 }]);
    expect(snapshot.groups[0]?.endedAt).toBeNumber();
    expect(snapshot.agents.map((a) => [a.key, a.group, a.turns, a.turn?.outcome]).sort()).toEqual([
      ["a", 0, 1, "answered"],
      ["b", 0, 1, "failed"],
    ]);
  });
});
