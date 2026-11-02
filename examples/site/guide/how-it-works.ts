import { defineWorkflow } from "@agentswf/contract/workflow";
import Type from "typebox";

export const VERDICT = Type.Object(
  { verdict: Type.Union([Type.Literal("approve"), Type.Literal("revise")]) },
  { additionalProperties: false },
);

export default defineWorkflow({
  meta: {
    name: "check-readme",
    description: "Ask one agent whether the README is accurate.",
  },
  async run(wf) {
    return wf.stage("review", { result: VERDICT }, async () => {
      const reviewer = await wf.agents.open({
        key: "reviewer",
        runtime: "claude",
      });
      const { outcome } = await reviewer.run<Type.Static<typeof VERDICT>>({
        prompt:
          "Read README.md and check every command it shows against the code.",
        schema: VERDICT,
      });
      if (!outcome.answered)
        return wf.stop(`${outcome.kind}: ${outcome.reason}`);
      return outcome.value;
    });
  },
});
