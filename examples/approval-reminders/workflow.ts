import { type Duration, defineWorkflow } from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/**
 * A doc to approve, and how often to remind and when to give up, as durations: `"2d"` and `"14d"` in
 * earnest. The schema subset has no pattern, so a timer refuses one that isn't, where it is given.
 */
export const Submitted = outputSchema(
  Type.Object({ doc: Type.String(), remindEvery: Type.String(), expiresIn: Type.String() }),
);

export const Reminder = outputSchema(Type.Object({ text: Type.String() }));

/**
 * Story 037's first case: a doc waits for approval, with a reminder each `remindEvery` drafted by
 * an agent, until an approval comes or it expires. Each round is a race of the reply, its own
 * reminder timer, and the expiry every round shares.
 */
export default defineWorkflow({
  meta: {
    name: "approval",
    description: "Waits for a doc's approval, reminding, until it expires.",
  },
  file: import.meta.path,
  events: { "doc.submitted": Submitted },
  starts: ["doc.submitted"],
  async run(workflow) {
    const submitted = workflow.started;
    if (submitted?.name !== "doc.submitted")
      return workflow.stop("started by hand: send doc.submitted");
    const { doc, remindEvery, expiresIn } = submitted.data;
    const approvals = await workflow.participants.connect({ key: "approvals", to: "code" });
    await workflow.stage("ask", () => approvals.post(`Please approve ${doc}.`));
    const writer = await workflow.agents.open({
      key: "writer",
      runtime: { harness: "codex", model: "gpt-6-luna", effort: "low", placement: "headless" },
    });
    const expiry = workflow.timer("doc-expires", expiresIn as Duration);
    for (let round = 1; ; round++) {
      const next = await workflow.race(
        `approval-${round}`,
        { reply: approvals, remind: remindEvery as Duration, expiry },
        { label: `awaiting approval of ${doc}, round ${round}` },
      );
      if (next.expiry) return { doc, ended: "expired", round, by: null };
      // A stand-in for reading an approval: a reply that starts "approved".
      if (next.reply && /^approved\b/i.test(next.reply.text.trim()))
        return { doc, ended: "approved", round, by: next.reply.author ?? null };
      if (next.remind)
        await workflow.stage(`remind-${round}`, async () => {
          const drafted = await writer.run({
            prompt: `Write one short, polite sentence reminding the approver that ${doc} still awaits approval. This is reminder ${round}.`,
            schema: Reminder,
          });
          const text =
            drafted.outcome.kind === "answered" ? drafted.outcome.value.text : `Reminder: ${doc}.`;
          await approvals.post(text);
        });
    }
  },
});
