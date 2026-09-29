import Type from "typebox";
import { CATEGORIES, IssueId, RefutedId, SEVERITIES } from "./format";

/**
 * The scoring formats from story 008: what a review run found, what a judge made of it, and the
 * judging `awf-lab` keeps. As in `format.ts`, each schema is the single definition of its type,
 * its checks and its `schema/*.schema.json`.
 */

const Text = Type.String({ minLength: 1 });
const Timestamp = Type.String({ minLength: 1, description: "ISO 8601" });
const Index = Type.Integer({ minimum: 0 });
const Digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });

export const FINDINGS_FORMAT = "awf.review-findings/1";
export const JUDGEMENT_FORMAT = "awf.review-judgement/1";
export const SCORE_FORMAT = "awf.review-score/1";

export const RUN_OUTCOMES = ["succeeded", "failed", "cancelled", "timed-out"] as const;

/** The common shape every variant's findings are read into, so different workflows compare. */
export const ReviewFindingSchema = Type.Object(
  {
    path: Type.Optional(Text),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    text: Type.String({
      minLength: 1,
      description: "What a person reading the review would read; words are counted over it.",
    }),
    severity: Type.Optional(Type.String({ description: "The reviewer's own word for it." })),
  },
  { additionalProperties: false },
);

/** One `awf run`, as a score keeps it: how it ended, what ran, how long it took, what it cost. */
const RunSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ description: "Absent when the run never started." })),
    outcome: Type.Enum([...RUN_OUTCOMES]),
    error: Type.Optional(Type.String()),
    models: Type.Array(Text, {
      description: "Every model its agents and decisions used, so a family can be told apart.",
    }),
    ms: Type.Integer({ minimum: 0 }),
    estimate: Type.Optional(
      Type.Number({ minimum: 0, description: "USD at list price, agents and decisions." }),
    ),
    charged: Type.Optional(Type.Number({ minimum: 0 })),
    billing: Type.Enum(["subscription", "metered", "unknown", "mixed"]),
    complete: Type.Boolean({ description: "Every agent's usage was known and priced." }),
  },
  { additionalProperties: false },
);

/** A variant or a judge: its file's name, what it executes, and the file's repository. */
const IdentitySchema = Type.Object(
  {
    name: Text,
    hash: Type.Optional(
      Type.String({
        pattern: "^v[0-9]+-[0-9a-f]{16,64}$",
        description:
          "The first version kept a content hash; never read. The version is the identity.",
      }),
    ),
    version: Type.Optional(
      Type.String({
        pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
        description:
          "The semver its file declared. Absent in records written before versions: their folder or file name says it.",
      }),
    ),
    commit: Type.Union([Type.String({ pattern: "^[0-9a-f]{40}$" }), Type.Null()], {
      description: "The file's repository at HEAD; null outside git.",
    }),
    dirty: Type.Boolean(),
  },
  { additionalProperties: false },
);

const FixtureRef = Type.Object({ id: Text, digest: Digest }, { additionalProperties: false });

/** `scores/{set}/{variant-hash}/{fixture}/{id}/findings.json`: one review, written once. */
export const FindingsRecordSchema = Type.Object(
  {
    format: Type.Literal(FINDINGS_FORMAT),
    id: Type.String({
      pattern: "^[0-9A-Za-z-]+$",
      description: "This review's own id, its folder's name; the run may never have started.",
    }),
    at: Timestamp,
    variant: IdentitySchema,
    set: Text,
    fixture: FixtureRef,
    restoreMs: Type.Integer({ minimum: 0 }),
    run: RunSchema,
    failure: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Why there are no findings to judge: the run did not succeed, or its variant's read failed.",
      }),
    ),
    findings: Type.Array(ReviewFindingSchema),
  },
  {
    additionalProperties: false,
    description: "A review run on one fixture and the findings its variant read from it, verbatim.",
  },
);

const CodeRef = Type.Object(
  { path: Text, start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false, description: "Lines the judge read in the frozen code." },
);

const labelled = <L extends string, P extends Type.TProperties>(label: L, properties: P) =>
  Type.Object(
    {
      finding: Index,
      label: Type.Literal(label),
      why: Text,
      read: Type.Array(CodeRef),
      ...properties,
    },
    { additionalProperties: false },
  );

