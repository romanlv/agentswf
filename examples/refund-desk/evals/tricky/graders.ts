import { better } from "@agentswf/lab/cases";

// Better is more cases decided right, paired by case; cost may not rise by more than a cent a
// trial.
export const compare = better.paired({
  version: "1.0.0",
  primary: "passed",
  guards: [{ metric: "cost", margin: 0.01 }],
});
