import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const DONE = typed(
  Type.Object({ summary: Type.String() }, { additionalProperties: false }),
);
export const VERDICT = typed(
  Type.Object(
    { approved: Type.Boolean(), changes: Type.Array(Type.String()) },
    { additionalProperties: false },
  ),
);

export type Result =
  | { approved: true; rounds: number }
  | { approved: false; rounds: number; open: string[] };

// #region bound
const ROUNDS = 3;
const TURN = "20m";
// #endregion bound

export default defineWorkflow({
  meta: {
    name: "review-loop",
    description:
      "Implement a task, then revise it until a reviewer on another model approves.",
  },
  prepare: ({ argv }) => ({ task: argv.join(" ") }),
  async run(wf, { task }: { task: string }): Promise<Result> {
    let implementer = await wf.agents.open({
      key: "implementer",
      runtime: "claude",
    });
    const reviewer = await wf.agents.open({
      key: "reviewer",
      runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
    });
    let prompt = `Implement this task: ${task}`;
    let open: string[] = [];
    let replaced = false;
    for (let round = 1; round <= ROUNDS; round++) {
      // #region branch
      let work = await implementer.run({
        prompt,
        schema: DONE,
        timeout: TURN,
      });
      const closed =
        work.outcome.kind === "failed" || work.outcome.kind === "timed-out";
      const login =
        work.outcome.kind === "failed" && work.outcome.login !== undefined;
      if (closed && !login && !replaced) {
        // The agent is closed. Once, a new one under its own key takes over.
        replaced = true;
        implementer = await wf.agents.open({
          key: "implementer-2",
          runtime: "claude",
        });
        const handover = [
          `Take over from an agent that stopped. The task: ${task}`,
          "Its change so far is in the working tree.",
        ].join("\n");
        work = await implementer.run({
          prompt: round === 1 ? handover : `${handover}\n${prompt}`,
          schema: DONE,
          timeout: TURN,
        });
      }
      if (!work.outcome.answered) {
        return wf.stop(
          `implementer ${work.outcome.kind}: ${work.outcome.reason}`,
        );
      }
      // #endregion branch

      // #region feedback
      const review = await reviewer.run({
        prompt:
          round === 1
            ? `Review the change. Its author says: ${work.outcome.value.summary}`
            : `The author says it made your changes: ${work.outcome.value.summary}\n` +
              "Check each one, then the rest of the change.",
        schema: VERDICT,
        timeout: TURN,
      });
      if (!review.outcome.answered) {
        return wf.stop(
          `reviewer ${review.outcome.kind}: ${review.outcome.reason}`,
        );
      }
      if (review.outcome.value.approved)
        return { approved: true, rounds: round };
      open = review.outcome.value.changes;
      prompt = `Make these changes:\n${open.join("\n")}`;
      // #endregion feedback
    }
    return { approved: false, rounds: ROUNDS, open };
  },
});