/** Each label's schema by name, so a bad label is reported against the label it claims to be. */
export const LABEL_SCHEMAS = {
  hit: labelled("hit", { issue: IssueId }),
  new: labelled("new", {
    severity: Type.Enum([...SEVERITIES]),
    category: Type.Enum([...CATEGORIES]),
    scope: Type.Enum(["change", "context"], {
      description: "Whether the MR caused it or it was already there, as a key issue says.",
    }),
    mechanism: Type.String({ minLength: 1, description: "As a key issue gives one." }),
  }),
  wrong: labelled("wrong", {
    refutes: Type.String({ minLength: 1, description: "The code fact that shows it false." }),
    symptomOf: Type.Optional(IssueId),
    repeats: Type.Optional(RefutedId),
  }),
  noise: labelled("noise", {}),
  duplicate: labelled("duplicate", { of: Index }),
  unsettled: labelled("unsettled", {
    excluded: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "The `unconfirmed` exclusion it repeats, by position; absent when the judges did not agree.",
      }),
    ),
  }),
};

export const LABELS = ["hit", "new", "wrong", "noise", "duplicate", "unsettled"] as const;

export const FindingLabelSchema = Type.Union([
  LABEL_SCHEMAS.hit,
  LABEL_SCHEMAS.new,
  LABEL_SCHEMAS.wrong,
  LABEL_SCHEMAS.noise,
  LABEL_SCHEMAS.duplicate,
  LABEL_SCHEMAS.unsettled,
]);

const LabelsSchema = Type.Array(FindingLabelSchema);

export const JudgementSchema = Type.Object(
  {
    format: Type.Literal(JUDGEMENT_FORMAT),
    labels: Type.Array(FindingLabelSchema, { description: "One per finding, in order." }),
    missed: Type.String({ description: "What the review missed, and why: feedback." }),
    votes: Type.Optional(
      Type.Array(
        Type.Object(
          {
            by: Text,
            role: Type.Enum(["panel", "tiebreak"], {
              description: "A panel voter labels every finding; a tiebreak only those split on.",
            }),
            labels: LabelsSchema,
          },
          { additionalProperties: false },
        ),
        { description: "Each voter's answer, when there were several; panel voters first." },
      ),
    ),
  },
  {
    additionalProperties: false,
    description: "What every judge returns, whatever it is inside.",
  },
);

/**
 * `judged.{judge-hash}.k{revision}.{n}.json` beside the findings, `n` counting judgings by that
 * judge on that key revision: one judging, written once.
 */
export const ScoreRecordSchema = Type.Object(
  {
    format: Type.Literal(SCORE_FORMAT),
    at: Timestamp,
    judge: IdentitySchema,
    set: Text,
    fixture: FixtureRef,
    review: Type.String({ minLength: 1, description: "The id of the findings record judged." }),
    key: Type.Object(
      {
        revision: Type.Integer({ minimum: 1 }),
        procedure: Text,
        digest: Type.String({
          pattern: "^sha256:[0-9a-f]{64}$",
          description: "SHA-256 of key.json as canonical JSON: the key exactly as judged.",
        }),
      },
      { additionalProperties: false },
    ),
    run: Type.Optional(RunSchema),
    agreement: Type.Optional(
      Type.Number({
        minimum: -1,
        maximum: 1,
        description: "Cohen's κ between the two panel voters, when there were two.",
      }),
    ),
    result: Type.Union([
      Type.Object(
        { status: Type.Literal("judged"), judgement: JudgementSchema },
        { additionalProperties: false },
      ),
      Type.Object(
        { status: Type.Literal("failed"), reason: Text, problems: Type.Array(Type.String()) },
        { additionalProperties: false },
      ),
    ]),
  },
  {
    additionalProperties: false,
    description:
      "A judging of one review. No run when there was nothing to judge; a failed one is retried, never scored.",
  },
);

export type ReviewFinding = Type.Static<typeof ReviewFindingSchema>;
export type RunSummary = Type.Static<typeof RunSchema>;
export type FindingsRecord = Type.Static<typeof FindingsRecordSchema>;
export type FindingLabel = Type.Static<typeof FindingLabelSchema>;
export type Label = FindingLabel["label"];
export type Judgement = Type.Static<typeof JudgementSchema>;
export type ScoreRecord = Type.Static<typeof ScoreRecordSchema>;
