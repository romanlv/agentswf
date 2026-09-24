import type { AccountingFigures, RunAccounting } from "@wf/contract/records";

/** The run in one line, then a line per stage. Gaps are named, never shown as zero. */
export function describeAccounting(accounting: RunAccounting): string[] {
  const { totals } = accounting;
  const first = [
    plural(totals.agents, "agent"),
    duration(accounting.wallMs),
    totals.known === 0
      ? "no usage known"
      : `${plural(total(totals), "token", count)} (${count(totals.tokens.cacheRead)} cached)`,
    ...(totals.estimate === undefined
      ? []
      : [`${estimate(totals.estimate)} at ${accounting.basis}`]),
    ...(totals.charged === undefined ? [] : [`${usd(totals.charged)} charged`]),
    accounting.billing,
    ...(totals.billed < totals.agents ? [`billing known ${totals.billed}/${totals.agents}`] : []),
    `usage known ${totals.known}/${totals.agents}`,
    ...gaps(totals),
    ...(accounting.unpriced.length === 0 ? [] : [`unpriced: ${accounting.unpriced.join(", ")}`]),
  ];
  const width = Math.max(0, ...accounting.byStage.map(({ stage }) => stage.length));
  return [
    first.join(" · "),
    ...accounting.byStage.map((stage) =>
      [
        `  ${stage.stage.padEnd(width)}  ${plural(stage.agents, "agent")}`,
        duration(stage.spanMs),
        stage.estimate !== undefined
          ? estimate(stage.estimate)
          : stage.known === 0
            ? "no usage known"
            : plural(total(stage), "token", count),
        ...(stage.known < stage.agents ? [`usage known ${stage.known}/${stage.agents}`] : []),
        ...gaps(stage),
      ].join(" · "),
    ),
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

function duration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
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
