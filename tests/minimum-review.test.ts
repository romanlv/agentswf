import { afterAll, describe, expect, test } from "bun:test";
import {
  type AcceptedReview,
  createMinimumReview,
  type MinimumReviewArgs,
  type ReviewLens,
} from "../examples/minimum-review/workflow";
import type { ResultSubmitResponse } from "../packages/contract/src/wire";
import type {
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  JsonObject,
  JsonValue,
} from "../packages/contract/src/workflow";
import { runWorkflow } from "../packages/engine/src";
import { createTempRunDirs, future, submit } from "../packages/engine/src/testing";
import type {
  AgentRuntimeConfig,
  AgentSessionAdapter,
  HarnessNudgeSpec,
  HarnessOperationBinding,
  HarnessSession,
} from "../packages/harness/src/adapter";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

const minimumReview = createMinimumReview({
  correctness: "correctness",
  maintainability: "maintainability",
});

describe("minimum two-agent review", () => {
  test("runs both lenses concurrently and composes accepted results in input order", async () => {
    let started = 0;
    let bothInFlight = false;
    const acceptanceOrder: ReviewLens[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseCorrectness!: () => void;
    const maintainabilityAccepted = new Promise<void>((resolve) => {
      releaseCorrectness = resolve;
    });
    const adapter = createFakeAdapter({
      script: (context) => ({
        nativeUsage: [{ inputTokens: 2, outputTokens: 1 }],
        act: async () => {
          started += 1;
          if (started === 2) {
            bothInFlight = adapter.turns.length === 2;
            release();
          }
          await bothStarted;
          const lens = lensOf(context);
          if (lens === "maintainability") {
            await submit(context.binding!, accepted(lens, lens));
            acceptanceOrder.push(lens);
            releaseCorrectness();
            return;
          }
          await maintainabilityAccepted;
          await Bun.sleep(10);
          await submit(context.binding!, accepted(lens, lens));
          acceptanceOrder.push(lens);
        },
      }),
    });

    const result = await runWorkflow(minimumReview, args(), {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: future(),
      cwd: "/repo",
    });

    expect(bothInFlight).toBe(true);
    expect(acceptanceOrder).toEqual(["maintainability", "correctness"]);
    expect(result.value.reviews).toEqual([
      { kind: "completed", ...accepted("correctness", "correctness") },
      { kind: "completed", ...accepted("maintainability", "maintainability") },
    ]);
    expect(result.value.blockingFindingCount).toBe(1);
    expect(result.value.usage).toEqual(result.usage);
    // Composition order is the workflow's promise; usage is charged in whichever order the two
    // concurrent turns reserve their slots, so only the per-agent totals are asserted.
    expect(
      result.value.usage
        .map(({ agent, tokens }) => ({ agent, tokens }))
        .sort((left, right) => left.agent.localeCompare(right.agent)),
    ).toEqual([
      { agent: "reviewer:correctness", tokens: { input: 2, output: 1 } },
      { agent: "reviewer:maintainability", tokens: { input: 2, output: 1 } },
    ]);
    expect(new Set(result.value.usage.map(({ operationId }) => operationId)).size).toBe(2);
    expect(adapter.activations.map((activation) => activation.key).sort()).toEqual([
      "reviewer:correctness",
      "reviewer:maintainability",
    ]);
    expect(
      adapter.activations.every((activation) =>
        activation.instructions?.includes("Do not delegate, launch subagents"),
      ),
    ).toBe(true);
    expect(adapter.closed.sort()).toEqual(["reviewer:correctness", "reviewer:maintainability"]);
  });

  test("a silent lens is explicit and contributes no successful data", async () => {
    const adapter = createFakeAdapter({
      script: (context) =>
        lensOf(context) === "maintainability"
          ? {
              act: async () => {
                await submit(context.binding!, accepted("maintainability", "maintainability"));
              },
            }
          : {},
    });

    const result = await runWorkflow(minimumReview, args(), {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: future(),
      cwd: "/repo",
    });

    expect(result.value.reviews[0]).toMatchObject({
      kind: "incomplete",
      lens: "correctness",
      outcome: "unanswered",
    });
    expect(result.value.reviews[1]).toMatchObject({
      kind: "completed",
      lens: "maintainability",
    });
    expect(result.value.blockingFindingCount).toBe(0);
    expect(
      adapter.turns.filter((turn) => lensOf(turn) === "correctness").map((turn) => turn.kind),
    ).toEqual(["turn", "nudge"]);
  });

  test("the initial turn has its own bound while nudge retains the workflow deadline", async () => {
    const firstTurnMs = 60_000;
    const workflowDeadline = future(10 * 60_000);
    const initialDeadlines: number[] = [];
    const nudgeDeadlines: number[] = [];
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            initialDeadlines.push(turn.deadline.unixMilliseconds);
            const native = await dispatch(session, turn, binding);
            return {
              ...native,
              nudge: async (spec: HarnessNudgeSpec) => {
                nudgeDeadlines.push(spec.deadline.unixMilliseconds);
                return native.nudge(spec);
              },
            };
          }) as HarnessSession["start"],
        };
      },
    };
    const startedAt = Date.now();

    await runWorkflow(
      createMinimumReview(
        { correctness: "correctness", maintainability: "maintainability" },
        firstTurnMs,
      ),
      args(),
      {
        runRoot: tempRunDir(),
        runtime: runtime(adapter),
        deadline: workflowDeadline,
        cwd: "/repo",
      },
    );

    expect(initialDeadlines).toHaveLength(2);
    expect(initialDeadlines.every((deadline) => deadline >= startedAt + firstTurnMs)).toBe(true);
    expect(initialDeadlines.every((deadline) => deadline <= Date.now() + firstTurnMs)).toBe(true);
    expect(nudgeDeadlines).toEqual([
      workflowDeadline.unixMilliseconds,
      workflowDeadline.unixMilliseconds,
    ]);

    const cappedWorkflowDeadline = future(10 * 60_000);
    await runWorkflow(
      createMinimumReview(
        { correctness: "correctness", maintainability: "maintainability" },
        20 * 60_000,
      ),
      args(),
      {
        runRoot: tempRunDir(),
        runtime: runtime(adapter),
        deadline: cappedWorkflowDeadline,
        cwd: "/repo",
      },
    );
    expect(initialDeadlines.slice(2)).toEqual([
      cappedWorkflowDeadline.unixMilliseconds,
      cappedWorkflowDeadline.unixMilliseconds,
    ]);
  });

  test("a result attributed to the other lens is rejected and remains incomplete", async () => {
    const rejected: ResultSubmitResponse[] = [];
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const lens = lensOf(context);
          if (lens === "correctness") {
            rejected.push(await submit(context.binding!, accepted("maintainability", lens)));
          } else {
            await submit(context.binding!, accepted(lens, lens));
          }
        },
      }),
    });

    const result = await runWorkflow(minimumReview, args(), {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: future(),
      cwd: "/repo",
    });

    expect(rejected).toHaveLength(2);
    expect(
      rejected.every(
        (response) => response.kind === "rejected" && response.code === "invalid-result",
      ),
    ).toBe(true);
    expect(result.value.reviews[0]).toMatchObject({
      kind: "incomplete",
      lens: "correctness",
      outcome: "unanswered",
    });
    expect(result.value.blockingFindingCount).toBe(0);
  });

  test("each incomplete lens keeps its own outcome and reason", async () => {
    for (const pair of [
      ["timed-out", "blocked"],
      ["failed", "cancelled"],
    ] as const) {
      const [first, second] = pair;
      const adapter = createFakeAdapter({
        script: (context) =>
          lensOf(context) === "correctness"
            ? { state: first, detail: `correctness went ${first}` }
            : { state: second, detail: `maintainability went ${second}` },
      });

      const result = await runWorkflow(minimumReview, args(), {
        runRoot: tempRunDir(),
        runtime: runtime(adapter),
        deadline: future(),
        cwd: "/repo",
      });

      expect(result.value.reviews).toEqual([
        {
          kind: "incomplete",
          lens: "correctness",
          outcome: first,
          reason: `correctness went ${first}`,
        },
        {
          kind: "incomplete",
          lens: "maintainability",
          outcome: second,
          reason: `maintainability went ${second}`,
        },
      ]);
      expect(result.value.blockingFindingCount).toBe(0);
    }
  });
});

