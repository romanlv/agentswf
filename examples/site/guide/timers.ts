import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const OPENED = typed(
  Type.Object({ pr: Type.Number() }, { additionalProperties: false }),
);
export const PUSHED = typed(
  Type.Object(
    { pr: Type.Number(), head: Type.String() },
    { additionalProperties: false },
  ),
);
export const CLOSED = typed(
  Type.Object({ pr: Type.Number() }, { additionalProperties: false }),
);

export default defineWorkflow({
  meta: {
    name: "stale-pr",
    description:
      "Reviews each push to a pull request, and asks after it once it sits three days.",
  },
  file: import.meta.path,
  events: { "pr.opened": OPENED, "pr.pushed": PUSHED, "pr.closed": CLOSED },
  starts: ["pr.opened"],
  async run(wf) {
    const opened = wf.started;
    if (opened?.name !== "pr.opened")
      return wf.stop("send pr.opened to start it");
    const { pr } = opened.data;
    const reviewer = await wf.agents.open({
      key: "reviewer",
      runtime: "claude",
    });
    await wf.stage("review-opened", async () => {
      await reviewer.run({ prompt: `Review pull request #${pr}.` });
    });

    // #region move
    let stale = wf.timer("stale-0", "3d");
    for (let round = 1; ; round++) {
      const next = await wf.race(
        `wait-${round}`,
        {
          pushed: wf.signal("pr.pushed"),
          closed: wf.signal("pr.closed"),
          stale,
        },
        { label: `#${pr}: waiting for a push, round ${round}` },
      );
      if (next.closed) return { pr, ended: "closed" };
      if (next.stale) {
        await wf.stage("ask-after", async () => {
          await reviewer.run({
            prompt: `#${pr} has had no push for three days. Ask its author, in a comment, whether it is still wanted.`,
          });
        });
        return { pr, ended: "stale" };
      }
      if (next.pushed) {
        await stale.cancel();
        stale = wf.timer(`stale-${round}`, "3d");
        const { head } = next.pushed.data;
        await wf.stage(`review-${head}`, async () => {
          await reviewer.run({ prompt: `Review #${pr} again, at ${head}.` });
        });
      }
    }
    // #endregion move
  },
});
