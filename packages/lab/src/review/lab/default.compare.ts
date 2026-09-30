// The package's own comparison, `default`: story 011's decision 2. A workspace's
// `*.compare.ts` replaces it by `comparison` in awf-lab.json, or `--comparison`.
import { pairedComparison } from "../../compare";

export default pairedComparison({
  version: "1.1.0",
  primary: "recall.weighted",
  guards: [
    { metric: "wrong", margin: 0.05 },
    { metric: "precision", margin: 0.05 },
  ],
  // "Better" only at these case counts of the dataset's seeded order, and at its end.
  looks: [8, 16],
  // Stop at a look once a gain of 0.05 in weighted recall is out of reach: between equals nothing
  // else stops before the dataset's end (story 011, task 7).
  minGain: 0.05,
  // Cost and time decide only when weighted recall is shown within ±0.05, and only by more than a
  // margin worth having: $0.05 is about a sixth of a case's cost on the first dataset, 30 s a
  // quarter of its time. Time measured under --jobs is not comparable with time measured alone.
  equivalence: 0.05,
  tiebreak: [
    { metric: "cost", margin: 0.05 },
    { metric: "time", margin: 30 },
  ],
});