function args(): MinimumReviewArgs {
  return { target: "examples/minimum-review/fixtures/review-target.ts" };
}

function runtime(adapter: AgentSessionAdapter): AgentRuntimeConfig {
  return {
    aliases: {
      correctness: {
        harness: "fake",
        model: "correctness-fake",
      },
      maintainability: {
        harness: "fake",
        model: "maintainability-fake",
      },
    },
    host: createSingleSessionHostFactory(adapter),
  };
}

function dispatch(
  session: HarnessSession,
  turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
  binding: HarnessOperationBinding,
) {
  return turn.schema
    ? session.start(turn as AgentStructuredTurnSpec<JsonValue>, binding)
    : session.start(turn as AgentTextTurnSpec, binding);
}

function lensOf(context: { activation: { labels?: JsonObject } }): ReviewLens {
  const lens = context.activation.labels?.lens;
  if (lens !== "correctness" && lens !== "maintainability") throw new Error("missing lens label");
  return lens;
}

function accepted(lens: ReviewLens, subject: ReviewLens): Omit<AcceptedReview, "kind"> {
  return {
    lens,
    summary: `${subject} review complete`,
    findings:
      subject === "correctness"
        ? [
            {
              severity: "blocking",
              summary: "Empty input renders NaN as a percentage",
              evidence: "runs.length is the divisor without an empty-input branch",
            },
          ]
        : [
            {
              severity: "non-blocking",
              summary: "Formatting and aggregation are coupled",
              evidence: "renderRunSummary computes groups and builds presentation text",
            },
          ],
  };
}
