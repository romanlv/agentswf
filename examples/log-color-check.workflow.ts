import { defineExecutableWorkflow } from "@agentswf/contract/workflow";

export default defineExecutableWorkflow<{ fail: boolean }, string>({
  definition: {
    meta: {
      name: "log-color-check",
      description: "Logs two lines, opens no agent.",
      whenToUse: "Never.",
    },
    async run(workflow, args) {
      workflow.log("an ordinary log line");
      workflow.log("another one");
      if (args.fail) throw new Error("failing on purpose");
      return "done";
    },
  },
  prepare: (invocation) => ({ fail: invocation.argv.includes("fail") }),
});
