import { defineWorkflow } from "agentswf/workflow";

export default defineWorkflow<null, { ran: boolean }>({
  meta: { name: "case-fixture-early", description: "A workflow env.ts imports statically." },
  run: async () => ({ ran: true }),
});
