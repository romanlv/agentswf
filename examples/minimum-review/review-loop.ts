import { defineReviewWorkflow } from "./workflow";

export const reviewLoop = defineReviewWorkflow({
  name: "review-loop",
  description:
    "Review one working-tree target through independent correctness and maintainability lenses.",
  whenToUse: "Use for a bounded, read-only multi-agent review of local code.",
  reviewers: {
    correctness: {
      alias: "claude",
      model: "sonnet",
    },
    maintainability: {
      alias: "codex",
      model: "gpt-5.6-sol",
    },
  },
});

export default reviewLoop;
