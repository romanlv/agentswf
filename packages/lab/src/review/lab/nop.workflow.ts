// The sanity bound below every reviewer (story 008): it finds nothing, and must score zero.
import { defineExecutableWorkflow } from "@agentswf/contract/workflow";
import type { ReviewFinding } from "../format/scoring";

const executable = defineExecutableWorkflow<Record<string, never>, ReviewFinding[]>({
  definition: {
    meta: { name: "review-nop", description: "Find nothing: the zero sanity bound." },
    run: async () => [],
  },
  prepare: () => ({}),
});

export default executable;
