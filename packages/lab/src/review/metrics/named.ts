import type { MetricSpec } from "../../compare";
import type { RunSummary } from "../format/scoring";
import type { Metrics } from "./metrics";

/**
 * A review's numbers by name, as a comparison file names them. `cost` and `time` are the trial's,
 * so a comparison can prefer the cheaper of two variants that find as much.
 */
export const REVIEW_METRICS: readonly MetricSpec[] = [
  { name: "recall.weighted", direction: "higher", onVariantFailure: 0 },
  { name: "recall.must-fix", direction: "higher", onVariantFailure: 0 },
  { name: "recall.should-fix", direction: "higher", onVariantFailure: 0 },
  { name: "recall.could-fix", direction: "higher", onVariantFailure: 0 },
  { name: "precision", direction: "higher", onVariantFailure: "missing" },
  { name: "wrong", direction: "lower", onVariantFailure: "missing" },
  { name: "noise", direction: "lower", onVariantFailure: "missing" },
  { name: "cost", direction: "lower", onVariantFailure: "missing" },
  { name: "time", direction: "lower", onVariantFailure: "missing" },
];

/** One trial's review numbers: `null` where one doesn't apply, as recall with no issue of a kind. */
export function namedMetrics(
  m: Metrics,
  run: RunSummary | undefined,
): Record<string, number | null> {
  return {
    "recall.weighted": m.weightedRecall,
    "recall.must-fix": m.recall["must-fix"],
    "recall.should-fix": m.recall["should-fix"],
    "recall.could-fix": m.recall["could-fix"],
    precision: m.precision,
    wrong: m.wrong,
    noise: m.noise,
    // A cost with an unpriced agent in it is too low, so it is left out rather than compared.
    cost: run?.complete && run.estimate !== undefined ? run.estimate : null,
    time: run ? run.ms / 1000 : null,
  };
}
