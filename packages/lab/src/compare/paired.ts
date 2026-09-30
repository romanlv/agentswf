import { mean, normalCdf, obrienFleming, sd, tQuantile } from "./stats";
import {
  type CaseScore,
  type ComparedMetric,
  type Comparison,
  type ComparisonInput,
  defineComparison,
  type MetricSpec,
  type Verdict,
} from "./types";

/** Below this many paired cases no interval is given, only cases won, tied and lost. */
const FEWEST = 5;

/** Each case's value of one metric: the mean of its trials that have one. */
export function perCase(scores: readonly CaseScore[], metric: MetricSpec): Map<string, number> {
  const values = new Map<string, number[]>();
  for (const score of scores) {
    const value =
      score.outcome === "scored"
        ? score.metrics[metric.name]
        : score.outcome === "variant-failed" && metric.onVariantFailure !== "missing"
          ? metric.onVariantFailure
          : null;
    if (value === null || value === undefined) continue;
    values.set(score.case, [...(values.get(score.case) ?? []), value]);
  }
  return new Map([...values].map(([id, xs]) => [id, mean(xs)]));
}

/**
 * One metric compared over the cases both variants have: the challenger's difference, with a
 * paired t interval at `confidence`. `gain` is the difference turned so that above 0 is better.
 */
export function compareMetric(
  input: Pick<ComparisonInput, "baseline" | "challenger">,
  metric: MetricSpec,
  role: ComparedMetric["role"],
  confidence = 0.95,
): ComparedMetric & { gain: number[] } {
  const theirs = perCase(input.baseline, metric);
  const ours = perCase(input.challenger, metric);
  const paired = [...ours.keys()].filter((id) => theirs.has(id));
  const sign = metric.direction === "higher" ? 1 : -1;
  const differences = paired.map((id) => ours.get(id)! - theirs.get(id)!);
  const gain = differences.map((d) => sign * d);
  const compared: ComparedMetric & { gain: number[] } = {
    name: metric.name,
    role,
    cases: paired.length,
    baseline: paired.length ? mean(paired.map((id) => theirs.get(id)!)) : null,
    challenger: paired.length ? mean(paired.map((id) => ours.get(id)!)) : null,
    difference: paired.length ? mean(differences) : null,
    won: gain.filter((g) => g > 0).length,
    tied: gain.filter((g) => g === 0).length,
    lost: gain.filter((g) => g < 0).length,
    gain,
  };
  if (paired.length >= FEWEST) {
    const half =
      tQuantile(1 - (1 - confidence) / 2, paired.length - 1) *
      (sd(differences) / Math.sqrt(paired.length));
    compared.interval = [compared.difference! - half, compared.difference! + half];
  }
  return compared;
}

export type PairedOptions = {
  /** The metric that decides. */
  primary: string;
  /** Metrics that may not get worse by more than `margin`, shown with the interval. */
  guards?: readonly { metric: string; margin: number }[];
  /**
   * Metrics that decide, in order, when the primary shows no difference at the last look: only by
   * more than `margin`, shown with the interval, so two copies of one variant never differ by chance.
   */
  tiebreak?: readonly { metric: string; margin: number }[];
  /**
   * Case counts at which "better" may be claimed, against an O'Brien–Fleming bound. Looks past the
   * selection are dropped and the selection's size is always the last. "Worse" may stop any time.
   */
  looks?: readonly number[];
  /** Two-sided, for every interval; "better" is claimed one-sided at half of what it leaves. */
  confidence?: number;
  /** Cases that must differ on the primary before "better": a sign test's floor. */
  minDiffering?: number;
  version?: string;
};

const signed = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
const shown = (m: ComparedMetric) =>
  `${m.name} ${signed(m.difference ?? 0)}${m.interval ? ` [${signed(m.interval[0])}, ${signed(m.interval[1])}]` : ""}`;

/** The good-direction interval: above 0 is better for the challenger. */
function gainInterval(m: ComparedMetric, spec: MetricSpec): [number, number] | undefined {
  if (!m.interval) return undefined;
  const [low, high] = m.interval;
  return spec.direction === "higher" ? [low, high] : [-high, -low];
}

/**
 * The standard rule, for 5 to 40 costly cases with a few trials each: per-case means, paired;
 * "worse" as soon as the primary's interval is below 0 or a guard's is past its margin; "better"
 * only at a planned look, past the bound, with every guard shown within its margin; at the last
 * look, a tie goes to the tie-breakers. Never a weighted sum across metrics.
 */
