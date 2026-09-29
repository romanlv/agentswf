import Type from "typebox";
import { Check, Errors } from "typebox/value";
import { PARTIAL_FORMAT, type PartialRecord, PartialRecordSchema } from "./partial";
import {
  FINDINGS_FORMAT,
  type FindingsRecord,
  FindingsRecordSchema,
  JudgementSchema,
  SCORE_FORMAT,
  type ScoreRecord,
  ScoreRecordSchema,
} from "./scoring";
import { type Checked, checkFindingsRecord, checkScoreRecord, type Problem } from "./validate";

// The records `awf-lab` writes, in its own terms: a trial, a score and a partial score. Apart from
// `scoring.ts`, which every scorer imports, as `partial.ts` is. The first versions stay readable:
// `readTrial`, `readScore` and `readPartial` take either and give the second.

export const TRIAL_FORMAT = "awf.review-findings/2";
export const SCORED_FORMAT = "awf.review-score/2";
export const PARTIAL_SCORE_FORMAT = "awf.review-partial/2";

const Text = Type.String({ minLength: 1 });
const trial = FindingsRecordSchema.properties;
const score = ScoreRecordSchema.properties;

/** `{results}/{dataset}/{variant}@{major}.{minor}/{case}/{trial-id}/findings.json`: one trial, written once. */
export const TrialSchema = Type.Object(
  {
    format: Type.Literal(TRIAL_FORMAT),
    id: Type.String({
      pattern: "^[0-9A-Za-z-]+$",
      description: "This trial's own id, its folder's name; the run may never have started.",
    }),
    at: trial.at,
    variant: trial.variant,
    dataset: Text,
    case: trial.fixture,
    restoreMs: trial.restoreMs,
    run: trial.run,
    failure: trial.failure,
    findings: trial.findings,
  },
  {
    additionalProperties: false,
    description:
      "One attempt by a variant at one case: its run, and the findings its variant read from it, verbatim.",
  },
);

const ScoreResult = Type.Union([
  Type.Object(
    { status: Type.Literal("scored"), judgement: JudgementSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal("failed"), reason: Text, problems: Type.Array(Type.String()) },
    { additionalProperties: false },
  ),
]);

const scoreFields = {
  at: score.at,
  scorer: score.judge,
  dataset: Text,
  case: score.fixture,
  trial: Type.String({ minLength: 1, description: "The id of the trial scored." }),
  key: score.key,
  run: score.run,
  agreement: score.agreement,
  result: ScoreResult,
};

/**
 * `score.{scorer}@{major}.{minor}.k{revision}.{n}.json` beside the trial, `n` counting that scorer's scores on
 * that key revision: one score, written once.
 */
export const ScoreSchema = Type.Object(
  { format: Type.Literal(SCORED_FORMAT), ...scoreFields },
  {
    additionalProperties: false,
    description:
      "One scorer's labels for one trial. No run when there was nothing to score; a failed one is retried, never counted.",
  },
);

/**
 * `partial.{scorer}@{major}.{minor}.k{revision}.{n}.json` beside the trial: a scorer's labels for chosen
 * findings, the other labels kept from another score (`restFrom`). Never counted.
 */
export const PartialScoreSchema = Type.Object(
  {
    format: Type.Literal(PARTIAL_SCORE_FORMAT),
    ...scoreFields,
    picked: PartialRecordSchema.properties.picked,
    asked: PartialRecordSchema.properties.asked,
    restFrom: Type.Object(
      {
        scorer: score.judge,
        at: Type.String({ minLength: 1, description: "That score's `at`." }),
        digest: Type.String({
          pattern: "^sha256:[0-9a-f]{64}$",
          description: "SHA-256 of that score's record, as stored, as canonical JSON.",
        }),
      },
      {
        additionalProperties: false,
        description: "The score whose labels the other findings kept.",
      },
    ),
  },
  {
    additionalProperties: false,
    description: "A score of chosen findings of one trial, the rest kept from another score.",
  },
);

