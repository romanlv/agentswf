import Type from "typebox";
import { SEVERITIES } from "./format";

/** The workspace config and the report `awf-lab` prints with `--json`. */

const Text = Type.String({ minLength: 1 });
const Ratio = Type.Union([Type.Number(), Type.Null()]);

export const LAB_REPORT_FORMAT = "awf.lab-report/1" as const;

/** `awf-lab.json` at the data repository's root. Relative paths resolve from the file. */
export const LabConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    clone: Type.String({
      minLength: 1,
      description: "The project's main-branch clone that fixture snapshots restore from.",
    }),
    sets: Type.String({ minLength: 1, description: "The folder holding fixture sets." }),
    set: Type.String({
      minLength: 1,
      description: "The set a command uses unless --set names one.",
    }),
    scores: Type.String({ minLength: 1, description: "Where the records go: scores/{set}/…" }),
    runs: Type.String({
      minLength: 1,
      description: "Where awf run keeps run directories; not committed, records never need them.",
    }),
    variants: Type.Array(Text, {
      description: "Globs of *.variant.ts files; a variant is named by its file's stem.",
    }),
    judges: Type.Array(Text, {
      description: "Globs of *.judge.ts files; `panel`, the package's own, is always there.",
    }),
    judge: Type.String({ minLength: 1, description: "The judge a command uses unless --judge." }),
    budget: Type.Optional(
      Type.Object(
        {
          usd: Type.Number({
            minimum: 0,
            description: "Priced at list prices, as a run's accounting estimates it.",
          }),
        },
        { additionalProperties: false },
      ),
    ),
    seed: Type.Optional(
      Type.String({ minLength: 1, description: "Orders fixtures for --fixtures {n}; awf-lab." }),
    ),
  },
  { additionalProperties: false, description: "An awf-lab workspace." },
);

const Spend = Type.Object(
  {
    runs: Type.Integer({ minimum: 0 }),
    ms: Type.Integer({ minimum: 0 }),
    estimate: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    complete: Type.Boolean(),
  },
  { additionalProperties: false },
);

const Tally = Type.Object(
  { total: Type.Integer({ minimum: 0 }), hit: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);

const VariantReport = Type.Object(
  {
    name: Text,
    hash: Text,
    commit: Type.Union([Text, Type.Null()], { description: "The variant file's repository." }),
    dirty: Type.Boolean(),
    fixtures: Type.Array(Text, { description: "Fixtures scored: reviewed and judged." }),
    tunedOn: Type.Array(Text, {
      description:
        "Scored fixtures the variant was tuned on, by its tunedOn: counted, but not holdout.",
    }),
    missing: Type.Array(
      Type.Object({ fixture: Text, why: Text }, { additionalProperties: false }),
      { description: "Selected fixtures without a scored record, and why; never guessed." },
    ),
    failedReviews: Type.Array(Text, { description: "Fixtures whose review did not succeed." }),
    recall: Type.Object(Object.fromEntries(SEVERITIES.map((s) => [s, Ratio])), {
      additionalProperties: false,
    }),
    weightedRecall: Ratio,
    distinct: Type.Integer({ minimum: 0 }),
    precision: Ratio,
    wrong: Ratio,
    noise: Ratio,
    nits: Ratio,
    words: Type.Integer({ minimum: 0 }),
    labels: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
    bySeverity: Type.Record(Type.String(), Tally, {
      description: "Issues the MR caused and those hit, by severity: recall's counts.",
    }),
    context: Tally,
    byCategory: Type.Record(Type.String(), Tally),
    bySource: Type.Record(Type.String(), Tally),
    missed: Type.Array(
      Type.Object({ fixture: Text, issue: Text, mechanism: Text }, { additionalProperties: false }),
    ),
    agreement: Type.Union([Type.Number(), Type.Null()], {
      description: "Mean κ between the panel's two voters over the fixtures judged.",
    }),
    restoreMs: Type.Integer({ minimum: 0 }),
    review: Spend,
    judge: Spend,
  },
  { additionalProperties: false },
);

export const LabReportSchema = Type.Object(
  {
    format: Type.Literal(LAB_REPORT_FORMAT),
    set: Text,
    judge: Type.Object({ name: Text, hash: Text }, { additionalProperties: false }),
    keyRevisions: Type.Array(Type.Integer({ minimum: 1 }), {
      description: "The key revisions scored against: each fixture's current one.",
    }),
    keyProcedures: Type.Array(Text, {
      description: "The procedures those keys were drafted under; numbers compare only within one.",
    }),
    filter: Type.Optional(
      Type.Object(
        { categories: Type.Array(Text, { minItems: 1 }) },
        { additionalProperties: false, description: "Only these categories were counted." },
      ),
    ),
    budgetBasis: Type.Literal("list-price", {
      description: "Costs are list-price estimates, also for runs on a subscription.",
    }),
    variants: Type.Array(VariantReport, { minItems: 1, maxItems: 2 }),
    comparison: Type.Optional(
      Type.Object(
        {
          fixtures: Type.Array(Text, { description: "The fixtures both variants have scored." }),
          wins: Type.Record(Type.String(), Type.Array(Text), {
            description: "By variant name: the fixtures it won, by weighted recall then precision.",
          }),
          ties: Type.Array(Text),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      "What awf-lab report prints with --json: one variant's numbers, or two side by side over the fixtures both have.",
  },
);

export type LabConfig = Type.Static<typeof LabConfigSchema>;
export type LabReport = Type.Static<typeof LabReportSchema>;
export type VariantReport = Type.Static<typeof VariantReport>;
