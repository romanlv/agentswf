import { defineReviewScorer } from "../format/variant";
import judge from "../judge/match.workflow";

/** The package's own scorer, `match-first`, with its default voters. */
export default defineReviewScorer({ workflow: judge, argv: [], timeout: "40m" });
