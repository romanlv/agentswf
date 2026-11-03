import { defineReviewWorkflow } from "./workflow";

export const reviewLoop = defineReviewWorkflow({
  name: "review-loop",
  description:
    "Review one working-tree target through independent correctness and maintainability lenses.",
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
