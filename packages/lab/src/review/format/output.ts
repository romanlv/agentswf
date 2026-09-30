import Type from "typebox";
import { SEVERITIES } from "./format";
import { FindingLabelSchema, FindingsRecordSchema } from "./scoring";

/**
 * What each `awf-lab` command prints with `--json`, one format each; `awf-lab schema {format}`
 * prints its schema. Every case, trial and finding carries its address, which `--only` takes back:
 * `{case}`, `{case}/{trial}`, `{case}#{finding}`, `{case}/{trial}#{finding}`, and in a document
 * that covers several variants, `{variant}:` before each.
 */

export const LIST_FORMAT = "awf.lab-list/3";
export const RUN_FORMAT = "awf.lab-run/2";
export const REPORT_FORMAT = "awf.lab-report/4";
export const SHOW_FORMAT = "awf.lab-show/2";
export const SCHEMAS_FORMAT = "awf.lab-schemas/1";

const Text = Type.String({ minLength: 1 });
const Count = Type.Integer({ minimum: 0 });
const Ratio = Type.Union([Type.Number(), Type.Null()]);
const Address = Type.String({
  minLength: 1,
  description: "{variant}:{case}/{trial}#{finding}, the variant only where several are covered.",
});
const Version = Type.String({
  pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
  description: "The semver its file declares; results belong to its {major}.{minor}.",
});
const Ref = Type.Object(
  { name: Text, version: Version },
  { additionalProperties: false, description: "A variant or scorer: its name and version." },
);
const Run = FindingsRecordSchema.properties.run;

const ComparedMetric = Type.Object(
  {
    name: Text,
    role: Type.Enum(["primary", "guard", "tiebreak", "reported"]),
    cases: Count,
    baseline: Ratio,
    challenger: Ratio,
    difference: Ratio,
    interval: Type.Optional(
      Type.Tuple([Type.Number(), Type.Number()], {
        description: "The two-sided interval on the difference; absent below 5 cases.",
      }),
    ),
    won: Count,
    tied: Count,
    lost: Count,
  },
  {
    additionalProperties: false,
    description: "One metric, challenger minus baseline, over the cases both have.",
  },
);

export const VerdictSchema = Type.Object(
  {
    verdict: Type.Enum(["better", "worse", "tie", "undecided"]),
    stop: Type.Boolean({ description: "Whether a run should spend no more on this pair." }),
    reason: Text,
    metrics: Type.Array(ComparedMetric),
  },
  { additionalProperties: false, description: "What the comparison said, and why." },
);

const Stored = Type.Object(
  {
    ref: Type.String({
      minLength: 1,
      description: "{name}@{major}.{minor}, as a command takes it.",
    }),
    versions: Type.Array(Version, { description: "The versions its records declare." }),
    current: Type.Boolean({ description: "The {major}.{minor} the file declares now." }),
    cases: Count,
    trials: Type.Optional(Count),
    scores: Type.Optional(Count),
  },
  { additionalProperties: false },
);

const Known = Type.Object(
  {
    name: Text,
    file: Text,
    version: Type.Union([Version, Type.Null()], {
      description: "Null when the file fails to load.",
    }),
    error: Type.Optional(Text),
    stored: Type.Array(Stored, {
      description: "Versions with records in the dataset, newest first.",
    }),
  },
  { additionalProperties: false },
);

