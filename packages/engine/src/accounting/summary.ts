import type {
  AccountingFigures,
  DecisionFigures,
  ModelFigures,
  RunAccounting,
  SettledDecision,
  SettledOperation,
  TokenUsage,
} from "@agentswf/contract/records";
import { costOf, type PriceTable } from "./prices";
import { addTokens } from "./tokens";

const NONE: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/**
 * What a run cost and how long it took, from its usage and decision records alone, so a finished
 * run can be priced again with another table.
 */
export function summarizeRun(
  usage: readonly SettledOperation[],
  prices: PriceTable,
  times: { startedAt: string; finishedAt: string },
  decisions: readonly SettledDecision[],
): RunAccounting {
  const spends = usage.flatMap((record) => record.spend ?? []);
  const agentModels = unique(spends.map((spend) => spend.model));
  const decisionModels = unique(decisions.filter((record) => record.tokens).map(decisionModelOf));
  const models = unique([...agentModels, ...decisionModels]).sort();
  const agentIds = unique(usage.map(agentOf));
  const stages = unique([...usage.map(stageOf), ...decisions.map(decisionStageOf)]);
  const billings = unique(usage.map((record) => record.billing)).filter(
    (billing) => billing !== "unknown",
  );
  const figures = (
    records: readonly SettledOperation[],
    asked: readonly SettledDecision[] = [],
  ): AccountingFigures => {
    const agents = figuresOf(records, prices);
    return asked.length === 0 ? agents : { ...agents, decisions: decisionFigures(asked, prices) };
  };

  return {
    basis: prices.basis,
    startedAt: times.startedAt,
    finishedAt: times.finishedAt,
    wallMs: Date.parse(times.finishedAt) - Date.parse(times.startedAt),
    billing: billings.length === 0 ? "unknown" : billings.length === 1 ? billings[0]! : "mixed",
    totals: figures(usage, decisions),
    byStage: stages.map((stage) => {
      const records = usage.filter((record) => stageOf(record) === stage);
      const asked = decisions.filter((record) => decisionStageOf(record) === stage);
      return { stage, ...figures(records, asked), spanMs: spanOf(records, asked) };
    }),
    byModel: models.map((model) => {
      const agents = modelFigures(model, usage, prices);
      const answered = decisions.filter(
        (record) => record.tokens && decisionModelOf(record) === model,
      );
      return answered.length === 0 ? agents : withDecisions(agents, answered, prices);
    }),
    byAgent: agentIds.map((id) => {
      const records = usage.filter((record) => agentOf(record) === id);
      const first = records[0]!;
      return {
        callPath: first.callPath,
        agent: first.agent,
        stage: stageOf(first),
        execution: first.execution,
        billing: first.billing,
        ...figures(records),
      };
    }),
    unpriced: models.filter((model) => !prices.rate(model)),
  };
}

function figuresOf(records: readonly SettledOperation[], prices: PriceTable): AccountingFigures {
  let tokens = NONE;
  let delegated = NONE;
  let charged: number | undefined;
  let agentMs = 0;
  const agents = new Map<
    string,
    { known: boolean; priced: boolean; billed: boolean; cost: number }
  >();
  for (const record of records) {
    const id = agentOf(record);
    const agent = agents.get(id) ?? {
      known: true,
      priced: true,
      billed: record.billing !== "unknown",
      cost: 0,
    };
    agents.set(id, agent);
    if (record.deliveredAt !== undefined && record.settledAt !== undefined) {
      agentMs += Date.parse(record.settledAt) - Date.parse(record.deliveredAt);
    }
    // Another currency would need converting first; until then its charge is an unknown one.
    if (record.charged?.currency === "USD") charged = (charged ?? 0) + record.charged.amount;
    else if (record.charged) agent.billed = false;
    if (!record.spend) {
      agent.known = false;
      agent.priced = false;
      continue;
    }
    for (const spend of record.spend) {
      tokens = addTokens(tokens, spend.tokens);
      if (spend.delegated) delegated = addTokens(delegated, spend.tokens);
      const rate = prices.rate(spend.model);
      if (rate) agent.cost += costOf(spend.tokens, rate);
      else agent.priced = false;
    }
  }
  const counts = [...agents.values()];
  let estimate: number | undefined;
  for (const agent of counts) {
    // A partly priced agent adds what was priced; a fully priced one makes even a zero known.
    if (agent.priced || agent.cost > 0) estimate = (estimate ?? 0) + agent.cost;
  }
  return {
    agents: agents.size,
    agentMs,
    tokens,
    delegated,
    ...(estimate === undefined ? {} : { estimate }),
    ...(charged === undefined ? {} : { charged }),
    known: counts.filter((agent) => agent.known).length,
    priced: counts.filter((agent) => agent.priced).length,
    billed: counts.filter((agent) => agent.billed).length,
  };
}

