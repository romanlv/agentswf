import { describe, expect, test } from "bun:test";
import type { ModelSpend, SettledOperation, TokenUsage } from "@agentswf/contract/records";
import { describeAccounting, describeAttempts, stageFigures } from "./format";
import { planPrice } from "./plans";
import { costOf, type PriceTable, PUBLISHED_PRICES } from "./prices";
import { sumAttempts, summarizeRun } from "./summary";
import { addTokens, spendOf } from "./tokens";

const OPUS = PUBLISHED_PRICES.rate("claude-opus-5")!;
const TIMES = { startedAt: "2026-09-23T10:00:00.000Z", finishedAt: "2026-09-23T10:14:05.000Z" };

function tokens(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...overrides };
}

function record(
  agent: string,
  spend: ModelSpend[] | undefined,
  overrides: Partial<SettledOperation> = {},
) {
  return {
    callPath: [],
    agent,
    operationId: `${agent}#1`,
    execution: { harness: "codex", model: "gpt-5.6-terra" },
    deliveredAt: "2026-09-23T10:00:01.000Z",
    settledAt: "2026-09-23T10:01:01.000Z",
    sessions: [],
    billing: "subscription",
    ...(spend ? { spend } : {}),
    ...overrides,
  } satisfies SettledOperation;
}

const spent = (model: string, used: Partial<TokenUsage>, delegated = false): ModelSpend => ({
  model,
  delegated,
  tokens: tokens(used),
});

// Ported from `braintrust/agent/loops/shared/usage/records.test.ts`.
describe("costOf", () => {
  test("uncached input bills at the model's input rate, output at its output rate", () => {
    expect(costOf(tokens({ input: 1_000_000 }), OPUS)).toBe(5);
    expect(costOf(tokens({ output: 1_000_000 }), OPUS)).toBe(25);
  });

  test.each([
    ["a one-hour cache write costs twice input", { cacheWrite: 1e6, cacheWrite1h: 1e6 }, 10],
    ["a five-minute cache write costs a quarter more", { cacheWrite: 1_000_000 }, 6.25],
    ["a cache read costs a tenth", { cacheRead: 1_000_000 }, 0.5],
  ] as const)("%s", (_name, written, expected) => {
    expect(costOf(tokens(written), OPUS)).toBeCloseTo(expected, 10);
  });

  test("prices a whole review the way the harness's own accounting does", () => {
    const review = tokens({
      input: 148,
      cacheWrite: 222_349,
      cacheWrite1h: 222_349,
      cacheRead: 7_662_838,
      output: 56_937,
    });
    expect(costOf(review, OPUS)).toBeCloseTo(7.4791, 4);
  });

  test("reasoning is part of output and is not priced twice", () => {
    expect(costOf(tokens({ output: 1_000_000, reasoning: 400_000 }), OPUS)).toBe(25);
  });

  test("codex cached input is priced at OpenAI's cached rate", () => {
    const terra = PUBLISHED_PRICES.rate("gpt-5.6-terra")!;
    expect(costOf(tokens({ cacheRead: 1_000_000 }), terra)).toBeCloseTo(0.2, 10);
    // Experiment 10: pi's own figure for one terra request.
    expect(costOf(tokens({ input: 4317, cacheRead: 2560, output: 55 }), terra)).toBeCloseTo(
      0.009806,
      6,
    );
  });

  test("a model with its own cache discount keeps it", () => {
    const opus55 = PUBLISHED_PRICES.rate("claude-opus-5-5-20260901")!;
    expect(costOf(tokens({ cacheRead: 1_000_000 }), opus55)).toBeCloseTo(0.2, 10);
  });
});

