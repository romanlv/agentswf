import { defineReviewScorer } from "../format/variant";
import judge from "../judge/judge.workflow";

/** The package's own judge, `panel`: the panel with its default models. */
export default defineReviewScorer({
  workflow: judge,
  file: new URL("../judge/judge.workflow.ts", import.meta.url),
  argv: [],
  timeout: "20m",
});
