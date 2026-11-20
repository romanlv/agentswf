import Type from "typebox";
import { SEMVER } from "../../shared/version";
import { AgentReachSchema, AgentSchema, FactSchema } from "./settings";
import { DATASET_ERRORS, RefusedSchema } from "./trial-file";

// The records the lab writes in its store: a run, a trial, a score and a label; and the grade
// folder's `grade.json`. Each is checked against its schema before it is written and when it is
// read. A `/0` one, from before reviews moved onto cases, is named and left out, never converted.

export const RUN_KIND = "awf.case-run/1";
export const TRIAL_KIND = "awf.case-trial/1";
export const SCORE_KIND = "awf.case-score/1";
export const GRADE_KIND = "awf.case-grade/1";
export const LABEL_KIND = "awf.case-label/1";

/** Why a record of a retired `/0` kind is not read; undefined for any other value. */
export function retiredRecord(file: string, value: unknown): string | undefined {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && /^awf\.case-[a-z]+\/0$/.test(kind)
    ? `${file} is not valid:\n  kind: ${kind} is from before the lab's records were /1; left out, never converted`
    : undefined;
}

const Text = Type.String({ minLength: 1 });
const Time = Type.String({ format: "date-time" });
const Digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
export const RunId = Type.String({ pattern: "^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$" });

/** A folder of code: a column of the report. */
export const FolderSchema = Type.Object(
  {
    path: Text,
    /** null: detached. */
    branch: Type.Union([Text, Type.Null()]),
    commit: Type.Union([Text, Type.Null()]),
    dirty: Type.Boolean(),
    /** The digest of the dataset's `env.ts` in this folder. */
    env: Digest,
  },
  { additionalProperties: false },
);
export type Folder = Type.Static<typeof FolderSchema>;

/**
 * A parameter's name: plain words a dataset's `env.ts` reads as `c.params`. A dot is kept for the
 * lab's own parameters.
 */
export const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The parameters a trial ran under, each a string. */
export const ParamsSchema = Type.Record(Type.String({ pattern: PARAM_NAME.source }), Text);
export type Params = Type.Static<typeof ParamsSchema>;

/** A column of the report: a folder of code and the parameters its trials ran under. */
export const ColumnSchema = Type.Object(
  {
    /** The folder's index in the run's `folders`. */
    folder: Type.Integer({ minimum: 0 }),
    params: ParamsSchema,
  },
  { additionalProperties: false },
);
export type Column = Type.Static<typeof ColumnSchema>;

