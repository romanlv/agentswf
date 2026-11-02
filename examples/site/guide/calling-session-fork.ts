import { defineWorkflow } from "@agentswf/contract/workflow";

// #region fork
export default defineWorkflow<null, string>({
  meta: {
    name: "describe-change",
    description:
      "A copy of the session that ran awf writes the pull request description.",
  },
  async run(wf) {
    const writer = await wf.agents.forkCaller({ key: "writer" });
    if (!writer)
      return wf.stop("no session to fork; the run's output says why");
    const { outcome } = await writer.run({
      prompt:
        "Write the pull request description for the change you just made. Run no commands.",
    });
    if (!outcome.answered) return wf.stop(`no description: ${outcome.reason}`);
    return outcome.value;
  },
  present: (description) => description,
});
// #endregion fork
