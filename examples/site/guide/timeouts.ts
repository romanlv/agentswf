// #region file
import {
  DeadlineExceededError,
  defineWorkflow,
  type TurnOutcome,
} from "agentswf/workflow";
import Type from "typebox";

export const FINDINGS = Type.Object(
  { findings: Type.Array(Type.String()) },
  { additionalProperties: false },
);
export type Findings = Type.Static<typeof FINDINGS>;

const MINUTE = 60_000;
export const LENSES = ["correctness", "tests"] as const;

export default defineWorkflow({
  meta: {
    name: "timed-review",
    description:
      "Two reviews, one after the other, within a budget in minutes; 20 by default.",
  },
  prepare: ({ argv }) => ({ minutes: Number(argv[0] ?? 20) }),

  async run(wf, { minutes }) {
    let reviews: TurnOutcome<Findings>[];
    try {
      // #region parallel
      reviews = await wf.parallel(
        LENSES,
        async (lens) => {
          const reviewer = await wf.agents.open({
            key: `review:${lens}`,
            runtime: "claude",
          });
          // #region turn
          const { outcome } = await reviewer.run<Findings>({
            prompt: `Review the diff on this branch against main, for ${lens} only.`,
            schema: FINDINGS,
            timeoutMs: 10 * MINUTE,
            nudge: {
              prompt:
                "Send the findings you have so far, even if the review isn't done.",
            },
          });
          // #endregion turn
          return outcome;
        },
        {
          label: "review",
          concurrency: 1,
          deadline: { unixMilliseconds: Date.now() + minutes * MINUTE },
        },
      );
      // #endregion parallel
    } catch (error) {
      // #region over
      if (error instanceof DeadlineExceededError) {
        return wf.stop(`the reviews took over ${minutes} minutes`);
      }
      throw error;
      // #endregion over
    }
    // #region stop
    const answered = reviews.filter((o) => o.answered);
    if (answered.length === 0) {
      return wf.stop(
        `no review answered: ${reviews.map((o) => o.kind).join(", ")}`,
      );
    }
    return { findings: answered.flatMap((o) => o.value.findings) };
    // #endregion stop
  },
});
// #endregion file
