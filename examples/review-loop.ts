import { defineReviewWorkflow } from "./minimum-review";

const executable = defineReviewWorkflow({
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

export const reviewLoop = executable.definition;
export default executable;