/** `{store}/runs/{n}/run.json`. No `finished`, or `broke`, means partial. */
export const RunRecordSchema = Type.Object(
  {
    kind: Type.Literal(RUN_KIND),
    /** The time and four random hex digits: `20261117-142233-a3f9`. */
    id: RunId,
    dataset: Text,
    folders: Type.Array(FolderSchema, { minItems: 1 }),
    /**
     * Each folder under each combination of parameters, the folders outermost. The first is the
     * reference column: your checkout under `--param` and each `--vary`'s first value.
     */
    columns: Type.Array(ColumnSchema, { minItems: 1 }),
    asked: Type.Array(
      Type.Object(
        { case: Text, trials: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
    started: Time,
    /** When it ended, or broke; none when it was killed. */
    finished: Type.Optional(Time),
    /** Set when the lab broke during the run. */
    broke: Type.Optional(Type.String()),
    /**
     * Set when the run stopped starting trials: `budget`, its estimates reached `--budget`;
     * `compare`, a loop's try that the dataset's comparison stopped.
     */
    stopped: Type.Optional(Type.Union([Type.Literal("budget"), Type.Literal("compare")])),
  },
  { additionalProperties: false },
);
export type RunRecord = Type.Static<typeof RunRecordSchema>;

export const OUTCOMES = [
  "leaked",
  "errored",
  "failed",
  "stopped",
  "undecided",
  "passed",
  "graded by numbers",
  "not graded",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const ErroredSchema = Type.Object(
  {
    by: Type.Union([
      Type.Literal("dataset"),
      Type.Literal("grading"),
      Type.Literal("provider"),
      Type.Literal("lab"),
    ]),
    phase: Type.Union([
      Type.Literal("setup"),
      Type.Literal("body"),
      Type.Literal("observe"),
      Type.Literal("teardown"),
      Type.Literal("after"),
    ]),
    code: Type.Optional(Type.Enum([...DATASET_ERRORS, "reach", "login"] as const)),
    reason: Type.String(),
  },
  { additionalProperties: false },
);
export type Errored = Type.Static<typeof ErroredSchema>;

/** One agent's sandbox, as the reach check read it. */
const ReachSchema = Type.Object(
  {
    ok: Type.Boolean(),
    problems: Type.Array(Type.String()),
    sockets: Type.Array(Type.String()),
    sandboxes: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          provider: Type.String(),
          network: Type.Array(Type.String()),
          webSearch: Type.Boolean(),
          agents: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** `{store}/runs/{n}/trials/{case}/{column}-{trial}/trial.json`. */
export const TrialRecordSchema = Type.Object(
  {
    kind: Type.Literal(TRIAL_KIND),
    run: RunId,
    dataset: Text,
    case: Text,
    /** The column's index in the run's `columns`. */
    column: Type.Integer({ minimum: 0 }),
    trial: Type.Integer({ minimum: 1 }),
    /** The column's parameters, as `env.ts` and the graders were given them. */
    params: ParamsSchema,
    /**
     * What shaped the trial, as one digest: the code, the parameters, the built case, the trial
     * settings, and the awf and lab it ran on. Absent outside git: never reused.
     */
    reuse: Type.Optional(Digest),
    /**
     * Set when read through a later run that reused this trial: where it ran. Never written: the
     * later run's folder holds `reused.json`, a pointer, and the trial's grades stay where it ran.
     */
    reused: Type.Optional(
      Type.Object(
        {
          run: RunId,
          column: Type.Integer({ minimum: 0 }),
          trial: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    awf: Type.Object({ bin: Text, version: Text }, { additionalProperties: false }),
    /** The built case folder's digest; the folder is kept once, in the store's `inputs/`. */
    input: Digest,
    /** `workflow`: the workflow's own sandboxes; `lab`: the lab's box around the whole trial. */
    sandbox: Type.Union([Type.Literal("workflow"), Type.Literal("lab")]),
    agentReach: AgentReachSchema,
    models: Type.Array(Text),
    at: Time,
    workflow: Type.Optional(
      Type.Object(
        { name: Text, version: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
    /** The workflow run: absent when the trial ended before one started (leaked, the lab). */
    runId: Type.Optional(Text),
    runOutcome: Type.Optional(Text),
    runReason: Type.Optional(Type.String()),
    ms: Type.Number({ minimum: 0 }),
    setupMs: Type.Optional(Type.Number({ minimum: 0 })),
    estimate: Type.Optional(Type.Number({ minimum: 0 })),
    known: Type.Optional(Type.Integer({ minimum: 0 })),
    priced: Type.Optional(Type.Integer({ minimum: 0 })),
    agents: Type.Optional(Type.Integer({ minimum: 0 })),
    result: Type.Optional(Type.Unknown()),
    facts: Type.Optional(Type.Record(Type.String(), FactSchema)),
    stages: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    /** Each stage the workflow ran, by name: how long it took. A given stage ran no work. */
    stageMs: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 0 }))),
    given: Type.Optional(Type.Array(Type.String())),
    until: Type.Optional(Type.String()),
    neverReached: Type.Optional(Type.Array(Type.String())),
    unused: Type.Array(Type.String()),
    refused: Type.Array(RefusedSchema),
    kept: Type.Array(Type.String()),
    leaked: Type.Boolean(),
    reach: Type.Optional(ReachSchema),
    stopped: Type.Optional(Type.String()),
    /** The workflow's own error: its body failed or timed out, or `observe` returned one. */
    workflowError: Type.Optional(Type.String()),
    errored: Type.Optional(ErroredSchema),
    /** Tried again at the end of its round after the provider's error. */
    retried: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type TrialRecord = Type.Static<typeof TrialRecordSchema>;

const VERDICTS = ["passed", "failed", "undecided"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** A count out of a total, pooled per column by summing; `of: 0` is none in this case. Or a value. */
const NumberSchema = Type.Union([
  Type.Object(
    { count: Type.Number({ minimum: 0 }), of: Type.Number({ minimum: 0 }) },
    { additionalProperties: false },
  ),
  Type.Object({ value: Type.Number() }, { additionalProperties: false }),
]);

const ReasonSchema = Type.Object(
  { about: Text, text: Type.String() },
  { additionalProperties: false },
);

const Judged = Type.Enum([...VERDICTS, "not judged"] as const);

/** One voter's say on a part: a verdict, or a label of the grader's own (a finding's `hit`). */
export const VoteSchema = Type.Object(
  {
    by: Text,
    role: Type.Optional(Text),
    verdict: Type.Optional(Judged),
    label: Type.Optional(Text),
    data: Type.Optional(Type.Unknown()),
    why: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** One thing a grader judged, such as a criterion or a finding: its verdict or label, and votes. */
export const PartSchema = Type.Object(
  {
    about: Text,
    verdict: Type.Optional(Judged),
    label: Type.Optional(Text),
    data: Type.Optional(Type.Unknown()),
    why: Type.Optional(Type.String()),
    settled: Type.Optional(
      Type.Enum(["agreed", "majority", "tiebreak", "unsettled", "given"] as const),
    ),
    votes: Type.Optional(Type.Array(VoteSchema)),
  },
  { additionalProperties: false },
);

export type Part = Type.Static<typeof PartSchema>;

export const GraderEntrySchema = Type.Object(
  {
    grader: Text,
    /**
     * The grader's version, semver: results belong to its `{major}.{minor}`, so a patch bump keeps
     * them. Absent when the grader errored before its version was read.
     */
    version: Type.Optional(Type.String({ pattern: SEMVER.source })),
    key: Digest,
    verdict: Type.Optional(Type.Enum(VERDICTS)),
    numbers: Type.Optional(Type.Record(Text, NumberSchema)),
    reasons: Type.Array(ReasonSchema),
    parts: Type.Optional(Type.Array(PartSchema)),
    /** The grader does not apply to this case, and why: neither a verdict nor numbers. */
    notApplies: Type.Optional(Type.String()),
    models: Type.Optional(Type.Array(Text)),
    /** The harness and model a grader that runs one agent of its choosing used: the judge's. */
    agent: Type.Optional(AgentSchema),
    ms: Type.Optional(Type.Number({ minimum: 0 })),
    estimate: Type.Optional(Type.Number({ minimum: 0 })),
    runId: Type.Optional(Text),
    errored: Type.Optional(
      Type.Object(
        { reason: Type.String(), problems: Type.Optional(Type.Array(Type.String())) },
        { additionalProperties: false },
      ),
    ),
    /**
     * Graded beside the judge that decides, by `score --judge`: kept to compare judges on the same
     * trials, never in the verdict. Read as its own grader, named by its agent.
     */
    beside: Type.Optional(Type.Literal(true)),
    /** Skipped, as a cheaper grader failed the trial: graded by `score` once it passes them. */
    skipped: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);
export type GraderEntry = Type.Static<typeof GraderEntrySchema>;

/** A line of `{trial}/scores.jsonl`: every score a trial is given, newest last. */
export const ScoreRecordSchema = Type.Object(
  {
    kind: Type.Literal(SCORE_KIND),
    at: Time,
    entries: Type.Array(GraderEntrySchema),
  },
  { additionalProperties: false },
);
export type ScoreRecord = Type.Static<typeof ScoreRecordSchema>;

/** A grader's earlier parts, given to it as `previous.json` so it judges only what changed. */
export const PreviousSchema = Type.Object(
  {
    /** The digest of the key those parts were graded on. */
    key: Digest,
    parts: Type.Array(PartSchema),
  },
  { additionalProperties: false },
);
export type Previous = Type.Static<typeof PreviousSchema>;

/** `grade.json` in a grade folder: what a grader workflow reads with `gradeCase()`. */
export const GradeFileSchema = Type.Object(
  {
    kind: Type.Literal(GRADE_KIND),
    case: Text,
    /** The trial's working folder, during the trial; null under `score`, which has none. */
    scratch: Type.Union([Text, Type.Null()]),
    /** The trial's parameters. */
    params: ParamsSchema,
    readsFacts: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type GradeFile = Type.Static<typeof GradeFileSchema>;

const MARKS = ["good", "needs-work", "cleared"] as const;
export type Mark = (typeof MARKS)[number];

/**
 * A line of `{store}/labels/{dataset}.jsonl`: the person's verdict on one trial, found by its
 * workflow run's id, so a reused copy keeps it. The newest line of a trial wins; `cleared` takes
 * a label back.
 */
export const LabelRecordSchema = Type.Object(
  {
    kind: Type.Literal(LABEL_KIND),
    /** The trial's workflow run id, as `awf` named it: not the lab's run id. */
    runId: Text,
    case: Text,
    mark: Type.Enum(MARKS),
    /** Why it needs work. */
    note: Type.Optional(Text),
    at: Time,
  },
  { additionalProperties: false },
);
export type LabelRecord = Type.Static<typeof LabelRecordSchema>;