export function pairedComparison(options: PairedOptions): Comparison {
  const confidence = options.confidence ?? 0.95;
  const minDiffering = options.minDiffering ?? 6;
  const guards = options.guards ?? [];
  const tiebreak = options.tiebreak ?? [];
  return defineComparison({
    version: options.version ?? "1.0.0",
    compare(input): Verdict {
      const specs = new Map(input.metrics.map((m) => [m.name, m]));
      const spec = (name: string) => {
        const found = specs.get(name);
        if (!found) {
          throw new Error(
            `the comparison names ${name}, which the scorer doesn't give; it gives ${[...specs.keys()].join(", ")}`,
          );
        }
        return found;
      };
      const primarySpec = spec(options.primary);
      const roles = new Map<string, ComparedMetric["role"]>([[options.primary, "primary"]]);
      for (const g of guards) roles.set(spec(g.metric).name, "guard");
      for (const t of tiebreak)
        if (!roles.has(spec(t.metric).name)) roles.set(t.metric, "tiebreak");
      const all = input.metrics.map((m) =>
        compareMetric(input, m, roles.get(m.name) ?? "reported", confidence),
      );
      const byName = new Map(all.map((m) => [m.name, m]));
      const metrics = all.map(({ gain: _, ...m }) => m);
      const primary = byName.get(options.primary)!;
      const n = primary.cases;
      const counts = `won ${primary.won}, tied ${primary.tied}, lost ${primary.lost}`;
      const verdict = (v: Verdict["verdict"], stop: boolean, reason: string): Verdict => ({
        verdict: v,
        stop,
        reason,
        metrics,
      });

      if (n < FEWEST) {
        return verdict("undecided", false, `${n} cases: too few for an interval; ${counts}`);
      }
      const primaryGain = gainInterval(primary, primarySpec)!;
      if (primaryGain[1] < 0) return verdict("worse", true, `looked worse: ${shown(primary)}`);
      const guardState = guards.map((g) => {
        const m = byName.get(g.metric)!;
        const gain = gainInterval(m, spec(g.metric));
        return {
          m,
          margin: g.margin,
          failed: gain !== undefined && gain[1] < -g.margin,
          within: gain !== undefined && gain[0] >= -g.margin,
        };
      });
      const failed = guardState.find((g) => g.failed);
      if (failed) {
        return verdict(
          "worse",
          true,
          `${failed.m.name} worse by more than ${failed.margin}: ${shown(failed.m)}`,
        );
      }
      const unproven = guardState.filter((g) => !g.within).map((g) => g.m.name);

      const looks = [
        ...new Set([...(options.looks ?? []).filter((l) => l < input.selected), input.selected]),
      ]
        .filter((l) => l >= FEWEST)
        .sort((a, b) => a - b);
      const look = looks.indexOf(n);
      const last = n >= input.selected;
      const next = looks.find((l) => l > n);
      if (look >= 0) {
        const c = obrienFleming(
          looks.map((l) => l / input.selected),
          (1 - confidence) / 2,
        );
        const nominal = 1 - normalCdf(c / Math.sqrt(n / input.selected));
        const critical = tQuantile(1 - nominal, n - 1);
        const gain = primary.gain;
        const spread = sd(gain) / Math.sqrt(n);
        const t =
          spread === 0 ? (mean(gain) > 0 ? Number.POSITIVE_INFINITY : 0) : mean(gain) / spread;
        if (t >= critical) {
          if (primary.won + primary.lost < minDiffering) {
            if (last) {
              return verdict(
                "undecided",
                true,
                `${shown(primary)}, but only ${primary.won + primary.lost} cases differ; ${minDiffering} needed`,
              );
            }
          } else if (unproven.length === 0) {
            return verdict(
              "better",
              true,
              `better at look ${look + 1} of ${looks.length}: ${shown(primary)}`,
            );
          } else if (last) {
            return verdict(
              "undecided",
              true,
              `${shown(primary)}, but not shown within margin: ${unproven.join(", ")}`,
            );
          }
        } else if (last) {
          for (const { metric, margin } of tiebreak) {
            const m = byName.get(metric)!;
            const gain = gainInterval(m, spec(metric));
            if (!gain || unproven.length > 0) continue;
            if (gain[0] > margin || gain[1] < -margin) {
              return verdict(
                gain[0] > margin ? "better" : "worse",
                true,
                `no difference shown on ${options.primary} (${shown(primary)}); decided by ${shown(m)}, past its margin of ${margin}`,
              );
            }
          }
          return verdict("tie", true, `no difference shown: ${shown(primary)}; ${counts}`);
        }
      }
      return verdict(
        "undecided",
        false,
        `${shown(primary)} at ${n} of ${input.selected} cases${next ? `; next look at ${next}` : ""}`,
      );
    },
  });
}
