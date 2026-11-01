// #region open
import {
  defineWorkflow,
  isAnswered,
  type OutputSchema,
} from "@agentswf/contract/workflow";
import Type from "typebox";

/** A merge request was opened or pushed to: the commit to review, against its base branch. */
const ChangesData = Type.Object(
  { mr: Type.Number(), base: Type.String(), head: Type.String() },
  { additionalProperties: false },
);
export type Change = Type.Static<typeof ChangesData>;
export const Changes: OutputSchema<Change> = ChangesData;

const ClosedData = Type.Object(
  { mr: Type.Number(), merged: Type.Boolean() },
  { additionalProperties: false },
);
export const Closed: OutputSchema<Type.Static<typeof ClosedData>> = ClosedData;

export const Review = Type.Object(
  { approved: Type.Boolean(), findings: Type.Array(Type.String()) },
  { additionalProperties: false },
);
export type ReviewValue = Type.Static<typeof Review>;

/** A commit hash, which also fits a stage's name. */
const COMMIT = /^[0-9a-f]{7,40}$/;

export default defineWorkflow({
  meta: {
    name: "review-on-event",
    description: "Review a merge request at each new head, until it closes.",
  },
  file: import.meta.path,
  events: { "mr.changes": Changes, "mr.closed": Closed },
  starts: ["mr.changes"],
  async run(wf) {
    const openReviewer = (n: number) =>
      wf.agents.open({
        key: n === 1 ? "reviewer" : `reviewer#${n}`,
        runtime: { alias: "codex", placement: "headless" },
        instructions: "Review merge requests. Read the code; change nothing.",
      });
    let opened = 1;
    let reviewer = await openReviewer(opened);
    let next: Change | null = null;

    for (;;) {
      const events = await wf.receive({
        label: reviewer.turn ? "reviewing" : "waiting for a push",
      });
      // #endregion open
      // #region take
      for (const e of events) {
        if (e.name === "mr.changes") {
          if (COMMIT.test(e.data.head)) next = e.data;
          else wf.log("not a commit hash", { head: e.data.head });
        }
        if (e.name === "mr.closed") {
          await reviewer.turn?.cancel();
          return { mr: e.data.mr, merged: e.data.merged };
        }
        if (reviewer.is<Change, ReviewValue>(e)) {
          const { outcome, meta } = e.data;
          if (next?.head === meta.head) next = null;
          if (!isAnswered(outcome)) {
            wf.log("review failed", {
              head: meta.head,
              reason: outcome.reason,
            });
            // A failed or timed-out turn closes its agent, so the next push gets a new one.
            if (outcome.kind === "failed" || outcome.kind === "timed-out") {
              reviewer = await openReviewer(++opened);
            }
            continue;
          }
          await wf.stage(
            `review-${meta.head}`,
            {
              result: Review,
              summary: (r) =>
                r.approved ? "approved" : `${r.findings.length} findings`,
            },
            async () => outcome.value, // post it to the merge request here, once per head
          );
        }
      }
      // #endregion take
      // #region start
      if (next && !reviewer.turn) {
        await reviewer.start({
          prompt:
            `Review merge request !${next.mr}: ` +
            `\`git diff ${next.base}...${next.head}\`. ` +
            "Fetch the commit if you don't have it.",
          schema: Review,
          meta: next,
        });
      }
    }
  },
});
// #endregion start
