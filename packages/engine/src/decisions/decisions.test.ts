import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SettledDecision, SettledOperation } from "@agentswf/contract/records";
import {
  choice,
  DeadlineExceededError,
  DecisionError,
  type JsonValue,
  score,
  type WorkflowContext,
  type WorkflowDefinition,
  yesNo,
} from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentRuntimeConfig } from "@agentswf/harness/adapter";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { describeAccounting } from "../accounting/format";
import { PUBLISHED_PRICES } from "../accounting/prices";
import { summarizeRun } from "../accounting/summary";
import { createTempRunDirs, future } from "../testing";
import { runWorkflow, startWorkflow, WorkflowRunError } from "../workflow-runner";
import { digestOf, RunDecisions } from "./directory";
import { confidentResponse, createFakeDecisionProvider } from "./fake";
import { type DecisionInstallation, DecisionProviderError, type ProviderAnswer } from "./seam";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const TRIAGE = {
  team: choice("Which team owns `ticket`?", { payments: "Checkout, billing", frontend: null }),
  bug: yesNo("Does `ticket` report broken behaviour?"),
  urgency: score("How urgent is `ticket`?", ["later", "this week", "now"]),
};

describe("decisions.decide", () => {
  test("answers every question with its distribution, and records and prices the call", async () => {
    const provider = createFakeDecisionProvider([
      {
        snapshot: "typesafe/jev-1.13-20260917",
        answers: {
          team: { type: "choice", probabilities: { payments: 0.2, frontend: 0.8 } },
          bug: { type: "yes-no", yes: 0.97 },
          urgency: { type: "score", probabilities: [0.1, 0.2, 0.7] },
        },
        tokens: { input: 10_000, output: 8 },
        charged: { amount: 0.00042, currency: "USD" },
        requestId: "gen-1",
      },
    ]);
    const runRoot = runDirs.tempRunDir();
    const result = await run(provider, runRoot, async (context) => {
      const { answers, record } = await context.decisions.decide({
        key: "triage:1",
        model: "jev",
        state: { ticket: "Checkout double-charges on retry" },
        questions: TRIAGE,
      });
      expect(record.outcome).toBe("answered");
      return {
        team: answers.team.choice,
        payments: answers.team.probabilities.payments,
        bug: answers.bug.yes,
        level: answers.urgency.level,
        expected: answers.urgency.expected,
      };
    });

    expect(result.value).toEqual({
      team: "frontend",
      payments: 0.2,
      bug: 0.97,
      level: 2,
      expected: expect.closeTo(1.6, 10),
    });
    expect(provider.requests[0]).toEqual({
      key: "triage:1",
      model: "typesafe/jev-1.13",
      state: { ticket: "Checkout double-charges on retry" },
      questions: TRIAGE,
    });
    const [record] = result.decisions!;
    expect(record).toMatchObject({
      callPath: [],
      key: "triage:1",
      alias: "jev",
      provider: "openrouter",
      model: "typesafe/jev-1.13",
      snapshot: "typesafe/jev-1.13-20260917",
      questions: [
        { id: "team", type: "choice" },
        { id: "bug", type: "yes-no" },
        { id: "urgency", type: "score" },
      ],
      questionsDigest: digestOf(TRIAGE),
      outcome: "answered",
      attempts: 1,
      tokens: { input: 10_000, output: 8 },
      charged: { amount: 0.00042, currency: "USD" },
      requestId: "gen-1",
      artifact: "decisions/1.json",
    });
    expect(record!.error).toBeUndefined();

    const artifact = JSON.parse(
      await readFile(join(runRoot, result.runId, record!.artifact), "utf8"),
    );
    expect(artifact).toEqual({
      record,
      request: {
        state: { ticket: "Checkout double-charges on retry" },
        questions: JSON.parse(JSON.stringify(TRIAGE)),
      },
      answers: expect.objectContaining({
        urgency: {
          type: "score",
          level: 2,
          expected: expect.closeTo(1.6, 10),
          probabilities: [0.1, 0.2, 0.7],
        },
      }),
    });

    const { totals, byStage, byModel, unpriced } = result.accounting;
    expect(totals.agents).toBe(0);
    expect(totals.estimate).toBeUndefined();
    expect(totals.decisions).toEqual({
      calls: 1,
      attempts: 1,
      tokens: { input: 10_000, output: 8 },
      estimate: expect.closeTo(0.00042, 12),
      charged: 0.00042,
      known: 1,
      priced: 1,
    });
    expect(byStage.map(({ stage, decisions }) => [stage, decisions?.calls])).toEqual([
      ["triage", 1],
    ]);
    expect(byModel).toEqual([
      expect.objectContaining({ model: "typesafe/jev-1.13-20260917", agents: 0, decisionCalls: 1 }),
    ]);
    expect(unpriced).toEqual([]);
  });

  test("the same questions give the same digest, and a changed word or option order a new one", () => {
    const again = { urgency: TRIAGE.urgency, bug: TRIAGE.bug, team: TRIAGE.team };
    expect(digestOf(again)).toBe(digestOf(TRIAGE));
    expect(digestOf({ ...TRIAGE, bug: yesNo("Does `ticket` report broken behavior?") })).not.toBe(
      digestOf(TRIAGE),
    );
    const reordered = choice("Which team owns `ticket`?", {
      frontend: null,
      payments: "Checkout, billing",
    });
    expect(digestOf({ ...TRIAGE, team: reordered })).not.toBe(digestOf(TRIAGE));
  });

  const answered = confidentResponse({
    key: "k",
    model: "m",
    state: "",
    questions: TRIAGE,
  }).answers;
  test.each([
    [
      "a question left unanswered",
      { team: answered.team!, bug: answered.bug! },
      "question urgency: not answered",
    ],
    [
      "a choice missing an option's probability",
      { ...answered, team: { type: "choice", probabilities: { payments: 1 } } },
      "question team: no probability for option frontend",
    ],
    [
      "a score missing a level",
      { ...answered, urgency: { type: "score", probabilities: [0.5, 0.5] } },
      "question urgency: expected a probability for each of 3 levels",
    ],
    [
      "an answer of another type",
      { ...answered, bug: { type: "score", probabilities: [1] } },
      "question bug: answered as score",
    ],
    [
      "a yes-no without its probability",
      { ...answered, bug: { type: "yes-no", yes: Number.NaN } },
      "question bug: no probability of yes",
    ],
    [
      "an option nobody asked about",
      {
        ...answered,
        team: { type: "choice", probabilities: { payments: 0.5, frontend: 0.4, account: 0.1 } },
      },
      "question team: unknown option account",
    ],
    [
      "a choice with no probability anywhere",
      { ...answered, team: { type: "choice", probabilities: { payments: 0, frontend: 0 } } },
      "question team: probabilities sum to 0, not 1",
    ],
    [
      "a score that sums to 2",
      { ...answered, urgency: { type: "score", probabilities: [1, 1, 0] } },
      "question urgency: probabilities sum to 2, not 1",
    ],
  ] satisfies [string, Record<string, ProviderAnswer>, string][])(
    "%s rejects, and is recorded as failed with what it spent",
    async (_name, answers, message) => {
      const provider = createFakeDecisionProvider([
        { ...confidentResponse({ key: "k", model: "m", state: "", questions: TRIAGE }), answers },
      ]);
      const failure = await run(provider, runDirs.tempRunDir(), async (context) => {
        await context.decisions.decide({
          key: "triage:1",
          model: "jev",
          state: "s",
          questions: TRIAGE,
        });
        return null;
      }).then(unexpected, failed);

      expect(failure.cause).toBeInstanceOf(DecisionError);
      expect((failure.cause as Error).message).toContain(message);
      expect(failure.decisions).toEqual([
        expect.objectContaining({
          outcome: "failed",
          error: message,
          attempts: 1,
          tokens: { input: 1_000, output: 10 },
        }),
      ]);
      expect(failure.accounting.totals.decisions?.calls).toBe(1);
    },
  );

  test("retries a retryable error within the deadline, and counts both requests", async () => {
    const provider = createFakeDecisionProvider([
      new DecisionProviderError("429 rate limited", {
        retryable: true,
        tokens: { input: 0, output: 0 },
      }),
    ]);
    const result = await run(provider, runDirs.tempRunDir(), async (context) => {
      const { record } = await context.decisions.decide({
        key: "retry",
        model: "jev",
        state: "s",
        questions: { bug: TRIAGE.bug },
      });
      return record.attempts;
    });
    expect(result.value).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(result.decisions?.[0]).toMatchObject({ outcome: "answered", attempts: 2 });
    expect(result.accounting.totals.decisions).toMatchObject({ calls: 1, attempts: 2 });
  });

  test("does not retry a refusal", async () => {
    const provider = createFakeDecisionProvider([
      new DecisionProviderError("400 Too many choices", { retryable: false }),
    ]);
    const failure = await run(provider, runDirs.tempRunDir(), async (context) => {
      await context.decisions.decide({
        key: "refused",
        model: "jev",
        state: "s",
        questions: TRIAGE,
      });
      return null;
    }).then(unexpected, failed);
    expect(provider.requests).toHaveLength(1);
    expect(failure.decisions?.[0]).toMatchObject({
      outcome: "failed",
      error: "400 Too many choices",
      attempts: 1,
    });
    expect(failure.decisions?.[0]?.tokens).toBeUndefined();
  });

  test("a deadline that passes mid-call rejects, and the call is recorded as timed out", async () => {
    const provider = createFakeDecisionProvider([() => new Promise<never>(() => undefined)]);
    const result = await run(provider, runDirs.tempRunDir(), async (context) => {
      const failure = await context.decisions
        .decide({ key: "slow", model: "jev", state: "s", questions: TRIAGE, deadline: future(100) })
        .catch((error: unknown) => error);
      return failure instanceof DeadlineExceededError;
    });
    expect(result.value).toBe(true);
    expect(result.decisions?.[0]).toMatchObject({
      outcome: "timed-out",
      error: "deadline exceeded after 1 attempt",
      attempts: 1,
    });
    expect(result.decisions?.[0]?.snapshot).toBeUndefined();
  });

  test("stopping the run cancels a call in flight, and it is recorded", async () => {
    let asked!: () => void;
    const started = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const provider = createFakeDecisionProvider([
      (_request, signal) =>
        new Promise<never>((_resolve, reject) => {
          asked();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    ]);
    const handle = await startWorkflow(
      workflowOf(async (context) => {
        await context.decisions.decide({
          key: "held",
          model: "jev",
          state: "s",
          questions: TRIAGE,
        });
        return null;
      }),
      null,
      options(provider, runDirs.tempRunDir()),
    );
    await started;
    await handle.stop("operator");
    const failure = await handle.result.then(unexpected, failed);
    expect(failure.decisions?.[0]).toMatchObject({
      outcome: "cancelled",
      error: "cancelled: workflow closed",
    });
  });

  test("a call nobody awaited is cancelled when the workflow ends, and still recorded", async () => {
    const provider = createFakeDecisionProvider([() => new Promise<never>(() => undefined)]);
    const result = await run(provider, runDirs.tempRunDir(), async (context) => {
      context.decisions
        .decide({ key: "forgotten", model: "jev", state: "s", questions: TRIAGE })
        .catch(() => undefined);
      return null;
    });
    expect(result.decisions?.[0]?.outcome).toBe("cancelled");
  });

  test("a parallel scope's deadline cancels the calls it owns", async () => {
    const provider = createFakeDecisionProvider([], () => new Promise<never>(() => undefined));
    const failure = await run(provider, runDirs.tempRunDir(), async (context) => {
      await context.parallel(
        [1, 2],
        (item) =>
          context.decisions.decide({
            key: `batch:${item}`,
            model: "jev",
            state: "s",
            questions: TRIAGE,
          }),
        { deadline: future(100) },
      );
      return null;
    }).then(unexpected, failed);
    expect(failure.cause).toBeInstanceOf(DeadlineExceededError);
    expect(failure.decisions?.map((record) => record.outcome).sort()).toEqual([
      expect.stringMatching(/^(timed-out|cancelled)$/),
      expect.stringMatching(/^(timed-out|cancelled)$/),
    ]);
  });

  test("a failed run keeps the decisions it asked", async () => {
    const failure = await run(
      createFakeDecisionProvider(),
      runDirs.tempRunDir(),
      async (context) => {
        await context.decisions.decide({
          key: "first",
          model: "jev",
          state: "s",
          questions: TRIAGE,
        });
        throw new Error("the workflow broke afterwards");
      },
    ).then(unexpected, failed);
    expect(failure.message).toBe("the workflow broke afterwards");
    expect(failure.decisions).toEqual([
      expect.objectContaining({ key: "first", outcome: "answered" }),
    ]);
    expect(failure.accounting.totals.decisions?.calls).toBe(1);
  });

  test("an unknown alias, or none installed, rejects before any request and is not recorded", async () => {
    const provider = createFakeDecisionProvider();
    const result = await run(provider, runDirs.tempRunDir(), async (context) => {
      const unknown = await context.decisions
        .decide({ key: "k", model: "claude", state: "s", questions: TRIAGE })
        .catch((error: Error) => error.message);
      const empty = await context.decisions
        .decide({ key: "k", model: "jev", state: "s", questions: {} })
        .catch((error: Error) => error.message);
      return [unknown, empty];
    });
    expect(result.value).toEqual([
      'no decision model alias "claude"; installed: jev',
      "decision k asks no questions",
    ]);
    expect(provider.requests).toEqual([]);
    expect(result.decisions).toBeUndefined();

    const none = await runWorkflow(
      workflowOf((context) =>
        context.decisions.decide({ key: "k", model: "jev", state: "s", questions: TRIAGE }).then(
          () => "answered",
          (error: Error) => error.message,
        ),
      ),
      null,
      { runRoot: runDirs.tempRunDir(), runtime: emptyRuntime(), deadline: future() },
    );
    expect(none.value).toBe('no decision model alias "jev"; none is installed');
  });
});

describe("RunDecisions", () => {
  const installation = (provider: ReturnType<typeof createFakeDecisionProvider>) => ({
    providers: { fake: provider },
    aliases: { jev: { provider: "fake", model: "fake/jev-1" } },
  });
  const busy = () => new DecisionProviderError("503 busy", { retryable: true });

  test("stops after three requests, however many retries the deadline allows", async () => {
    const provider = createFakeDecisionProvider([busy(), busy(), busy(), busy()]);
    const slept: number[] = [];
    const decisions = new RunDecisions({
      installation: installation(provider),
      runDir: runDirs.tempRunDir(),
      sleep: async (milliseconds) => {
        slept.push(milliseconds);
      },
    });
    const failure = await decisions
      .decide({ key: "k", model: "jev", state: "s", questions: TRIAGE }, { deadline: future() })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DecisionError);
    expect(slept).toEqual([500, 1_000]);
    expect(decisions.records()).toEqual([
      expect.objectContaining({ outcome: "failed", error: "503 busy", attempts: 3 }),
    ]);
  });

  test("does not retry when the backoff would end past the deadline", async () => {
    const provider = createFakeDecisionProvider([busy()]);
    const decisions = new RunDecisions({
      installation: installation(provider),
      runDir: runDirs.tempRunDir(),
    });
    const failure = await decisions
      .decide({ key: "k", model: "jev", state: "s", questions: TRIAGE }, { deadline: future(300) })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DecisionError);
    expect(decisions.records()[0]).toMatchObject({ outcome: "failed", attempts: 1 });
  });

  test("an answer whose artifact cannot be written fails; a timeout stays a timeout", async () => {
    const root = runDirs.tempRunDir();
    const blocked = join(root, "not-a-directory");
    await Bun.write(blocked, "");
    const decisions = new RunDecisions({
      installation: installation(
        createFakeDecisionProvider([() => new Promise<never>(() => undefined)]),
      ),
      runDir: blocked,
    });
    const answered = new RunDecisions({
      installation: installation(createFakeDecisionProvider()),
      runDir: blocked,
    });
    const lost = await answered
      .decide({ key: "k", model: "jev", state: "s", questions: TRIAGE }, { deadline: future() })
      .catch((error: unknown) => error);
    expect(lost).toBeInstanceOf(DecisionError);
    expect(answered.records()[0]).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("artifact not written"),
      snapshot: "fake/jev-1-20260926",
    });
    const late = await decisions
      .decide({ key: "k", model: "jev", state: "s", questions: TRIAGE }, { deadline: future(50) })
      .catch((error: unknown) => error);
    expect(late).toBeInstanceOf(DeadlineExceededError);
    expect(decisions.records()[0]).toMatchObject({
      outcome: "timed-out",
      error: expect.stringMatching(/^deadline exceeded after 1 attempt; artifact not written/),
    });
  });

  test("a state Jev cannot take, or a model the operator could not install, is refused before sending", async () => {
    const provider = createFakeDecisionProvider();
    const decisions = new RunDecisions({
      installation: { ...installation(provider), unavailable: { other: "OTHER_KEY is not set" } },
      runDir: runDirs.tempRunDir(),
    });
    const ask = (model: string, state: unknown) =>
      decisions
        .decide(
          { key: "k", model, state: state as string, questions: TRIAGE },
          { deadline: future() },
        )
        .catch((error: Error) => error.message);
    expect(await ask("jev", 42)).toBe("decision k: a state is text, an object or an array");
    expect(await ask("jev", null)).toBe("decision k: a state is text, an object or an array");
    expect(await ask("other", "s")).toBe(
      'decision model "other" is unavailable: OTHER_KEY is not set',
    );
    expect(provider.requests).toEqual([]);
    expect(decisions.records()).toEqual([]);
  });

  test("rejects a deadline that is not one, rather than ignoring it", async () => {
    const decisions = new RunDecisions({
      installation: installation(createFakeDecisionProvider()),
      runDir: runDirs.tempRunDir(),
    });
    await expect(
      decisions.decide(
        {
          key: "k",
          model: "jev",
          state: "s",
          questions: TRIAGE,
          deadline: { unixMilliseconds: Number.NaN },
        },
        { deadline: future() },
      ),
    ).rejects.toThrow("non-negative safe integer");
    expect(decisions.records()).toEqual([]);
  });

  test("an option named like a prototype key is answered in full", async () => {
    const options = JSON.parse('{"__proto__": "an odd name", "toString": null}');
    const decisions = new RunDecisions({
      installation: installation(
        createFakeDecisionProvider([
          {
            snapshot: "s",
            answers: {
              odd: {
                type: "choice",
                probabilities: JSON.parse('{"__proto__": 0.7, "toString": 0.3}'),
              },
            },
            tokens: { input: 1, output: 0 },
          },
        ]),
      ),
      runDir: runDirs.tempRunDir(),
    });
    const { answers } = await decisions.decide(
      { key: "k", model: "jev", state: "s", questions: { odd: choice("Which?", options) } },
      { deadline: future() },
    );
    expect(answers.odd.choice).toBe("__proto__");
    expect(Object.hasOwn(answers.odd.probabilities, "__proto__")).toBe(true);
    expect(Object.keys(answers.odd.probabilities)).toEqual(["__proto__", "toString"]);
  });
});

