// The package's own comparison, `default`: story 011's decision 2. A workspace's
// `*.compare.ts` replaces it by `comparison` in awf-lab.json, or `--comparison`.
import { pairedComparison } from "../../compare";

export default pairedComparison({
  primary: "recall.weighted",
  guards: [
    { metric: "wrong", margin: 0.05 },
    { metric: "precision", margin: 0.05 },
  ],
  // USD and seconds per case: two copies of the baseline differed by up to $0.05 and 8s on average
  // over 12 cases (story 011, experiment 1), so less than this is chance.
  tiebreak: [
    { metric: "cost", margin: 0.05 },
    { metric: "time", margin: 30 },
  ],
});
