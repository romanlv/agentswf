import { defineWorkflow } from "agentswf/workflow";

/** A workflow whose folder holds the dataset's: its source walk must pass over env.ts and the rest. */
export default defineWorkflow({
  meta: { name: "rooted", description: "One stage, its folder above the dataset's." },
  run: async (wf) => {
    await wf.stage("gather", async () => undefined);
    return { n: 1 };
  },
});
