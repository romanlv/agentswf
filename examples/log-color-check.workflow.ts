import { defineWorkflow } from "agentswf/workflow";

export default defineWorkflow<{ fail: boolean }, string>({
  meta: {
    name: "log-color-check",
    description: "Logs two lines, opens no agent.",
  },
  async run(wf, args) {
    wf.log("an ordinary log line");
    wf.log("another one");
    if (args.fail) throw new Error("failing on purpose");
    return "done";
  },
  prepare: (invocation) => ({ fail: invocation.argv.includes("fail") }),
});
