import Type from "typebox";

/**
 * A loop's records under `{results}/{dataset}/loops/{name}/`: `loop.json`, written once when it
 * starts, and `tries/{n}/try.json`, one a try, written once when it is decided. The tree is read
 * back from each try's parent. `tries/{n}/proposal.json` keeps the proposer's answer as soon as it
 * is in, so a try cut short resumes with its candidate and the trials it already has.
 */

export const LOOP_FORMAT = "awf.lab-loop/1";
export const TRY_FORMAT = "awf.lab-try/1";
export const FINAL_FORMAT = "awf.lab-final/1";
export const PROPOSAL_FORMAT = "awf.lab-proposal/1";

const Text = Type.String({ minLength: 1 });
const Digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const Usd = Type.Number({ minimum: 0 });

/** What the proposer answers: the one change a try makes, and what the records must show. */
export const HypothesisSchema = Type.Object(
  {
    change: Type.String({ minLength: 1, description: "What changed, in a sentence." }),
    hypothesis: Type.String({ minLength: 1, description: "Why it should find more." }),
    predicted: Type.String({
      minLength: 1,
      description: "The effect expected, e.g. +0.10 weighted recall at 1.5× cost.",
    }),
    mechanism: Type.String({
      minLength: 1,
      description: "What the records must show if the hypothesis holds.",
    }),
  },
  { additionalProperties: false },
);

export type Hypothesis = Type.Static<typeof HypothesisSchema>;

export const ProposalSchema = Type.Object(
  {
    format: Type.Literal(PROPOSAL_FORMAT),
    hypothesis: HypothesisSchema,
    spend: Type.Number({ minimum: 0, description: "The proposer's run, as the try counts it." }),
  },
  { additionalProperties: false },
);

export type Proposal = Type.Static<typeof ProposalSchema>;

export const LoopSchema = Type.Object(
  {
    format: Type.Literal(LOOP_FORMAT),
    name: Text,
    dataset: Text,
    started: Text,
    start: Type.Object(
      {
        variant: Type.String({ minLength: 1, description: "The first incumbent, {name}@{M.m}." }),
        source: Type.String({
          minLength: 1,
          description: "Its workflow's file, copied as start.ts.",
        }),
        digest: Type.String({
          pattern: "^sha256:[0-9a-f]{64}$",
          description:
            "Of that file: the start's trials run it, so it may not change under a loop.",
        }),
      },
      { additionalProperties: false },
    ),
    scorer: Type.String({ minLength: 1, description: "{name}@{M.m}" }),
    comparison: Type.Object({ name: Text, version: Text }, { additionalProperties: false }),
    trials: Type.Integer({ minimum: 1 }),
    cap: Type.Object({ usd: Usd }, { additionalProperties: false }),
    proposer: Type.String({ minLength: 1, description: "{harness}/{model}" }),
    program: Digest,
    holdout: Type.Array(Text, { description: "The cases held out when the loop started." }),
  },
  { additionalProperties: false },
);

export type Loop = Type.Static<typeof LoopSchema>;

export const DECISIONS = ["kept", "discarded", "refused", "failed", "unfinished"] as const;

export const TrySchema = Type.Object(
  {
    format: Type.Literal(TRY_FORMAT),
    n: Type.Integer({ minimum: 1 }),
    at: Text,
    parent: Type.String({ minLength: 1, description: "The incumbent it was compared with." }),
    candidate: Type.String({
      minLength: 1,
      description:
        "Its variant, {loop}-{n}-{digest}@1.0, named by its code; {loop}-{n}@1.0 when there was none.",
    }),
    hypothesis: Type.Optional(HypothesisSchema),
    decision: Type.Enum([...DECISIONS], {
      description:
        "kept: better than its parent; discarded: stopped otherwise; refused: out of scope, never run; failed: no candidate; unfinished: the cap ended it before a verdict.",
    }),
    why: Text,
    verdict: Type.Optional(Type.Unknown({ description: "The comparison's verdict, whole." })),
    spend: Type.Object(
      { proposer: Usd, trials: Usd },
      { additionalProperties: false, description: "List-price estimates, as the records give." },
    ),
  },
  { additionalProperties: false },
);

export type Try = Type.Static<typeof TrySchema>;

/**
 * `finals/{k}.json`: a loop's kept incumbent against its start on the held-out cases, which only
 * this reads. Each check is kept, so one consulted twice shows it.
 */
export const FinalSchema = Type.Object(
  {
    format: Type.Literal(FINAL_FORMAT),
    k: Type.Integer({ minimum: 1 }),
    at: Text,
    incumbent: Text,
    start: Text,
    cases: Type.Array(Text),
    verdict: Type.Optional(Type.Unknown({ description: "The comparison's verdict, whole." })),
    why: Text,
    reused: Type.Integer({
      minimum: 0,
      description: "Held-out trials of either already on file when it ran: not fresh.",
    }),
    spend: Usd,
  },
  { additionalProperties: false },
);

export type Final = Type.Static<typeof FinalSchema>;
