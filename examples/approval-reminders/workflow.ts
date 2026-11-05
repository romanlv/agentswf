import { typed } from "agentswf/typebox";
import { type Duration, defineWorkflow, ParticipantReply } from "agentswf/workflow";
import Type from "typebox";

/**
 * A doc to approve, and how often to remind and when to give up, as durations: `"2d"` and `"14d"` in
 * earnest. The schema subset has no pattern, so a timer refuses one that isn't, where it is given.
 */
export const Submitted = typed(
  Type.Object({ doc: Type.String(), remindEvery: Type.String(), expiresIn: Type.String() }),
);

export const Reminder = typed(Type.Object({ text: Type.String() }));

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
  events: { "doc.submitted": Submitted, "approvals:reply": ParticipantReply },
  starts: ["doc.submitted"],
  async run(wf) {
    const submitted = wf.started;
    if (submitted?.name !== "doc.submitted") return wf.stop("started by hand: send doc.submitted");
    const { doc, remindEvery, expiresIn } = submitted.data;
    const approvals = await wf.participants.connect({ key: "approvals" });
    await wf.stage("ask", () => approvals.post(`Please approve ${doc}.`));
    const writer = await wf.agents.open({
      key: "writer",
      runtime: { harness: "codex", model: "gpt-6-luna", effort: "low", placement: "headless" },
    });
    const expiry = wf.timer("doc-expires", expiresIn as Duration);
    for (let round = 1; ; round++) {
      const next = await wf.race(
        `approval-${round}`,
        { reply: wf.signal("approvals:reply"), remind: remindEvery as Duration, expiry },
        { label: `awaiting approval of ${doc}, round ${round}` },
      );
      if (next.expiry) return { doc, ended: "expired", round, by: null };
      // A stand-in for reading an approval: a reply that starts "approved".
      if (next.reply && /^approved\b/i.test(next.reply.data.text.trim()))
        return { doc, ended: "approved", round, by: next.reply.data.author ?? null };
      if (next.remind)
        await wf.stage(`remind-${round}`, async () => {
          const drafted = await writer.run({
            prompt: `Write one short, polite sentence reminding the approver that ${doc} still awaits approval. This is reminder ${round}.`,
            schema: Reminder,
          });
          const text = drafted.outcome.answered ? drafted.outcome.value.text : `Reminder: ${doc}.`;
          await approvals.post(text);
        });
    }
  },
});
