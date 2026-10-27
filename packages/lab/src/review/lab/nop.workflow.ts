// The sanity bound below every reviewer (story 008): it finds nothing, and must score zero.
import { defineWorkflow } from "@agentswf/contract/workflow";
import type { ReviewFinding } from "../format/scoring";

export default defineWorkflow<Record<string, never>, ReviewFinding[]>({
  meta: { name: "review-nop", description: "Find nothing: the zero sanity bound." },
  run: async () => [],
  prepare: () => ({}),
});