describe("published prices", () => {
  test("prices a dated model id as its family", () => {
    expect(PUBLISHED_PRICES.rate("claude-haiku-4-5-20251001")).toMatchObject({
      input: 1,
      output: 5,
    });
    expect(PUBLISHED_PRICES.rate("claude-opus-5")).toMatchObject({ input: 5 });
    expect(PUBLISHED_PRICES.rate("claude-opus-5-5")).toMatchObject({ input: 4 });
  });

  test("prices every model an agent here is configured to run", () => {
    for (const model of [
      "claude-opus-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]) {
      expect(PUBLISHED_PRICES.rate(model)).toBeDefined();
    }
  });

  test("prices the newest models as their own, not as an older sibling", () => {
    expect(PUBLISHED_PRICES.rate("claude-opus-5-5")).toMatchObject({ input: 4, cacheRead: 0.2 });
    expect(PUBLISHED_PRICES.rate("claude-opus-5-5[1m]")).toMatchObject({ input: 4 });
    expect(PUBLISHED_PRICES.rate("claude-sonnet-5-5")).toMatchObject({
      input: 2,
      cacheRead: 0.1,
      output: 10,
    });
    expect(PUBLISHED_PRICES.rate("gpt-6-sol")).toMatchObject({
      input: 2,
      cacheRead: 0.2,
      output: 10,
    });
    expect(PUBLISHED_PRICES.rate("gpt-6.1-sol")).toMatchObject({
      input: 2,
      cacheRead: 0.1,
      output: 10,
    });
    expect(PUBLISHED_PRICES.rate("gpt-6-astra")).toMatchObject({
      input: 10,
      cacheRead: 1,
      output: 50,
    });
    expect(PUBLISHED_PRICES.rate("gpt-6-sol-2026-09-01")).toMatchObject({ input: 2 });
  });

  test("has no rate for a model it does not know, or a sibling of one it does", () => {
    for (const model of [
      "gpt-4",
      "codex-auto-review",
      "claude-opus-50",
      "claude-opus-5-6",
      "claude-sonnet-5-1",
      "gpt-5.5-pro",
      "gpt-6-sol-mini",
      "gpt-6.1-sol-mini",
      "__proto__",
    ]) {
      expect(PUBLISHED_PRICES.rate(model)).toBeUndefined();
    }
  });

  test("OpenAI's newer models charge 1.25x input to write their cache; gpt-5.5 lists none", () => {
    expect(costOf(tokens({ cacheWrite: 1_000_000 }), PUBLISHED_PRICES.rate("gpt-5.6-terra")!)).toBe(
      2.5,
    );
    expect(costOf(tokens({ cacheWrite: 1_000_000 }), PUBLISHED_PRICES.rate("gpt-5.5")!)).toBe(5);
  });

  test("names the table every figure came from", () => {
    expect(PUBLISHED_PRICES.basis).toContain("2026-09-26");
  });
});

describe("summarizeRun", () => {
  test("bills each model at its own rate, and separates what subagents spent", () => {
    const summary = summarizeRun(
      [
        record("lens:a", [
          spent("claude-opus-5", { output: 1_000_000 }),
          spent("claude-haiku-4-5", { output: 1_000_000 }, true),
        ]),
      ],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(summary.totals.estimate).toBe(30);
    expect(summary.totals.delegated.output).toBe(1_000_000);
    expect(summary.byModel.map(({ model, estimate }) => [model, estimate])).toEqual([
      ["claude-haiku-4-5", 5],
      ["claude-opus-5", 25],
    ]);
  });

  test("an unpriced model's tokens are counted and named, never priced at zero", () => {
    const empty: PriceTable = { basis: "none", rate: () => undefined };
    const summary = summarizeRun(
      [record("lens:a", [spent("claude-next", { output: 500 })])],
      empty,
      TIMES,
      [],
    );
    expect(summary.unpriced).toEqual(["claude-next"]);
    expect(summary.totals.tokens.output).toBe(500);
    expect(summary.totals).not.toHaveProperty("estimate");
    expect(summary.totals).toMatchObject({ agents: 1, known: 1, priced: 0 });
  });

  test("a partial run says how much is known, and prices only that", () => {
    const summary = summarizeRun(
      [
        record("lens:a", [spent("gpt-5.6-terra", { input: 1_000_000 })]),
        record("lens:b", undefined),
        record("verifier:a", [], { billing: "metered", charged: { amount: 0.5, currency: "USD" } }),
      ],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(summary.totals).toMatchObject({ agents: 3, known: 2, priced: 2, estimate: 2 });
    expect(summary.billing).toBe("mixed");
    // The verifier is known to have spent nothing, which is a zero; lens:b is unknown, which is not.
    expect(summary.byStage).toEqual([
      expect.objectContaining({ stage: "lens", agents: 2, known: 1, estimate: 2 }),
      expect.objectContaining({
        stage: "verifier",
        agents: 1,
        known: 1,
        estimate: 0,
        charged: 0.5,
      }),
    ]);
    const unknown = summarizeRun([record("lens:b", undefined)], PUBLISHED_PRICES, TIMES, []);
    expect(unknown.totals).not.toHaveProperty("estimate");
    expect(describeAccounting(unknown)[0]).toBe(
      "1 agent · 14m 05s · no usage known · subscription",
    );
  });

  test("a charge in another currency is an unknown charge, not a missing one", () => {
    const summary = summarizeRun(
      [
        record("verifier:a", [], { billing: "metered", charged: { amount: 0.5, currency: "USD" } }),
        record("verifier:b", [], { billing: "metered", charged: { amount: 3, currency: "EUR" } }),
      ],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(summary.totals).toMatchObject({ agents: 2, charged: 0.5, billed: 1 });
  });

  test("times: the run's wall clock, each agent's working time, and each stage's span", () => {
    const summary = summarizeRun(
      [
        record("lens:a", []),
        record("lens:b", [], {
          deliveredAt: "2026-09-23T10:00:31.000Z",
          settledAt: "2026-09-23T10:02:01.000Z",
        }),
      ],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(summary.wallMs).toBe(845_000);
    expect(summary.totals.agentMs).toBe(60_000 + 90_000);
    expect(summary.byStage[0]!.spanMs).toBe(120_000);
    expect(summary.byAgent.map(({ agent, agentMs }) => [agent, agentMs])).toEqual([
      ["lens:a", 60_000],
      ["lens:b", 90_000],
    ]);
  });

  test("a nested call's stage is its call path and the agent key's prefix", () => {
    const summary = summarizeRun(
      [record("reviewer:x", [], { callPath: ["review", "round-2"] })],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(summary.byStage.map(({ stage }) => stage)).toEqual(["review/round-2/reviewer"]);
  });
});

describe("byModel", () => {
  test("a model's share has tokens and an estimate, never a charge or time it cannot split", () => {
    const summary = summarizeRun(
      [
        record(
          "lens:a",
          [
            spent("claude-opus-5", { output: 1_000_000 }),
            spent("claude-haiku-4-5", { output: 1_000_000 }, true),
          ],
          { billing: "metered", charged: { amount: 7, currency: "USD" } },
        ),
      ],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(summary.byModel).toEqual([
      {
        model: "claude-haiku-4-5",
        agents: 1,
        tokens: tokens({ output: 1e6 }),
        delegated: tokens({ output: 1e6 }),
        estimate: 5,
      },
      {
        model: "claude-opus-5",
        agents: 1,
        tokens: tokens({ output: 1e6 }),
        delegated: tokens(),
        estimate: 25,
      },
    ]);
    expect(summary.totals.charged).toBe(7);
  });
});

describe("describeAccounting", () => {
  test("one line for the run and one per stage when there are several, naming every gap", () => {
    const summary = summarizeRun(
      [
        record("lens:a", [spent("gpt-5.6-terra", { input: 400_000, cacheRead: 2_910_000 })]),
        record("lens:b", undefined),
        record("verifier:a", [spent("codex-auto-review", { output: 1_000 })]),
      ],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(describeAccounting(summary)).toEqual([
      "3 agents · 14m 05s · 3.31M tokens · ~$1.38 at list prices · subscription · usage known 2/3 · fully priced 1/3 · unpriced: codex-auto-review",
      "  lens      2 agents · 1m 00s · ~$1.38 · usage known 1/2",
      "  verifier  1 agent · 1m 00s · 1k tokens · fully priced 0/1",
    ]);
    // A run without stages keeps its groups where a view shows the stages.
    expect(describeAccounting(summary, { stages: false })).toEqual(describeAccounting(summary));
    expect(stageFigures(summary)).toEqual(new Map());
  });

  test("a run that opened no agent shows no agent figures, and several attempts are summed in brief", () => {
    const none = summarizeRun([], PUBLISHED_PRICES, TIMES, []);
    expect(describeAccounting(none)).toEqual(["14m 05s"]);
    const one = summarizeRun(
      [record("lens:a", [spent("claude-opus-5", { output: 100_000 })])],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(describeAttempts(sumAttempts([none, one]), 3, { interrupted: 1, ended: 0 })).toBe(
      "run: 3 attempts (1 interrupted, cost unknown), 28m 10s, ~$2.50",
    );
    expect(describeAttempts(sumAttempts([none, one]), 4, { interrupted: 1, ended: 1 })).toBe(
      "run: 4 attempts (1 interrupted, 1 ended without a cost record, cost unknown), 28m 10s, ~$2.50",
    );
    expect(describeAttempts(sumAttempts([none, none]), 2, { interrupted: 0, ended: 0 })).toBe(
      "run: 2 attempts, 28m 10s",
    );
  });
});

describe("describeAccounting gaps", () => {
  test("an agent whose billing is unknown is counted, not folded into the others", () => {
    const summary = summarizeRun(
      [record("lens:a", []), record("lens:b", [], { billing: "unknown" })],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(summary.billing).toBe("subscription");
    expect(summary.totals.billed).toBe(1);
    expect(describeAccounting(summary)[0]).toBe(
      "2 agents · 14m 05s · 0 tokens · ~$0.00 at list prices · subscription · billing known 1/2",
    );
  });

  test("a real cost under a cent is not shown as nothing, one token is one, and a lone stage is not repeated", () => {
    const summary = summarizeRun(
      [record("lens:a", [spent("gpt-5.6-luna", { input: 1 })])],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(describeAccounting(summary)).toEqual([
      "1 agent · 14m 05s · 1 token · <$0.01 at list prices · subscription",
    ]);
  });
});

describe("token arithmetic", () => {
  test("adds every class, and keeps an optional one absent unless either side has it", () => {
    expect(addTokens(tokens({ input: 1, output: 2 }), tokens({ input: 10, cacheRead: 3 }))).toEqual(
      tokens({ input: 11, cacheRead: 3, output: 2 }),
    );
    expect(addTokens(tokens({ reasoning: 1 }), tokens())).toEqual(tokens({ reasoning: 1 }));
  });

  test("spend is grouped by model and by who spent it", () => {
    const records = [
      { model: "m", delegated: false, tokens: tokens({ output: 1 }) },
      { model: "m", delegated: true, tokens: tokens({ output: 2 }) },
      { model: "m", delegated: false, tokens: tokens({ output: 3 }) },
    ];
    expect(spendOf(records)).toEqual([spent("m", { output: 4 }), spent("m", { output: 2 }, true)]);
  });
});

describe("byStage, from the workflow's stages", () => {
  const OPUS_SPEND = (output: number) => [spent("claude-opus-5", { output })];
  const worker = (stage: string | undefined, output: number, n: number) =>
    record("worker", OPUS_SPEND(output), {
      operationId: `worker#${n}`,
      ...(stage === undefined ? {} : { stage }),
    });

  test("one agent across three stages is split by stage, with what ran between them last", () => {
    const summary = summarizeRun(
      [
        worker("doc-review", 100_000, 1),
        worker(undefined, 50_000, 2),
        worker("implement", 200_000, 3),
        worker("qa", 300_000, 4),
      ],
      PUBLISHED_PRICES,
      TIMES,
      [],
      [
        { stage: "doc-review", spanMs: 0 },
        { stage: "implement", spanMs: 0 },
        { stage: "qa", spanMs: 0 },
      ],
    );
    expect(summary.byStage.map(({ stage, agents, estimate }) => [stage, agents, estimate])).toEqual(
      [
        ["doc-review", 1, 2.5],
        ["implement", 1, 5],
        ["qa", 1, 7.5],
        ["(no stage)", 1, 1.25],
      ],
    );
    expect(summary.grouping).toBe("stages");
    expect(summary.byAgent).toHaveLength(1);
    expect(summary.byAgent[0]).not.toHaveProperty("stage");
  });

  test("a reused stage is a row at zero, each stage is timed by its own span, and one that spent nothing is not shown", () => {
    const summary = summarizeRun(
      [worker("qa", 100_000, 1)],
      PUBLISHED_PRICES,
      TIMES,
      [],
      [
        { stage: "implement", spanMs: 0 },
        { stage: "qa", spanMs: 90_000 },
        { stage: "notify", spanMs: 3_000 },
      ],
    );
    expect(
      summary.byStage.map(({ stage, agents, estimate, spanMs }) => [
        stage,
        agents,
        estimate,
        spanMs,
      ]),
    ).toEqual([
      ["implement", 0, undefined, 0],
      ["qa", 1, 2.5, 90_000],
      ["notify", 0, undefined, 3_000],
    ]);
    expect(stageFigures(summary)).toEqual(new Map([["qa", "1 agent · 100k tokens · ~$2.50"]]));
    expect(describeAccounting(summary)).toEqual([
      "1 agent · 14m 05s · 100k tokens · ~$2.50 at list prices · subscription",
      "  qa  1 agent · 1m 30s · ~$2.50",
    ]);
    expect(describeAccounting(summary, { stages: false })).toHaveLength(1);
  });

  test("a run with no stages keeps the key prefix", () => {
    const summary = summarizeRun(
      [record("lens:a", OPUS_SPEND(1)), record("verifier:0", OPUS_SPEND(1))],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    expect(summary.grouping).toBe("prefix");
    expect(summary.byStage.map(({ stage }) => stage)).toEqual(["lens", "verifier"]);
  });

  test("an attempt that failed before its first stage is summed as running between stages", () => {
    const before = summarizeRun(
      [record("lens:a", OPUS_SPEND(100_000))],
      PUBLISHED_PRICES,
      TIMES,
      [],
    );
    const staged = summarizeRun(
      [worker("qa", 100_000, 1), worker(undefined, 100_000, 2)],
      PUBLISHED_PRICES,
      TIMES,
      [],
      [{ stage: "qa", spanMs: 0 }],
    );
    const run = sumAttempts([before, staged]);
    expect(run.grouping).toBe("stages");
    expect(run.byStage.map(({ stage, agents, estimate }) => [stage, agents, estimate])).toEqual([
      ["qa", 1, 2.5],
      ["(no stage)", 2, 5],
    ]);
  });

  test("a run across two attempts sums its totals, and each stage across the attempts that ran it", () => {
    const first = summarizeRun(
      [worker("implement", 200_000, 1), worker("qa", 100_000, 2)],
      PUBLISHED_PRICES,
      TIMES,
      [],
      [
        { stage: "implement", spanMs: 0 },
        { stage: "qa", spanMs: 0 },
      ],
    );
    const second = summarizeRun(
      [worker("qa", 300_000, 3)],
      PUBLISHED_PRICES,
      TIMES,
      [],
      [
        { stage: "implement", spanMs: 0 },
        { stage: "qa", spanMs: 0 },
      ],
    );
    const run = sumAttempts([first, second]);
    expect(run.totals).toMatchObject({ agents: 2, estimate: 15 });
    expect(run.wallMs).toBe(2 * 845_000);
    expect(run.byStage.map(({ stage, agents, estimate }) => [stage, agents, estimate])).toEqual([
      ["implement", 1, 5],
      ["qa", 2, 10],
    ]);
  });

  test("an attempt whose usage is unknown keeps the sum's gap named", () => {
    const priced = summarizeRun(
      [worker("qa", 100_000, 1)],
      PUBLISHED_PRICES,
      TIMES,
      [],
      [{ stage: "qa", spanMs: 0 }],
    );
    const unknown = summarizeRun(
      [worker("qa", 0, 2)].map(({ spend: _spend, ...rest }) => rest),
      PUBLISHED_PRICES,
      TIMES,
      [],
      [{ stage: "qa", spanMs: 0 }],
    );
    const run = sumAttempts([priced, unknown]);
    expect(run.totals).toMatchObject({ agents: 2, known: 1, priced: 1, estimate: 2.5 });
    expect(describeAccounting({ ...run, byStage: [] })[0]).toContain("usage known 1/2");
  });
});

describe("plan prices", () => {
  test("a plan as its harness names it, priced where the table lists it", () => {
    expect(planPrice("claude", "max", "default_claude_max_20x")).toEqual({
      name: "Max 20x",
      usdPerMonth: 200,
    });
    expect(planPrice("claude", "max", "default_claude_max_5x")?.usdPerMonth).toBe(100);
    expect(planPrice("claude", "max")).toEqual({ name: "Max" });
    expect(planPrice("codex", "prolite")).toEqual({ name: "Pro 100", usdPerMonth: 100 });
    expect(planPrice("codex", "enterprise")).toBeUndefined();
    expect(planPrice("cursor", "Team")).toEqual({ name: "Team" });
    expect(planPrice("pi", "anything")).toBeUndefined();
  });
});