export type Trial = Type.Static<typeof TrialSchema>;
export type Score = Type.Static<typeof ScoreSchema>;
export type PartialScore = Type.Static<typeof PartialScoreSchema>;

/** Checks a value against a schema, each problem once. */
export function checkWith<S extends Type.TSchema>(
  schema: S,
  value: unknown,
): Checked<Type.Static<S>> {
  if (Check(schema, value)) return { ok: true, value };
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const error of Errors(schema, value)) {
    const problem = { path: error.instancePath || "/", message: error.message };
    const key = `${problem.path} ${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(problem);
  }
  return { ok: false, problems };
}

const formatOf = (value: unknown) =>
  typeof value === "object" && value !== null ? (value as { format?: unknown }).format : undefined;

const unknownFormat = (value: unknown, known: string[]): Checked<never> => ({
  ok: false,
  problems: [
    { path: "/format", message: `${String(formatOf(value))} is not one of ${known.join(", ")}` },
  ],
});

function then<A, B>(checked: Checked<A>, map: (value: A) => B): Checked<B> {
  return checked.ok ? { ok: true, value: map(checked.value) } : checked;
}

export function trialFromV1(record: FindingsRecord): Trial {
  const { format: _format, set, fixture, ...rest } = record;
  return { format: TRIAL_FORMAT, ...rest, dataset: set, case: fixture };
}

export function scoreFromV1(record: ScoreRecord): Score {
  const { format: _format, judge, set, fixture, review, result, ...rest } = record;
  return {
    format: SCORED_FORMAT,
    ...rest,
    scorer: judge,
    dataset: set,
    case: fixture,
    trial: review,
    result: result.status === "judged" ? { status: "scored", judgement: result.judgement } : result,
  };
}

export function partialFromV1(record: PartialRecord): PartialScore {
  const { format: _format, picked, asked, base, ...rest } = record;
  const { format: _score, ...fields } = scoreFromV1({ ...rest, format: SCORE_FORMAT });
  return {
    format: PARTIAL_SCORE_FORMAT,
    ...fields,
    picked,
    asked,
    restFrom: { scorer: base.judge, at: base.at, digest: base.digest },
  };
}

/** A trial, as either version; a failed trial has no findings, and one that didn't fail succeeded. */
export function readTrial(value: unknown): Checked<Trial> {
  if (formatOf(value) === FINDINGS_FORMAT) return then(checkFindingsRecord(value), trialFromV1);
  if (formatOf(value) !== TRIAL_FORMAT)
    return unknownFormat(value, [TRIAL_FORMAT, FINDINGS_FORMAT]);
  const checked = checkWith(TrialSchema, value);
  if (!checked.ok) return checked;
  // The first version's rules, checked on its own fields.
  const { format: _format, dataset, case: kase, ...rest } = checked.value;
  const v1 = checkFindingsRecord({ format: FINDINGS_FORMAT, ...rest, set: dataset, fixture: kase });
  return v1.ok ? checked : v1;
}

export function readScore(value: unknown): Checked<Score> {
  if (formatOf(value) === SCORE_FORMAT) return then(checkScoreRecord(value), scoreFromV1);
  if (formatOf(value) !== SCORED_FORMAT) return unknownFormat(value, [SCORED_FORMAT, SCORE_FORMAT]);
  return checkWith(ScoreSchema, value);
}

export function readPartial(value: unknown): Checked<PartialScore> {
  if (formatOf(value) === PARTIAL_FORMAT) {
    return then(checkWith(PartialRecordSchema, value), partialFromV1);
  }
  if (formatOf(value) !== PARTIAL_SCORE_FORMAT) {
    return unknownFormat(value, [PARTIAL_SCORE_FORMAT, PARTIAL_FORMAT]);
  }
  return checkWith(PartialScoreSchema, value);
}
