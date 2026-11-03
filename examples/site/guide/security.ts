import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const TRIAGE = Type.Object(
  {
    label: Type.Union([
      Type.Literal("bug"),
      Type.Literal("feature"),
      Type.Literal("spam"),
    ]),
  },
  { additionalProperties: false },
);

export default defineWorkflow({
  meta: {
    name: "triage",
    description:
      "Label an issue anyone could have filed, from inside a sandbox.",
  },
  prepare: ({ argv }) => ({ issue: argv.join(" ") }),
  async run(wf, args) {
    // #region reader
    // The issue's text is anyone's. In a reader sandbox, whatever it talks the agent into, the
    // agent can write nothing, reach only its model, and see nothing else under your home.
    const triager = await wf.agents.open({
      key: "triager",
      runtime: "codex",
      sandbox: { srt: {} },
    });
    const { outcome } = await triager.run<Type.Static<typeof TRIAGE>>({
      prompt: `Label this issue against the code in this repository:\n\n${args.issue}`,
      schema: TRIAGE,
    });
    // #endregion reader
    if (!outcome.answered) return wf.stop(`triager: ${outcome.reason}`);
    return { label: outcome.value.label };
  },
});
