import { defineReviewScorer } from "../format/variant";
import judge from "../judge/judge.workflow";

/** The package's own judge, `panel`: the panel with its default models. */
export default defineReviewScorer({ workflow: judge, argv: [], timeout: "20m" });
