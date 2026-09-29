import { defineReviewJudge } from "../format/variant";
import type judge from "../judge/judge.workflow";

/** The package's own judge, `panel`: the panel with its default models. */
export default defineReviewJudge<typeof judge>({
  workflow: new URL("../judge/judge.workflow.ts", import.meta.url),
  argv: [],
  timeout: "20m",
});
