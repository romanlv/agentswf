import type {
  AccountingFigures,
  AttemptAccounting,
  DecisionFigures,
} from "@agentswf/contract/records";
import { PUBLISHED_PRICES } from "./prices";

type Slice = AttemptAccounting["byStage"][number];

/**
 * What an attempt cost: a line of its figures, its decisions on a line of their own when it asked
 * any, then a row per stage or group when there is more than one. `stages: false` leaves a
 * workflow's stage rows to a view that shows them beside its stages; a run without stages keeps its
 * groups. A stage that opened no agent and asked nothing has no row, as it has no figures beside
 * it in that view. Gaps are named, never shown as zero; what is complete is left to the record.
 */
export function describeAccounting(
  accounting: AttemptAccounting,
  options: { stages?: boolean } = {},
): string[] {
  const staged = accounting.grouping === "stages";
  const rows =
    accounting.byStage.length > 1 && (!staged || options.stages !== false)
      ? accounting.byStage.filter((row) => !staged || row.agents > 0 || row.decisions)
      : [];
  const width = Math.max(0, ...rows.map(({ stage }) => stage.length));
  return [
    describeTotals(accounting),
    ...describeDecisionLine(accounting),
    ...rows.map((row) => sliceRow(row, width)),
  ];
}

/**
 * The agents' count, the time, then their tokens, estimate, billing and gaps. A run that opened no
 * agent is its time and what went unpriced; one that asked decisions says it opened no agent, so
 * they are not taken for agents.
 */
function describeTotals(accounting: AttemptAccounting): string {
  const { totals } = accounting;
  const basis = shortBasis(accounting.basis);
  const took = duration(accounting.wallMs);
  const unpriced =
    accounting.unpriced.length === 0 ? [] : [`unpriced: ${accounting.unpriced.join(", ")}`];
  if (totals.agents === 0) {
    return [...(totals.decisions ? [plural(0, "agent")] : []), took, ...unpriced].join(" · ");
  }
  return [
    plural(totals.agents, "agent"),
    took,
    tokensOf(totals),
    ...(totals.estimate === undefined ? [] : [`${estimate(totals.estimate)} at ${basis}`]),
    ...(totals.charged === undefined ? [] : [`${usd(totals.charged)} charged`]),
    accounting.billing,
    ...(totals.billed < totals.agents ? [`billing known ${totals.billed}/${totals.agents}`] : []),
    ...usageGap(totals),
    ...gaps(totals),
    ...unpriced,
  ].join(" · ");
}

/**
 * A run of several attempts, in brief: how many, those whose cost is unknown, by why, how long in
 * all, and the estimate when any agent ran. `unknown` counts the attempts with no cost recorded:
 * interrupted, or ended without one, as an older record may be.
 */
export function describeAttempts(
  sum: AttemptAccounting,
  attempts: number,
  unknown: { interrupted: number; ended: number },
): string {
  const why = [
    ...(unknown.interrupted > 0 ? [`${unknown.interrupted} interrupted`] : []),
    ...(unknown.ended > 0 ? [`${unknown.ended} ended without a cost record`] : []),
  ];
  const gap = why.length > 0 ? ` (${why.join(", ")}, cost unknown)` : "";
  const priced =
    sum.totals.agents > 0 && sum.totals.estimate !== undefined
      ? [estimate(sum.totals.estimate)]
      : [];
  return `run: ${[`${attempts} attempts${gap}`, duration(sum.wallMs), ...priced].join(", ")}`;
}

function describeDecisionLine(accounting: AttemptAccounting): string[] {
  const { decisions } = accounting.totals;
  return decisions ? [describeDecisions(decisions, shortBasis(accounting.basis))] : [];
}

/**
 * A workflow's stages, each to what its agents and decisions cost, for the view to show beside
 * them; a stage that opened none and asked nothing is left out, not shown at zero.
 */
export function stageFigures(accounting: AttemptAccounting): Map<string, string> {
  if (accounting.grouping !== "stages") return new Map();
  return new Map(
    accounting.byStage.flatMap((stage) => {
      const figures = [
        ...(stage.agents === 0
          ? []
          : [
              plural(stage.agents, "agent"),
              tokensOf(stage),
              ...priced(stage),
              ...agentGaps(stage),
            ]),
        ...(stage.decisions ? [plural(stage.decisions.calls, "decision")] : []),
        ...decisionCost(stage),
      ];
      return figures.length === 0 ? [] : [[stage.stage, figures.join(" · ")] as const];
    }),
  );
}

/**
 * A table's row: the agents and decisions counted together, `0 agents` for a slice with neither,
 * then its time, and the estimate alone where there is one, as the row has room for.
 */
function sliceRow(stage: Slice, width: number): string {
  const counted = [
    ...(stage.agents === 0 && stage.decisions ? [] : [plural(stage.agents, "agent")]),
    ...(stage.decisions ? [plural(stage.decisions.calls, "decision")] : []),
  ].join(", ");
  const agents =
    stage.agents === 0
      ? []
      : [
          ...(stage.estimate === undefined ? [tokensOf(stage)] : priced(stage)),
          ...agentGaps(stage),
        ];
  return [
    `  ${stage.stage.padEnd(width)}  ${counted}`,
    duration(stage.spanMs),
    ...agents,
    ...decisionCost(stage),
  ].join(" · ");
}

function tokensOf(figures: AccountingFigures): string {
  return figures.known === 0 ? "no usage known" : plural(total(figures), "token", count);
}

function priced(stage: Slice): string[] {
  return stage.estimate === undefined ? [] : [estimate(stage.estimate)];
}

function agentGaps(figures: AccountingFigures): string[] {
  return [...usageGap(figures), ...gaps(figures)];
}

function usageGap(figures: AccountingFigures): string[] {
  return figures.known < figures.agents && figures.known > 0
    ? [`usage known ${figures.known}/${figures.agents}`]
    : [];
}

/** A slice's decisions past their count: their estimate, apart from its agents', and gaps. */
function decisionCost(stage: Slice): string[] {
  const { decisions } = stage;
  if (!decisions) return [];
  const cost =
    decisions.estimate === undefined
      ? decisions.known === 0
        ? ["no usage known"]
        : []
      : [
          stage.agents === 0
            ? estimate(decisions.estimate)
            : `${estimate(decisions.estimate)} in decisions`,
        ];
  return [...cost, ...decisionGaps(decisions)];
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

/** How long ago, for a person: `just now`, `5m ago`, `3h ago`, `2d ago`. */
export function ago(ms: number): string {
  if (!Number.isFinite(ms)) return "at an unknown time";
  if (ms < 60_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
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
