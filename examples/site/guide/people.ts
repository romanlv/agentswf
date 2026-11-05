import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const FINDINGS = typed(
  Type.Object(
    { cause: Type.String(), incidents: Type.Array(Type.String()) },
    { additionalProperties: false },
  ),
);

export default defineWorkflow({
  meta: {
    name: "investigate",
    description:
      "An investigator reports to a coordinator outside the run, and asks it.",
  },
  async run(wf) {
    // #region connect
    // Headless codex can wait for an answer; see Messaging for where a wait works.
    const investigator = await wf.agents.open({
      key: "investigator",
      runtime: { alias: "codex", placement: "headless" },
    });
    const coordinator = await wf.participants.connect({
      key: "coordinator",
      labels: { channel: "#incidents" },
    });
    await wf.messages.allow({
      between: [investigator, coordinator],
      purpose:
        "Report findings that hold up; ask when the logs can't settle it.",
      timeout: "2h",
    });
    // #endregion connect

    const { outcome } = await investigator.run({
      prompt:
        "checkout-api returns 5xx since 09:12. Find the cause in the logs under logs/.",
      schema: FINDINGS,
    });
    if (!outcome.answered) return wf.stop(`investigator: ${outcome.reason}`);
    return outcome.value;
  },
});