function decisionFigures(records: readonly SettledDecision[], prices: PriceTable): DecisionFigures {
  let input = 0;
  let output = 0;
  let estimate: number | undefined;
  let charged: number | undefined;
  let known = 0;
  let priced = 0;
  let attempts = 0;
  for (const record of records) {
    attempts += record.attempts;
    // Another currency would need converting first; until then its charge is not counted.
    if (record.charged?.currency === "USD") charged = (charged ?? 0) + record.charged.amount;
    if (!record.tokens) continue;
    known += 1;
    input += record.tokens.input;
    output += record.tokens.output;
    const rate = prices.rate(decisionModelOf(record));
    if (!rate) continue;
    priced += 1;
    estimate = (estimate ?? 0) + costOf(decisionTokens(record.tokens), rate);
  }
  return {
    calls: records.length,
    attempts,
    tokens: { input, output },
    ...(estimate === undefined ? {} : { estimate }),
    ...(charged === undefined ? {} : { charged }),
    known,
    priced,
  };
}

function withDecisions(
  agents: ModelFigures,
  answered: readonly SettledDecision[],
  prices: PriceTable,
): ModelFigures {
  let tokens = agents.tokens;
  for (const record of answered) tokens = addTokens(tokens, decisionTokens(record.tokens!));
  const rate = prices.rate(agents.model);
  return {
    ...agents,
    decisionCalls: answered.length,
    tokens,
    ...(rate ? { estimate: costOf(tokens, rate) } : {}),
  };
}

function decisionTokens(tokens: { input: number; output: number }): TokenUsage {
  return { ...NONE, input: tokens.input, output: tokens.output };
}

/** Priced as the model that answered, when one did: an alias can move, and so can its price. */
function decisionModelOf(record: SettledDecision): string {
  return record.snapshot ?? record.model;
}

function decisionStageOf(record: SettledDecision): string {
  return [...record.callPath, prefixOf(record.key)].join("/");
}

function modelFigures(
  model: string,
  usage: readonly SettledOperation[],
  prices: PriceTable,
): ModelFigures {
  const rate = prices.rate(model);
  const agents = new Set<string>();
  let tokens = NONE;
  let delegated = NONE;
  for (const record of usage) {
    for (const spend of record.spend ?? []) {
      if (spend.model !== model) continue;
      agents.add(agentOf(record));
      tokens = addTokens(tokens, spend.tokens);
      if (spend.delegated) delegated = addTokens(delegated, spend.tokens);
    }
  }
  return {
    model,
    agents: agents.size,
    tokens,
    delegated,
    ...(rate ? { estimate: costOf(tokens, rate) } : {}),
  };
}

/** An agent is its key within its call: the same key in two nested calls is two agents. */
function agentOf(record: SettledOperation): string {
  return JSON.stringify([record.callPath, record.agent]);
}

function stageOf(record: SettledOperation): string {
  return [...record.callPath, prefixOf(record.agent)].join("/");
}

function prefixOf(key: string): string {
  const separator = key.indexOf(":");
  return separator === -1 ? key : key.slice(0, separator);
}

function spanOf(
  records: readonly SettledOperation[],
  decisions: readonly SettledDecision[] = [],
): number {
  const starts = [
    ...records.flatMap((record) =>
      record.deliveredAt === undefined ? [] : [Date.parse(record.deliveredAt)],
    ),
    ...decisions.map((record) => Date.parse(record.startedAt)),
  ];
  const ends = [
    ...records.flatMap((record) =>
      record.settledAt === undefined ? [] : [Date.parse(record.settledAt)],
    ),
    ...decisions.map((record) => Date.parse(record.settledAt)),
  ];
  return starts.length === 0 || ends.length === 0
    ? 0
    : Math.max(0, Math.max(...ends) - Math.min(...starts));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
