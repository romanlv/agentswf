import {
  defineWorkflow,
  type OutputSchema,
  ParticipantReply,
} from "agentswf/workflow";
import Type from "typebox";

const Pushed = Type.Object(
  { sha: Type.String(), branch: Type.String() },
  { additionalProperties: false },
);
export const PUSHED: OutputSchema<Type.Static<typeof Pushed>> = Pushed;
const Closed = Type.Object(
  { merged: Type.Boolean() },
  { additionalProperties: false },
);
export const CLOSED: OutputSchema<Type.Static<typeof Closed>> = Closed;
export const REVIEW = Type.Object(
  { summary: Type.String() },
  { additionalProperties: false },
);

// #region workflow
export default defineWorkflow({
  meta: {
    name: "pr-review",
    description: "Reviews a pull request at each push, until it closes.",
  },
  file: import.meta.path,
  events: {
    "pr.pushed": PUSHED,
    "pr.closed": CLOSED,
    "thread:reply": ParticipantReply,
  },
  starts: ["pr.pushed"],
  async run(wf) {
    const started = wf.started;
    if (started?.name !== "pr.pushed")
      return wf.stop("started by hand: send pr.pushed");
    const thread = await wf.participants.connect({ key: "thread" });
    const reviewer = await wf.agents.open({
      key: "reviewer",
      runtime: "claude",
    });
    const review = async (prompt: string) => {
      const { outcome } = await reviewer.run<Type.Static<typeof REVIEW>>({
        prompt,
        schema: REVIEW,
      });
      if (outcome.answered) await thread.post(outcome.value.summary);
    };
    // The first wait takes the push that started the run, then each event after it.
    for await (const next of wf.select(
      {
        pushed: wf.signal("pr.pushed"),
        closed: wf.signal("pr.closed"),
        reply: wf.signal("thread:reply"),
      },
      { label: `reviewing ${started.data.branch}` },
    )) {
      if (next.closed) return { merged: next.closed.data.merged };
      if (next.pushed)
        await review(`Review ${next.pushed.data.sha}: what must change?`);
      if (next.reply) await review(`The thread says: ${next.reply.data.text}`);
    }
    return { merged: false };
  },
});
// #endregion workflow
