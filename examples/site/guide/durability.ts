import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const PLAN = Type.Object(
  { branch: Type.String(), steps: Type.Array(Type.String()) },
  { additionalProperties: false },
);
export const BUILT = Type.Object(
  { commit: Type.String() },
  { additionalProperties: false },
);
export const VERDICT = Type.Object(
  { approved: Type.Boolean(), findings: Type.Array(Type.String()) },
  { additionalProperties: false },
);

// #region flow
export default defineWorkflow({
  meta: {
    name: "fix-issue",
    description: "Plan, build and review a fix.",
    version: "1.0.0",
  },
  async run(wf, args: { issue: string }) {
    const plan = await wf.stage("plan", { result: PLAN }, async () => {
      const planner = await wf.agents.open({
        key: "planner",
        runtime: "claude",
      });
      const { outcome } = await planner.run<Type.Static<typeof PLAN>>({
        prompt: `Plan a fix for ${args.issue}. Name the branch you will work on.`,
        schema: PLAN,
      });
      if (!isAnswered(outcome)) return wf.stop(`no plan: ${outcome.reason}`);
      return outcome.value;
    });

    const built = await wf.stage("implement", { result: BUILT }, async () => {
      const builder = await wf.agents.open({
        key: "builder",
        runtime: "claude",
      });
      const { outcome } = await builder.run<Type.Static<typeof BUILT>>({
        prompt: [
          `On ${plan.branch}, carry out:`,
          ...plan.steps,
          "Commit, and give the commit.",
        ].join("\n"),
        schema: BUILT,
      });
      if (!isAnswered(outcome)) return wf.stop(`not built: ${outcome.reason}`);
      return outcome.value;
    });

    return wf.stage("review", { result: VERDICT }, async () => {
      const reviewer = await wf.agents.open({
        key: "reviewer",
        runtime: "codex",
      });
      // A continue's agents are new: the prompt names everything the reviewer needs.
      const { outcome } = await reviewer.run<Type.Static<typeof VERDICT>>({
        prompt: `Review commit ${built.commit} on ${plan.branch} as a fix for ${args.issue}.`,
        schema: VERDICT,
      });
      if (!isAnswered(outcome)) return wf.stop(`no review: ${outcome.reason}`);
      return outcome.value;
    });
  },
  prepare: ({ argv }) => ({ issue: argv.join(" ") }),
});
// #endregion flow
