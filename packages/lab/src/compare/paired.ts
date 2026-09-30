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

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Below this many paired cases no interval is given, only cases won, tied and lost. */
const FEWEST = 5;
/** A per-case difference this small is rounding, not a difference: trials summed in another order. */
const TOLERANCE = 1e-9;

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
    if (!Number.isFinite(value)) {
      throw new Error(`${metric.name} is ${value} on ${score.case}, trial ${score.trial}`);
    }
    values.set(score.case, [...(values.get(score.case) ?? []), value]);
  }
  return new Map([...values].map(([id, xs]) => [id, mean(xs)]));
}

/** Per-case differences, challenger minus baseline, over the cases both have, rounding taken out. */
function differencesOf(
  input: Pick<ComparisonInput, "baseline" | "challenger">,
  metric: MetricSpec,
) {
  const theirs = perCase(input.baseline, metric);
  const ours = perCase(input.challenger, metric);
  const paired = [...ours.keys()].filter((id) => theirs.has(id));
  const differences = paired.map((id) => {
    const d = ours.get(id)! - theirs.get(id)!;
    return Math.abs(d) <= TOLERANCE ? 0 : d;
  });
  return { theirs, ours, paired, differences };
}

/**
 * One metric compared over the cases both variants have: the challenger's mean difference, with a
 * paired t interval at `confidence`, and the cases each way.
 */
