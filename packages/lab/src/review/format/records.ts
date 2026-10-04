import Type from "typebox";
import { PARTIAL_FORMAT, type PartialRecord, PartialRecordSchema } from "./partial";
import {
  FINDINGS_FORMAT,
  type FindingsRecord,
  FindingsRecordSchema,
  SCORE_FORMAT,
  type ScoreRecord,
  ScoreRecordSchema,
  ScorerResultSchema,
} from "./scoring";
import { type Checked, checkFindingsRecord, checkSchema, checkScoreRecord } from "./validate";
import { SandboxSettingSchema } from "./workspace";

// The records `awf-lab` writes, in its own terms: a trial, a score and a partial score. The first
// versions, in `scoring.ts` and `partial.ts`, stay readable:
// `readTrial`, `readScore` and `readPartial` take either and give the second.

export const TRIAL_FORMAT = "awf.review-findings/2";
export const SCORED_FORMAT = "awf.review-score/2";
export const PARTIAL_SCORE_FORMAT = "awf.review-partial/2";

const Text = Type.String({ minLength: 1 });
const trial = FindingsRecordSchema.properties;
const score = ScoreRecordSchema.properties;

/** A variant or scorer: its version is its identity; the commit is provenance. */
const IdentitySchema = Type.Object(
  {
    name: Text,
    version: Type.String({
      pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
      description: "The semver its file declared; results belong to its {major}.{minor}.",
    }),
    commit: trial.variant.properties.commit,
    dirty: trial.variant.properties.dirty,
  },
  { additionalProperties: false },
);

/** `{results}/{dataset}/{variant}@{major}.{minor}/{case}/{trial-id}/findings.json`: one trial, written once. */
export const TrialSchema = Type.Object(
  {
    format: Type.Literal(TRIAL_FORMAT),
    id: Type.String({
      pattern: "^[0-9A-Za-z-]+$",
      description: "This trial's own id, its folder's name; the run may never have started.",
    }),
    at: trial.at,
    variant: IdentitySchema,
    dataset: Text,
    case: trial.fixture,
    restoreMs: trial.restoreMs,
    sandbox: Type.Optional({
      ...SandboxSettingSchema,
      description:
        "The sandbox setting awf-lab gave the run, from awf-lab.json, which every agent ran in; a trial counts only while it is the workspace's. Absent: the run had none.",
    }),
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
    { status: Type.Literal("scored"), judgement: ScorerResultSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { status: Type.Literal("failed"), reason: Text, problems: Type.Array(Type.String()) },
    { additionalProperties: false },
  ),
]);

const scoreFields = {
  at: score.at,
  scorer: IdentitySchema,
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
        scorer: IdentitySchema,
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

export type Identity = Type.Static<typeof IdentitySchema>;
export type Trial = Type.Static<typeof TrialSchema>;
export type Score = Type.Static<typeof ScoreSchema>;
export type PartialScore = Type.Static<typeof PartialScoreSchema>;

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

/** A first-version identity as the second writes it: `version` from where the record is filed. */
function identityFromV1(identity: FindingsRecord["variant"], version: string): Identity {
  const { hash: _hash, ...rest } = identity;
  return { ...rest, version: rest.version ?? version };
}

function trialFromV1(record: FindingsRecord, version: string): Trial {
  const { format: _format, set, fixture, variant, ...rest } = record;
  return {
    format: TRIAL_FORMAT,
    ...rest,
    variant: identityFromV1(variant, version),
    dataset: set,
    case: fixture,
  };
}

function scoreFromV1(record: ScoreRecord, version: string): Score {
  const { format: _format, judge, set, fixture, review, result, ...rest } = record;
  return {
    format: SCORED_FORMAT,
    ...rest,
    scorer: identityFromV1(judge, version),
    dataset: set,
    case: fixture,
    trial: review,
    result: result.status === "judged" ? { status: "scored", judgement: result.judgement } : result,
  };
}

function partialFromV1(record: PartialRecord, version: string, baseVersion: string): PartialScore {
  const { format: _format, picked, asked, base, ...rest } = record;
  const { format: _score, ...fields } = scoreFromV1({ ...rest, format: SCORE_FORMAT }, version);
  return {
    format: PARTIAL_SCORE_FORMAT,
    ...fields,
    picked,
    asked,
    restFrom: {
      scorer: identityFromV1(base.judge, baseVersion),
      at: base.at,
      digest: base.digest,
    },
  };
}

/**
 * A trial, as either version; a failed trial has no findings, and one that didn't fail completed.
 * A first-version record declared no version, so it takes `filed`, the one its folder names.
 */
export function readTrial(value: unknown, filed: string): Checked<Trial> {
  if (formatOf(value) === FINDINGS_FORMAT) {
    return then(checkFindingsRecord(value), (v1) => trialFromV1(v1, filed));
  }
  if (formatOf(value) !== TRIAL_FORMAT)
    return unknownFormat(value, [TRIAL_FORMAT, FINDINGS_FORMAT]);
  const checked = checkSchema(TrialSchema, value);
  if (!checked.ok) return checked;
  // The first version's rules, checked on its own fields.
  const { format: _format, dataset, case: kase, sandbox: _sandbox, ...rest } = checked.value;
  const v1 = checkFindingsRecord({ format: FINDINGS_FORMAT, ...rest, set: dataset, fixture: kase });
  return v1.ok ? checked : v1;
}

/** A score, as either version; `filed` as for `readTrial`, from its file name. */
export function readScore(value: unknown, filed: string): Checked<Score> {
  if (formatOf(value) === SCORE_FORMAT) {
    return then(checkScoreRecord(value), (v1) => scoreFromV1(v1, filed));
  }
  if (formatOf(value) !== SCORED_FORMAT) return unknownFormat(value, [SCORED_FORMAT, SCORE_FORMAT]);
  return checkSchema(ScoreSchema, value);
}

/**
 * A partial score, as either version: `filed` as for `readScore`, and `baseFiled`, the version of
 * the score a first-version one kept its other labels from, by that score's digest.
 */
export function readPartial(
  value: unknown,
  filed: string,
  baseFiled: (digest: string) => string | undefined,
): Checked<PartialScore> {
  if (formatOf(value) === PARTIAL_FORMAT) {
    const checked = checkSchema(PartialRecordSchema, value);
    if (!checked.ok) return checked;
    const base = checked.value.base;
    const baseVersion = base.judge.version ?? baseFiled(base.digest);
    if (!baseVersion) {
      return {
        ok: false,
        problems: [{ path: "/base/digest", message: "no score beside it has this digest" }],
      };
    }
    return { ok: true, value: partialFromV1(checked.value, filed, baseVersion) };
  }
  if (formatOf(value) !== PARTIAL_SCORE_FORMAT) {
    return unknownFormat(value, [PARTIAL_SCORE_FORMAT, PARTIAL_FORMAT]);
  }
  return checkSchema(PartialScoreSchema, value);
}
