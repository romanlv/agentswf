import type {
  AccountingFigures,
  AttemptAccounting,
  DecisionFigures,
} from "@agentswf/contract/records";
import { PUBLISHED_PRICES } from "./prices";

/**
 * The run in one line, its decisions in another when it asked any, then a line per stage when there
 * is more than one. Gaps are named, never shown as zero; what is complete is left to the record.
 */
export function describeAccounting(accounting: AttemptAccounting): string[] {
  const stages = accounting.byStage.length > 1 ? accounting.byStage : [];
  return [
    [
      ...(accounting.totals.agents === 0 ? [plural(0, "agent")] : []),
      ...describeFigures(accounting, duration(accounting.wallMs)),
    ].join(" · "),
    ...describeDecisionLine(accounting),
    ...describeSlices(stages),
  ];
}

/**
 * What the agents cost: their count, tokens, estimate, billing and gaps, with `took` after the
 * count; just `took` and what went unpriced for a run that opened no agent.
 */
export function describeFigures(accounting: AttemptAccounting, took?: string): string[] {
  const { totals } = accounting;
  const basis = shortBasis(accounting.basis);
  const spent = took === undefined ? [] : [took];
  const unpriced =
    accounting.unpriced.length === 0 ? [] : [`unpriced: ${accounting.unpriced.join(", ")}`];
  // A run that opened no agent has no agent usage to be missing.
  if (totals.agents === 0) return [...spent, ...unpriced];
  return [
    plural(totals.agents, "agent"),
    ...spent,
    totals.known === 0 ? "no usage known" : plural(total(totals), "token", count),
    ...(totals.estimate === undefined ? [] : [`${estimate(totals.estimate)} at ${basis}`]),
    ...(totals.charged === undefined ? [] : [`${usd(totals.charged)} charged`]),
    accounting.billing,
    ...(totals.billed < totals.agents ? [`billing known ${totals.billed}/${totals.agents}`] : []),
    ...(totals.known < totals.agents && totals.known > 0
      ? [`usage known ${totals.known}/${totals.agents}`]
      : []),
    ...gaps(totals),
    ...unpriced,
  ];
}

/** A run of several attempts, in brief: how many, how long in all, and the estimate when any agent ran. */
export function describeAttempts(
  sum: AttemptAccounting,
  attempts: number,
  unaccounted: number,
): string {
  const gap = unaccounted > 0 ? ` (${unaccounted} with no accounting)` : "";
  const priced =
    sum.totals.agents > 0 && sum.totals.estimate !== undefined
      ? [estimate(sum.totals.estimate)]
      : [];
  return `run: ${[`${attempts} attempts${gap}`, duration(sum.wallMs), ...priced].join(", ")}`;
}

/** The run's decisions on a line of their own, when it asked any. */
export function describeDecisionLine(accounting: AttemptAccounting): string[] {
  const { decisions } = accounting.totals;
  return decisions ? [describeDecisions(decisions, shortBasis(accounting.basis))] : [];
}

/**
 * A workflow's stages, each to what its agents and decisions cost; a stage that opened none and
 * asked nothing is left out, not shown at zero.
 */
export function stageFigures(accounting: AttemptAccounting): Map<string, string> {
  if (accounting.grouping !== "stages") return new Map();
  return new Map(
    accounting.byStage.flatMap((stage) => {
      const figures = sliceFigures(stage);
      return figures.length === 0 ? [] : [[stage.stage, figures.join(" · ")] as const];
    }),
  );
}

/**
 * A run without stages, a line per group of its agents, when there is more than one and any agent
 * ran: stages are on their own lines in the view.
 */
export function describeGroups(accounting: AttemptAccounting): string[] {
  const groups =
    accounting.grouping === "prefix" &&
    accounting.byStage.length > 1 &&
    accounting.totals.agents > 0
      ? accounting.byStage
      : [];
  return describeSlices(groups);
}

function describeSlices(slices: AttemptAccounting["byStage"]): string[] {
  const width = Math.max(0, ...slices.map(({ stage }) => stage.length));
  return slices.map((stage) => {
    const [counted, ...rest] = sliceFigures(stage, true);
    return [`  ${stage.stage.padEnd(width)}  ${counted}`, duration(stage.spanMs), ...rest].join(
      " · ",
    );
  });
}