describe("decision accounting", () => {
  const decision = (overrides: Partial<SettledDecision>): SettledDecision => ({
    callPath: [],
    key: "match:f1",
    alias: "jev",
    provider: "openrouter",
    model: "typesafe/jev-1.13",
    snapshot: "typesafe/jev-1.13-20260917",
    startedAt: "2026-09-23T10:00:01.000Z",
    settledAt: "2026-09-23T10:00:01.200Z",
    questions: [{ id: "issue", type: "choice" }],
    questionsDigest: "d",
    outcome: "answered",
    attempts: 1,
    tokens: { input: 1_000_000, output: 5 },
    artifact: "decisions/1.json",
    ...overrides,
  });
  const TIMES = { startedAt: "2026-09-23T10:00:00.000Z", finishedAt: "2026-09-23T10:00:05.000Z" };

  test("an unpriced decision model is named, and its calls are not priced", () => {
    const summary = summarizeRun([], PUBLISHED_PRICES, TIMES, [
      decision({}),
      decision({ key: "grade:1", model: "other/model", snapshot: "other/model-v2" }),
      decision({ key: "grade:2", outcome: "failed", tokens: undefined, snapshot: undefined }),
    ]);
    expect(summary.unpriced).toEqual(["other/model-v2"]);
    expect(summary.totals.decisions).toEqual({
      calls: 3,
      attempts: 3,
      tokens: { input: 2_000_000, output: 10 },
      estimate: expect.closeTo(0.042, 10),
      known: 2,
      priced: 1,
    });
    expect(summary.byStage.map(({ stage }) => stage)).toEqual(["match", "grade"]);
    expect(summary.byAgent).toEqual([]);
    expect(describeAccounting(summary)).toEqual([
      "0 agents · 5s · unpriced: other/model-v2",
      "  3 decisions · 2.00M tokens · ~$0.04 at list prices · usage known 2/3 · priced 1/3",
      "  match  1 decision · 0s · ~$0.04",
      "  grade  2 decisions · 0s · usage known 1/2 · priced 0/2",
    ]);
  });

  test("a stage with agents and decisions shows both, each with its own cost", () => {
    const agent: SettledOperation = {
      callPath: [],
      agent: "review:lens",
      operationId: "op-1",
      execution: { harness: "claude", model: "claude-sonnet-5" },
      deliveredAt: "2026-09-23T10:00:00.000Z",
      settledAt: "2026-09-23T10:00:02.000Z",
      sessions: [],
      billing: "metered",
      spend: [
        {
          model: "claude-sonnet-5",
          delegated: false,
          tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      ],
    };
    // A second stage, priced at nothing, so the stages are listed.
    const idle: SettledOperation = { ...agent, agent: "lint:a", operationId: "op-2", spend: [] };
    const summary = summarizeRun([agent, idle], PUBLISHED_PRICES, TIMES, [
      decision({ key: "review:match", settledAt: "2026-09-23T10:00:03.000Z" }),
    ]);
    const [stage] = summary.byStage;
    expect(stage).toMatchObject({ stage: "review", agents: 1, estimate: 2, spanMs: 3_000 });
    expect(stage?.decisions?.calls).toBe(1);
    expect(stage?.decisions?.estimate).toBeCloseTo(0.042, 10);
    expect(summary.totals.estimate).toBe(2);
    expect(summary.byAgent[0]).not.toHaveProperty("decisions");
    expect(summary.byModel.map(({ model, decisionCalls }) => [model, decisionCalls])).toEqual([
      ["claude-sonnet-5", undefined],
      ["typesafe/jev-1.13-20260917", 1],
    ]);
    expect(describeAccounting(summary)[2]).toBe(
      "  review  1 agent, 1 decision · 3s · ~$2.00 · ~$0.04 in decisions",
    );
  });
});

function run<Result extends JsonValue>(
  provider: ReturnType<typeof createFakeDecisionProvider>,
  runRoot: string,
  body: (context: WorkflowContext) => Promise<Result>,
) {
  return runWorkflow(workflowOf(body), null, options(provider, runRoot));
}

function options(provider: ReturnType<typeof createFakeDecisionProvider>, runRoot: string) {
  const decisions: DecisionInstallation = {
    providers: { openrouter: provider },
    aliases: { jev: { provider: "openrouter", model: "typesafe/jev-1.13" } },
  };
  return { runRoot, runtime: emptyRuntime(), deadline: future(), decisions };
}

function emptyRuntime(): AgentRuntimeConfig {
  return {
    aliases: {},
    host: createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) })),
  };
}

function workflowOf<Result extends JsonValue>(
  run: (context: WorkflowContext) => Promise<Result>,
): WorkflowDefinition<null, Result> {
  return { meta: { name: "decisions", description: "decisions" }, run };
}

function unexpected(): never {
  throw new Error("the run was expected to fail");
}

function failed(error: unknown): WorkflowRunError {
  expect(error).toBeInstanceOf(WorkflowRunError);
  return error as WorkflowRunError;
}