export function compareMetric(
  input: Pick<ComparisonInput, "baseline" | "challenger">,
  metric: MetricSpec,
  role: ComparedMetric["role"] = "reported",
  confidence = 0.95,
): ComparedMetric {
  const { theirs, ours, paired, differences } = differencesOf(input, metric);
  const sign = metric.direction === "higher" ? 1 : -1;
  const compared: ComparedMetric = {
    name: metric.name,
    role,
    cases: paired.length,
    baseline: paired.length ? mean(paired.map((id) => theirs.get(id)!)) : null,
    challenger: paired.length ? mean(paired.map((id) => ours.get(id)!)) : null,
    difference: paired.length ? mean(differences) : null,
    won: differences.filter((d) => sign * d > 0).length,
    tied: differences.filter((d) => d === 0).length,
    lost: differences.filter((d) => sign * d < 0).length,
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
   * Metrics that decide, in order, at the last look: each only by more than its `margin`, shown
   * with the interval, so two copies of one variant never differ by chance. Better also needs the
   * primary shown no worse than −`equivalence` and every guard within its margin; worse needs the
   * primary shown no better than +`equivalence`. The next is tried only when this one is shown
   * equal within its margin.
   */
  tiebreak?: readonly { metric: string; margin: number }[];
  /**
   * How close to 0 the primary's interval must lie for the tie-breakers to decide. Set, it is also
   * what a tie means: at the plan's end, a primary neither better nor within it is `undecided`.
   */
  equivalence?: number;
  /**
   * Case counts at which "better" may be claimed, against an O'Brien–Fleming bound; the plan's
   * size is always the last. A look counts cases both variants have finished, so a run evaluates
   * at exactly these counts. "Worse" may stop at any count from 5.
   */
  looks?: readonly number[];
  /** Two-sided, for every interval; "better" is claimed one-sided at half of what it leaves. */
  confidence?: number;
  /** Cases that must differ on the primary, either way, before "better". */
  minDiffering?: number;
  /** In semver; bump it whenever the settings change, as the report names it beside each verdict. */
  version: string;
};

/** A number as a person reads it: two significant figures below 1, and no sign on 0. */
function figure(x: number): string {
  const size = Math.abs(x);
  if (size === 0) return "0";
  const text =
    size >= 100
      ? size.toFixed(0)
      : size >= 10
        ? size.toFixed(1)
        : size >= 1
          ? size.toFixed(2)
          : size.toPrecision(2);
  return `${x > 0 ? "+" : "−"}${text}`;
}

const shown = (m: ComparedMetric) =>
  `${m.name} ${figure(m.difference ?? 0)}${m.interval ? ` [${figure(m.interval[0])}, ${figure(m.interval[1])}]` : ""}`;

/** The interval turned so that above 0 is better for the challenger. */
function gainInterval(m: ComparedMetric, spec: MetricSpec): [number, number] | undefined {
  if (!m.interval) return undefined;
  const [low, high] = m.interval;
  return spec.direction === "higher" ? [low, high] : [-high, -low];
}

/**
 * The standard rule, for 5 to 40 costly cases with a few trials each: per-case means, paired;
 * "worse" as soon as the primary's interval is below 0 or a guard's is past its margin; "better"
 * only at a planned look, past the bound, with every guard shown within its margin; at the last
 * look, the tie-breakers, then a tie if the primary is shown equivalent. Never a weighted sum
 * across metrics.
 */
export function pairedComparison(options: PairedOptions): Comparison {
  const confidence = options.confidence ?? 0.95;
  if (!(confidence >= 0.8 && confidence < 1)) throw new Error("confidence is from 0.8 to below 1");
  const minDiffering = options.minDiffering ?? 6;
  const guards = options.guards ?? [];
  const tiebreak = options.tiebreak ?? [];
  if (tiebreak.length > 0 && options.equivalence === undefined) {
    throw new Error("tie-breakers need an equivalence: how close to 0 the primary must be shown");
  }
  const equivalence = options.equivalence;
  if (!SEMVER.test(options.version)) {
    throw new Error(`version ${options.version} is not {major}.{minor}.{patch}`);
  }
  const whole = (x: number | undefined, least: number) =>
    x === undefined || (Number.isInteger(x) && x >= least);
  if (!(options.looks ?? []).every((l) => whole(l, 1))) {
    throw new Error(`looks are case counts, whole numbers from 1: ${options.looks}`);
  }
  if (!whole(options.minDiffering, 0)) {
    throw new Error(`minDiffering is a count of cases: ${options.minDiffering}`);
  }
  for (const { metric, margin } of [
    ...guards,
    ...tiebreak,
    ...(equivalence === undefined ? [] : [{ metric: "equivalence", margin: equivalence }]),
  ]) {
    if (!(margin >= 0)) throw new Error(`${metric}'s margin is ${margin}; a margin is 0 or more`);
  }
  return defineComparison({
    version: options.version,
    compare(input): Verdict {
      if (!(Number.isInteger(input.planned) && input.planned >= 1)) {
        throw new Error(`planned is a count of cases, from 1: ${input.planned}`);
      }
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
      for (const g of guards) {
        if (!roles.has(spec(g.metric).name)) roles.set(g.metric, "guard");
      }
      for (const t of tiebreak) {
        if (!roles.has(spec(t.metric).name)) roles.set(t.metric, "tiebreak");
      }
      const metrics = input.metrics.map((m) =>
        compareMetric(input, m, roles.get(m.name) ?? "reported", confidence),
      );
      const byName = new Map(metrics.map((m) => [m.name, m]));
      const primary = byName.get(options.primary)!;
      const n = primary.cases;
      const counts = `won ${primary.won}, tied ${primary.tied}, lost ${primary.lost}`;
      const verdict = (v: Verdict["verdict"], stop: boolean, reason: string): Verdict => ({
        verdict: v,
        stop,
        reason,
        metrics,
      });

      // Progress is the cases both variants have finished, whatever the primary's value on them.
      const finished = (scores: readonly CaseScore[]) =>
        new Set(scores.filter((s) => s.outcome !== "missing").map((s) => s.case));
      const theirs = finished(input.baseline);
      const done = [...finished(input.challenger)].filter((id) => theirs.has(id)).length;
      const last = done >= input.planned;
      const looks = [
        ...new Set([...(options.looks ?? []).filter((l) => l < input.planned), input.planned]),
      ].sort((a, b) => a - b);
      const look = last ? looks.length - 1 : looks.indexOf(done);
      const next = looks.find((l) => l > done);
      const pending = `at ${done} of ${input.planned} cases${next ? `, next look at ${next}` : ""}`;

      if (n < FEWEST) {
        const few = `${n} ${n === 1 ? "case" : "cases"} with ${options.primary}: too few for an interval; ${counts}`;
        return last
          ? verdict("undecided", true, few)
          : verdict("undecided", false, `${few}; ${pending}`);
      }
      const primaryGain = gainInterval(primary, primarySpec)!;
      if (primaryGain[1] < 0) {
        return verdict("worse", true, `stopped, looked worse: ${shown(primary)}`);
      }
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
          `stopped, ${failed.m.name} worse by more than ${failed.margin}: ${shown(failed.m)}`,
        );
      }
      const unproven = guardState
        .filter((g) => !g.within)
        .map((g) => (g.m.cases < FEWEST ? `${g.m.name} (${g.m.cases} cases)` : g.m.name));
      if (look < 0) return verdict("undecided", false, `${shown(primary)} ${pending}`);

      const c = obrienFleming(
        looks.map((l) => l / input.planned),
        (1 - confidence) / 2,
      );
      const critical = tQuantile(
        normalCdf(c / Math.sqrt(Math.min(1, done / input.planned))),
        n - 1,
      );
      const gains = differencesOf(input, primarySpec).differences.map((d) =>
        primarySpec.direction === "higher" ? d : -d,
      );
      const spread = sd(gains) / Math.sqrt(n);
      const t =
        spread === 0 ? (mean(gains) > 0 ? Number.POSITIVE_INFINITY : 0) : mean(gains) / spread;
      const at = `look ${look + 1} of ${looks.length}`;
      const past = t >= critical;
      const blocked = !past
        ? undefined
        : primary.won + primary.lost < minDiffering
          ? `only ${primary.won + primary.lost} cases differ, ${minDiffering} needed`
          : unproven.length > 0
            ? `not shown within margin: ${unproven.join(", ")}`
            : undefined;
      if (past && !blocked) return verdict("better", true, `better at ${at}: ${shown(primary)}`);
      if (!last) {
        const why = past ? `past the bound, but ${blocked}` : `not past the bound at ${at}`;
        return verdict("undecided", false, `${shown(primary)} ${why}; ${pending}`);
      }

      // The plan has run. The tie-breakers go in order, each one-sided on the primary: a better
      // needs it shown no worse than −equivalence, a worse no better than +equivalence, so a
      // challenger that improves never loses its verdict. The next is tried only when this one is
      // shown equal within its margin.
      const notes: string[] = [];
      if (equivalence !== undefined) {
        for (const { metric, margin } of tiebreak) {
          const m = byName.get(metric)!;
          const gain = gainInterval(m, spec(metric));
          if (!gain) {
            notes.push(`${metric} has ${m.cases} cases, too few to decide`);
            break;
          }
          const decided = `decided by ${shown(m)}, past its margin of ${margin}, with ${shown(primary)}`;
          if (gain[0] > margin && primaryGain[0] >= -equivalence) {
            if (unproven.length === 0) return verdict("better", true, decided);
            return verdict(
              "undecided",
              true,
              `${decided}, but not shown within margin: ${unproven.join(", ")}`,
            );
          }
          if (gain[1] < -margin && primaryGain[1] <= equivalence) {
            return verdict("worse", true, decided);
          }
          if (gain[0] < -margin || gain[1] > margin) {
            notes.push(
              `${metric} ${gain[0] > margin || gain[1] < -margin ? "differs" : "not shown within its margin"}: ${shown(m)}`,
            );
            break;
          }
        }
      }
      const why = notes.length > 0 ? `; ${notes.join("; ")}` : "";
      if (past)
        return verdict("undecided", true, `${shown(primary)} past the bound, but ${blocked}`);
      const equivalent =
        equivalence !== undefined &&
        primaryGain[0] >= -equivalence &&
        primaryGain[1] <= equivalence;
      if (equivalent) {
        return verdict("tie", true, `within ±${equivalence}: ${shown(primary)}; ${counts}${why}`);
      }
      if (primaryGain[0] > 0) {
        return verdict(
          "undecided",
          true,
          `${shown(primary)}: a gain, but not past the bound that planned looks require`,
        );
      }
      if (equivalence !== undefined) {
        return verdict(
          "undecided",
          true,
          `no difference shown, nor one within ±${equivalence}: ${shown(primary)}; ${counts}${why}`,
        );
      }
      return verdict("tie", true, `no difference shown: ${shown(primary)}; ${counts}`);
    },
  });
}
