import { defineWorkflow } from "agentswf/workflow";

export default defineWorkflow<null, { located: boolean }>({
  meta: { name: "case-fixture-located", description: "A workflow that gives its own file." },
  file: import.meta.path,
  run: async () => ({ located: true }),
});