/**
 * One slice's agents and decisions. `counted` keeps a slice with neither as `0 agents`, and the
 * agents and decisions counted together first, for a table's rows.
 */
function sliceFigures(stage: AttemptAccounting["byStage"][number], counted = false): string[] {
  const tokens = stage.known === 0 ? "no usage known" : plural(total(stage), "token", count);
  const priced = stage.estimate === undefined ? [] : [estimate(stage.estimate)];
  const agents =
    stage.agents === 0
      ? []
      : [
          // A table's row has room for the estimate alone, when there is one.
          ...(counted && priced.length > 0 ? priced : [tokens, ...priced]),
          ...(stage.known < stage.agents && stage.known > 0
            ? [`usage known ${stage.known}/${stage.agents}`]
            : []),
          ...gaps(stage),
        ];
  const decisions = stage.decisions
    ? [
        plural(stage.decisions.calls, "decision"),
        ...(stage.decisions.estimate === undefined
          ? stage.decisions.known === 0
            ? ["no usage known"]
            : []
          : [
              stage.agents === 0
                ? estimate(stage.decisions.estimate)
                : `${estimate(stage.decisions.estimate)} in decisions`,
            ]),
        ...decisionGaps(stage.decisions),
      ]
    : [];
  const agentCount =
    stage.agents === 0 && (stage.decisions || !counted) ? [] : [plural(stage.agents, "agent")];
  if (counted) {
    return [[...agentCount, ...decisions.slice(0, 1)].join(", "), ...agents, ...decisions.slice(1)];
  }
  return [...agentCount, ...agents, ...decisions];
}

/** The published table by its kind alone, its date being in the record; any other table in full. */
function shortBasis(basis: string): string {
  return basis === PUBLISHED_PRICES.basis ? "list prices" : basis;
}

/** Decisions are not agents: their calls, tokens and cost stay on a line of their own. */
function describeDecisions(decisions: DecisionFigures, basis: string): string {
  const tokens = decisions.tokens.input + decisions.tokens.output;
  return [
    `  ${plural(decisions.calls, "decision")}`,
    ...(decisions.attempts > decisions.calls ? [plural(decisions.attempts, "request")] : []),
    decisions.known === 0 ? "no usage known" : plural(tokens, "token", count),
    ...(decisions.estimate === undefined ? [] : [`${estimate(decisions.estimate)} at ${basis}`]),
    ...(decisions.charged === undefined ? [] : [`${usd(decisions.charged)} charged`]),
    ...decisionGaps(decisions),
  ].join(" · ");
}

/** As for agents: unknown usage first, then usage known but not all priced. */
function decisionGaps(decisions: DecisionFigures): string[] {
  return [
    ...(decisions.known < decisions.calls
      ? [`usage known ${decisions.known}/${decisions.calls}`]
      : []),
    ...(decisions.priced < decisions.known
      ? [`priced ${decisions.priced}/${decisions.calls}`]
      : []),
  ];
}

function total({ tokens }: AccountingFigures): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

/** An agent whose usage is known but not all priced adds only its priced part to an estimate. */
function gaps(figures: AccountingFigures): string[] {
  return figures.priced < figures.known ? [`fully priced ${figures.priced}/${figures.agents}`] : [];
}

function plural(amount: number, noun: string, show: (amount: number) => string = String): string {
  return `${show(amount)} ${noun}${amount === 1 ? "" : "s"}`;
}

/** A span as a person reads it: `42s`, `3m 05s`, `1h 02m`. */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function count(tokens: number): string {
  if (tokens >= 999_500) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function usd(amount: number): string {
  return belowCent(amount) ? "<$0.01" : `$${amount.toFixed(2)}`;
}

/** Marked approximate, unless `<` already says so. */
function estimate(amount: number): string {
  return belowCent(amount) ? usd(amount) : `~${usd(amount)}`;
}

/** A real cost too small to show in cents is not shown as nothing. */
function belowCent(amount: number): boolean {
  return amount > 0 && amount < 0.005;
}
