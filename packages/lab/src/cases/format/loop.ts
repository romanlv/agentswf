import Type from "typebox";

/**
 * A loop's records under `{store}/loops/{name}/`: `loop.json`, written once when it starts;
 * `tries/{n}/proposal.json`, the proposer's answer as soon as it is in, so a try cut short resumes
 * with its code; `tries/{n}/try.json`, written once when the try is decided; and `finals/{k}.json`,
 * each check of the kept code on the holdout. The code itself is `start/` and `tries/{n}/code/`.
 */

export const LOOP_KIND = "awf.case-loop/1";
export const TRY_KIND = "awf.case-try/1";
export const PROPOSAL_KIND = "awf.case-proposal/1";
export const FINAL_KIND = "awf.case-final/1";

const Text = Type.String({ minLength: 1 });
const Usd = Type.Number({ minimum: 0 });

/** What the proposer answers: the one change a try makes, and what the records must show. */
export const HypothesisSchema = Type.Object(
  {
    change: Type.String({ minLength: 1, description: "What changed, in a sentence." }),
    hypothesis: Type.String({ minLength: 1, description: "Why it should do better." }),
    predicted: Type.String({
      minLength: 1,
      description: "The effect expected on the comparison's numbers, and its cost.",
    }),
    mechanism: Type.String({
      minLength: 1,
      description: "What the trials must show if the hypothesis holds.",
    }),
  },
  { additionalProperties: false },
);
export type Hypothesis = Type.Static<typeof HypothesisSchema>;

export const ProposalSchema = Type.Object(
  {
    kind: Type.Literal(PROPOSAL_KIND),
    hypothesis: HypothesisSchema,
    /** The proposer's run, its estimate, as the try counts it. */
    spend: Usd,
    /** The incumbent's run on the tuning cases the proposer read, its estimate. */
    feedback: Usd,
    runId: Type.Optional(Text),
  },
  { additionalProperties: false },
);
export type Proposal = Type.Static<typeof ProposalSchema>;

export const LoopSchema = Type.Object(
  {
    kind: Type.Literal(LOOP_KIND),
    name: Text,
    dataset: Text,
    started: Text,
    /** The checkout the start was copied from, and its git state then. */
    from: Type.Object(
      {
        path: Text,
        commit: Type.Union([Text, Type.Null()]),
        dirty: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    /** The program's digest: a resumed loop steers as it started. */
    program: Text,
    proposer: Text,
    trials: Type.Integer({ minimum: 1 }),
    /** Its `--param`s, sorted: every try and the final check run under them. */
    params: Type.Array(Text),
    cap: Type.Object({ usd: Usd }, { additionalProperties: false }),
    /** The tuning cases in the seeded order every try runs them in. */
    tuning: Type.Array(Text),
    holdout: Type.Array(Text),
    /** The dataset's `compare`, its version: a loop's tries are judged alike. */
    comparison: Text,
  },
  { additionalProperties: false },
);
export type Loop = Type.Static<typeof LoopSchema>;

export const TrySchema = Type.Object(
  {
    kind: Type.Literal(TRY_KIND),
    n: Type.Integer({ minimum: 1 }),
    at: Text,
    /** The try it changed: 0, the start. */
    parent: Type.Integer({ minimum: 0 }),
    decision: Type.Union([
      Type.Literal("kept"),
      Type.Literal("discarded"),
      Type.Literal("refused"),
      Type.Literal("failed"),
    ]),
    why: Text,
    hypothesis: Type.Optional(HypothesisSchema),
    /** The files it changed against its parent. */
    changed: Type.Array(Text),
    /** The run that compared it with its parent. */
    runId: Type.Optional(Text),
    verdict: Type.Optional(Type.Union([Text, Type.Null()])),
    spend: Type.Object({ proposer: Usd, trials: Usd }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);
export type Try = Type.Static<typeof TrySchema>;

export const FinalSchema = Type.Object(
  {
    kind: Type.Literal(FINAL_KIND),
    k: Type.Integer({ minimum: 1 }),
    at: Text,
    /** The kept try checked against the start. */
    incumbent: Type.Integer({ minimum: 1 }),
    runId: Text,
    verdict: Type.Union([Text, Type.Null()]),
    why: Text,
    spend: Usd,
  },
  { additionalProperties: false },
);
export type Final = Type.Static<typeof FinalSchema>;
