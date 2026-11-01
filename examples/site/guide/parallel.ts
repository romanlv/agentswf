import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const FINDINGS = Type.Object(
  {
    findings: Type.Array(
      Type.Object(
        {
          file: Type.String(),
          severity: Type.Union([Type.Literal("high"), Type.Literal("low")]),
          claim: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
type Findings = Type.Static<typeof FINDINGS>;

export const LENSES = ["security", "correctness", "tests"] as const;
type Review = { lens: string; findings: Findings["findings"]; failed?: string };

export const lensPrompt = (lens: string) =>
  `Review this branch's changes against main for ${lens} problems only. Don't edit files.`;

export default defineWorkflow({
  meta: {
    name: "lens-review",
    description:
      "Review the branch through three lenses at once and merge what they find.",
  },
  async run(wf) {
    // #region fan-out
    const reviews = await wf.parallel(
      LENSES,
      async (lens): Promise<Review> => {
        const reviewer = await wf.agents.open({
          key: `review:${lens}`,
          runtime: "codex",
        });
        const { outcome } = await reviewer.run<Findings>({
          prompt: lensPrompt(lens),
          schema: FINDINGS,
        });
        return isAnswered(outcome)
          ? { lens, findings: outcome.value.findings }
          : {
              lens,
              findings: [],
              failed: `${outcome.kind}: ${outcome.reason}`,
            };
      },
      { label: "lenses", concurrency: 2 },
    );
    // #endregion fan-out

    // #region fan-in
    const findings = reviews
      .flatMap(({ lens, findings }) =>
        findings.map((finding) => ({ lens, ...finding })),
      )
      .toSorted(
        (a, b) => Number(b.severity === "high") - Number(a.severity === "high"),
      );
    const failed = reviews.flatMap(({ lens, failed }) =>
      failed ? [{ lens, reason: failed }] : [],
    );
    return { findings, failed };
    // #endregion fan-in
  },
});

export const strictReview = defineWorkflow({
  meta: {
    name: "strict-lens-review",
    description:
      "Review through three lenses, and give up on all of them if one doesn't answer.",
  },
  async run(wf) {
    // #region strict
    return wf.parallel(LENSES, async (lens) => {
      const reviewer = await wf.agents.open({
        key: `review:${lens}`,
        runtime: "codex",
      });
      const { outcome } = await reviewer.run<Findings>({
        prompt: lensPrompt(lens),
        schema: FINDINGS,
      });
      if (!isAnswered(outcome)) throw new Error(`${lens}: ${outcome.kind}`);
      return outcome.value.findings;
    });
    // #endregion strict
  },
});