export const ListSchema = Type.Object(
  {
    format: Type.Literal(LIST_FORMAT),
    workspace: Type.Object(
      {
        config: Text,
        clone: Text,
        datasets: Text,
        results: Text,
        runs: Text,
        dataset: Text,
        scorer: Text,
        comparison: Text,
        comparisonError: Type.Optional(
          Type.String({ minLength: 1, description: "Why the config's comparison can't be found." }),
        ),
        baseline: Type.Optional(Text),
        budget: Type.Optional(Type.Number({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    datasets: Type.Optional(
      Type.Array(
        Type.Object(
          { name: Text, dir: Text, cases: Count, builtAt: Text },
          { additionalProperties: false },
        ),
      ),
    ),
    cases: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Address,
            keyRevision: Type.Integer({ minimum: 1 }),
            issues: Type.Record(Type.String(), Count, { description: "Key issues by severity." }),
            at: Text,
          },
          { additionalProperties: false },
        ),
        { description: "The selected cases of the dataset, in the seeded order." },
      ),
    ),
    variants: Type.Optional(Type.Array(Known)),
    scorers: Type.Optional(Type.Array(Known)),
    comparisons: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Text,
            file: Text,
            version: Type.Union([Type.String(), Type.Null()], {
              description: "Null when the file fails to load.",
            }),
            error: Type.Optional(Text),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false, description: "What awf-lab list prints with --json." },
);

const TrialStep = Type.Object(
  {
    do: Type.Enum(["run", "reuse", "skip"]),
    trial: Type.Optional(Type.String({ minLength: 1, description: "The trial's id." })),
    why: Type.Optional(Text),
    outcome: Type.Optional(Type.String({ description: "How the trial's run ended, once run." })),
    findings: Type.Optional(Count),
  },
  { additionalProperties: false },
);

const ScoreStep = Type.Object(
  {
    do: Type.Enum(["run", "reuse", "record", "skip", "partial", "reuse-partial"]),
    why: Type.Optional(Text),
    picked: Type.Optional(Type.Array(Count, { description: "The findings chosen." })),
    asked: Type.Optional(
      Type.Array(Count, {
        description: "The findings scored: the chosen, and those that depend on them.",
      }),
    ),
    restFrom: Type.Optional(Ref),
    status: Type.Optional(Type.Enum(["scored", "failed"], { description: "Once run." })),
    reason: Type.Optional(Text),
  },
  { additionalProperties: false },
);

const Compared = Type.Object(
  {
    id: Address,
    named: Type.Boolean({
      description: "False when asked only because its label depended on a named one.",
    }),
    was: Text,
    votes: Type.Array(Type.Object({ by: Text, label: Text }, { additionalProperties: false })),
    now: Type.Union([Text, Type.Null()], { description: "Null when the partial score failed." }),
  },
  { additionalProperties: false },
);

export const RunSchema = Type.Object(
  {
    format: Type.Literal(RUN_FORMAT),
    command: Type.Enum(["run", "score"]),
    dryRun: Type.Boolean(),
    dataset: Text,
    scorer: Ref,
    restFrom: Type.Optional(Ref),
    variants: Type.Array(
      Type.Object({ name: Text, version: Version }, { additionalProperties: false }),
    ),
    steps: Type.Array(
      Type.Object(
        { id: Address, variant: Text, case: Text, trial: TrialStep, score: ScoreStep },
        { additionalProperties: false },
      ),
    ),
    estimate: Type.Object(
      {
        trials: Count,
        scores: Count,
        usd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], {
          description: "At list prices, from earlier runs; null with none to estimate from.",
        }),
      },
      { additionalProperties: false },
    ),
    outcome: Type.Optional(
      Type.Object(
        {
          exitCode: Type.Integer(),
          listPrice: Type.Number({
            minimum: 0,
            description: "USD at list prices, estimated: not a bill.",
          }),
          stopped: Type.Boolean({ description: "The budget stopped it." }),
        },
        { additionalProperties: false },
      ),
    ),
    compared: Type.Optional(
      Type.Array(Compared, {
        description: "Chosen findings: the rest-from label beside the new one.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "What awf-lab run and score print with --json: the plan, and with no --dry-run, what became of it.",
  },
);

const Spend = Type.Object(
  {
    runs: Count,
    ms: Count,
    estimate: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    complete: Type.Boolean(),
  },
  { additionalProperties: false },
);

const Tally = Type.Object({ total: Count, hit: Count }, { additionalProperties: false });

const Column = Type.Object(
  {
    name: Text,
    version: Version,
    commit: Type.Union([Text, Type.Null()], { description: "The variant file's repository." }),
    scorer: Text,
    cases: Type.Array(
      Type.Object(
        {
          id: Address,
          trial: Type.String({ minLength: 1, description: "The trial's id." }),
          findings: Count,
          weightedRecall: Ratio,
          precision: Ratio,
          labels: Type.Record(Type.String(), Count),
        },
        { additionalProperties: false },
      ),
      {
        description:
          "The trials counted, each with a passing score: every trial asked for of each case counted, addressed {case}/{trial} past one a case.",
      },
    ),
    tunedOn: Type.Array(Address, {
      description: "Cases counted that the variant was tuned on, by its tunedOn: not holdout.",
    }),
    missing: Type.Array(Type.Object({ id: Address, why: Text }, { additionalProperties: false }), {
      description: "Selected cases not counted, and why; never guessed.",
    }),
    failedTrials: Type.Array(Address, { description: "Cases whose trial did not succeed." }),
    recall: Type.Object(Object.fromEntries(SEVERITIES.map((s) => [s, Ratio])), {
      additionalProperties: false,
    }),
    weightedRecall: Ratio,
    distinct: Count,
    precision: Ratio,
    wrong: Ratio,
    noise: Ratio,
    nits: Ratio,
    words: Count,
    labels: Type.Record(Type.String(), Count),
    bySeverity: Type.Record(Type.String(), Tally, {
      description: "Issues the change caused and those hit, by severity: recall's counts.",
    }),
    context: Tally,
    byCategory: Type.Record(Type.String(), Tally),
    bySource: Type.Record(Type.String(), Tally),
    missed: Type.Array(
      Type.Object({ id: Address, issue: Text, mechanism: Text }, { additionalProperties: false }),
      { description: "Every must-fix the change caused that no finding hit." },
    ),
    agreement: Type.Union([Type.Number(), Type.Null()], {
      description: "Mean κ between the scorer's two voters over the cases counted.",
    }),
    restoreMs: Count,
    trial: Spend,
    score: Spend,
  },
  { additionalProperties: false },
);

export const ReportSchema = Type.Object(
  {
    format: Type.Literal(REPORT_FORMAT),
    dataset: Text,
    trials: Type.Integer({
      minimum: 1,
      description: "Trials a case: a case counts once that many are run and scored.",
    }),
    scorers: Type.Array(Ref, { minItems: 1, maxItems: 2 }),
    baseline: Type.Optional(Ref),
    keyRevisions: Type.Array(Type.Integer({ minimum: 1 }), {
      description: "The key revisions scored against: each case's current one.",
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
    where: Type.Optional(
      Type.Array(Text, { description: "The --where predicates that chose the cases." }),
    ),
    budgetBasis: Type.Literal("list-price", {
      description: "Costs are list-price estimates, also for runs on a subscription.",
    }),
    columns: Type.Array(Column, {
      minItems: 1,
      description:
        "A column per variant, or per variant and scorer with two scorers, over the cases every column counts.",
    }),
    leftOut: Type.Optional(
      Type.Array(Type.Object({ variant: Text, scorer: Text }, { additionalProperties: false }), {
        description:
          "Columns that count no case, left out so the others still compare over cases in common.",
      }),
    ),
    comparison: Type.Optional(
      Type.Object(
        {
          baseline: Text,
          rule: Type.Optional({
            ...Ref,
            description: "The comparison that gave each verdict: its name and version.",
          }),
          noVerdict: Type.Optional(
            Type.String({
              minLength: 1,
              description: "Why this report gives no verdict, as when --where picked its cases.",
            }),
          ),
          cases: Type.Array(Text, { description: "The case ids every column counts." }),
          against: Type.Array(
            Type.Object(
              {
                variant: Text,
                won: Type.Array(Address),
                lost: Type.Array(Address),
                tied: Type.Array(Address),
                verdict: Type.Optional(VerdictSchema),
              },
              { additionalProperties: false },
            ),
            {
              description:
                "Each variant against the baseline: cases won, lost and tied by weighted recall, whatever the comparison, as --where lost reads them; then the comparison's verdict.",
            },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    agreement: Type.Optional(
      Type.Array(
        Type.Object(
          {
            variant: Text,
            findings: Count,
            kappa: Ratio,
            differ: Type.Array(
              Type.Object(
                { id: Address, labels: Type.Array(Text, { minItems: 2, maxItems: 2 }) },
                { additionalProperties: false },
              ),
              { description: "Findings the two scorers label differently, in --scorer order." },
            ),
          },
          { additionalProperties: false },
        ),
        { description: "With two scorers: how alike they label the same findings, per variant." },
      ),
    ),
  },
  {
    additionalProperties: false,
    description: "What awf-lab report prints with --json.",
  },
);

const Vote = Type.Object(
  { by: Text, role: Text, label: FindingLabelSchema },
  { additionalProperties: false },
);

export const ShowSchema = Type.Object(
  {
    format: Type.Literal(SHOW_FORMAT),
    id: Address,
    dataset: Text,
    variant: Ref,
    case: Type.Object(
      {
        id: Text,
        digest: Text,
        dir: Text,
        title: Type.String({ description: "The request's first line." }),
        key: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            procedure: Text,
            issues: Type.Array(
              Type.Object(
                { id: Text, severity: Text, category: Text, scope: Text, mechanism: Text },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    trial: Type.Union([
      Type.Null(),
      Type.Object(
        {
          id: Address,
          trial: Text,
          at: Text,
          run: Run,
          runDir: Type.Union([Text, Type.Null()], {
            description: "Null once the run directory is gone.",
          }),
          failure: Type.Optional(Text),
          findings: Count,
        },
        { additionalProperties: false },
      ),
    ]),
    scores: Type.Array(
      Type.Object(
        {
          scorer: Ref,
          status: Type.Enum(["scored", "partial", "failed", "none"], {
            description: "partial: no whole score, so the latest partial one, labelling `asked`.",
          }),
          asked: Type.Optional(Type.Array(Count)),
          restFrom: Type.Optional(Ref),
          at: Type.Optional(Text),
          reason: Type.Optional(Text),
          problems: Type.Optional(Type.Array(Type.String())),
          agreement: Type.Optional(Type.Number()),
          missed: Type.Optional(Type.String()),
          run: Type.Optional(Run),
          runDir: Type.Optional(Type.Union([Text, Type.Null()])),
        },
        { additionalProperties: false },
      ),
      { description: "Each --scorer's latest score of the trial on the current key." },
    ),
    findings: Type.Array(
      Type.Object(
        {
          id: Address,
          text: Type.String(),
          path: Type.Optional(Text),
          line: Type.Optional(Type.Integer({ minimum: 1 })),
          severity: Type.Optional(Type.String()),
          labels: Type.Array(
            Type.Object(
              {
                scorer: Text,
                category: Text,
                label: FindingLabelSchema,
                issue: Type.Optional(
                  Type.Object({ id: Text, mechanism: Text }, { additionalProperties: false }),
                ),
                votes: Type.Array(Vote),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    additionalProperties: false,
    description: "What awf-lab show prints with --json: one case, trial or finding in full.",
  },
);

export const SchemasSchema = Type.Object(
  {
    format: Type.Literal(SCHEMAS_FORMAT),
    schemas: Type.Array(
      Type.Object(
        { name: Text, title: Text, format: Type.Optional(Text) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, description: "What awf-lab schema prints with --json." },
);

export type ListDocument = Type.Static<typeof ListSchema>;
export type RunDocument = Type.Static<typeof RunSchema>;
export type ReportDocument = Type.Static<typeof ReportSchema>;
export type ReportColumn = Type.Static<typeof Column>;
export type ShowDocument = Type.Static<typeof ShowSchema>;
export type SchemasDocument = Type.Static<typeof SchemasSchema>;
export type ComparedFinding = Type.Static<typeof Compared>;
