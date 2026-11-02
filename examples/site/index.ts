import { defineWorkflow } from "@agentswf/contract/workflow";
import Type from "typebox";

export const DONE = Type.Object(
  { summary: Type.String() },
  { additionalProperties: false },
);
export const VERDICT = Type.Object(
  { approved: Type.Boolean(), changes: Type.Array(Type.String()) },
  { additionalProperties: false },
);
type Done = Type.Static<typeof DONE>;
type Verdict = Type.Static<typeof VERDICT>;

export default defineWorkflow({
  meta: {
    name: "review-loop",
    description:
      "Implement a task, then revise it until a reviewer on another model approves.",
  },
  prepare: ({ argv }) => ({ task: argv.join(" ") }),
  async run(wf, { task }: { task: string }) {
    // #region loop
    const implementer = await wf.agents.open({
      key: "implementer",
      runtime: "claude",
    });
    const reviewer = await wf.agents.open({
      key: "reviewer",
      runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
    });
    let prompt = `Implement this task: ${task}`;
    for (let round = 1; round <= 3; round++) {
      const work = await implementer.run<Done>({ prompt, schema: DONE });
      if (!work.outcome.answered)
        return wf.stop(`implementer: ${work.outcome.reason}`);
      const review = await reviewer.run<Verdict>({
        prompt: "Review the change.",
        schema: VERDICT,
      });
      if (!review.outcome.answered)
        return wf.stop(`reviewer: ${review.outcome.reason}`);
      if (review.outcome.value.approved)
        return { approved: true, rounds: round };
      prompt = `Make these changes:\n${review.outcome.value.changes.join("\n")}`;
    }
    return { approved: false, rounds: 3 };
    // #endregion loop
  },
});
