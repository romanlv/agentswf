import { defineWorkflow, isAnswered, type OutputSchema } from "@agentswf/contract/workflow";

export type Change = { mr: number; base: string; head: string };

/** A merge request was opened or pushed to: the commit to review, against its base branch. */
export const Changes: OutputSchema<Change> = {
  type: "object",
  properties: { mr: { type: "number" }, base: { type: "string" }, head: { type: "string" } },
  required: ["mr", "base", "head"],
  additionalProperties: false,
};
export const Closed: OutputSchema<{ mr: number; merged: boolean }> = {
  type: "object",
  properties: { mr: { type: "number" }, merged: { type: "boolean" } },
  required: ["mr", "merged"],
  additionalProperties: false,
};

export type ReviewValue = { approved: boolean; findings: string[] };
export const Review: OutputSchema<ReviewValue> = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["approved", "findings"],
  additionalProperties: false,
};

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
      for (const e of events) {
        if (e.name === "mr.changes") next = e.data;
        if (e.name === "mr.closed") {
          await reviewer.turn?.cancel();
          return { mr: e.data.mr, merged: e.data.merged };
        }
        if (reviewer.is<Change, ReviewValue>(e)) {
          const { outcome, meta } = e.data;
          if (next?.head === meta.head) next = null;
          if (!isAnswered(outcome)) {
            wf.log("review failed", { head: meta.head, reason: outcome.reason });
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
              summary: (r) => (r.approved ? "approved" : `${r.findings.length} findings`),
            },
            async () => outcome.value, // post it to the merge request here, once per head
          );
        }
      }
      if (next && !reviewer.turn) {
        await reviewer.start({
          prompt: `Review merge request !${next.mr}: \`git diff ${next.base}...${next.head}\`. Fetch the commit if you don't have it.`,
          schema: Review,
          meta: next,
        });
      }
    }
  },
});
