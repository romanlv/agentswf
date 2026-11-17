import Type from "typebox";
import { OUTCOMES } from "./records";

// What `report --json` and `score --json` print: `/0`, like the records, until task 13.

export const REPORT_KIND = "awf.case-report/0";
export const SCORED_KIND = "awf.case-scored/0";

const Text = Type.String({ minLength: 1 });
const Tally = Type.Object(
  { alike: Type.Integer({ minimum: 0 }), of: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
const Counts = Type.Record(Text, Type.Integer({ minimum: 0 }));

/** A grader's number, pooled over a column's trials: counts summed, or every value. */
const PooledSchema = Type.Union([
  Type.Object(
    { count: Type.Number({ minimum: 0 }), of: Type.Number({ minimum: 0 }) },
    { additionalProperties: false },
  ),
  Type.Object({ values: Type.Array(Type.Number()) }, { additionalProperties: false }),
]);

export const CaseReportSchema = Type.Object(
  {
    kind: Type.Literal(REPORT_KIND),
    run: Type.Integer({ minimum: 1 }),
    dataset: Text,
    partial: Type.Boolean(),
    exit: Type.Integer({ minimum: 0, maximum: 5 }),
    cases: Type.Array(
      Type.Object(
        {
          name: Text,
          verdict: Type.Union([
            Type.Enum(["passed", "failed", "flaky", "unclear"] as const),
            Type.Null(),
          ]),
          /** A case with no verdict: why. */
          none: Type.Optional(Type.Enum(["not graded", "graded by numbers"] as const)),
          passed: Type.Integer({ minimum: 0 }),
          trials: Type.Integer({ minimum: 0 }),
          knownFailing: Type.Boolean(),
          outcomes: Type.Array(Type.Enum(OUTCOMES)),
          why: Type.Optional(Type.String()),
          notes: Type.Array(Type.String()),
          history: Type.Array(Type.Enum(["passed", "failed", "flaky", "unclear"] as const)),
        },
        { additionalProperties: false },
      ),
    ),
    /** By grader, then by number, your checkout's column. */
    numbers: Type.Record(Text, Type.Record(Text, PooledSchema)),
    /** Trials the workflow failed, which gave no numbers. */
    numbersLeftOut: Type.Integer({ minimum: 0 }),
    agreement: Type.Array(
      Type.Object(
        { a: Text, b: Text, verdicts: Tally, parts: Tally },
        { additionalProperties: false },
      ),
    ),
    /** Grades `score` would make again, or why that couldn't be told. */
    stale: Type.Optional(
      Type.Union([
        Type.Integer({ minimum: 0 }),
        Type.Object({ unread: Type.String() }, { additionalProperties: false }),
      ]),
    ),
    /** With `--against`: every other column, its folder and its cases' verdicts. */
    columns: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Text,
            branch: Type.Union([Text, Type.Null()]),
            commit: Type.Union([Text, Type.Null()]),
            dirty: Type.Boolean(),
            /** Its `env.ts` is not your checkout's. */
            envDiffers: Type.Boolean(),
            numbers: Type.Record(Text, Type.Record(Text, PooledSchema)),
            numbersLeftOut: Type.Integer({ minimum: 0 }),
            cases: Type.Array(
              Type.Object(
                {
                  name: Text,
                  verdict: Type.Union([
                    Type.Enum(["passed", "failed", "flaky", "unclear"] as const),
                    Type.Null(),
                  ]),
                  passed: Type.Integer({ minimum: 0 }),
                  trials: Type.Integer({ minimum: 0 }),
                },
                { additionalProperties: false },
              ),
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    /** With `--case`: its trials, each its record and every score, newest last. */
    trials: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: false, description: "awf-lab report --json." },
);
export type CaseReport = Type.Static<typeof CaseReportSchema>;

export const ScoredSchema = Type.Object(
  {
    kind: Type.Literal(SCORED_KIND),
    plan: Type.Object(
      {
        run: Type.Integer({ minimum: 1 }),
        trials: Type.Integer({ minimum: 0 }),
        grades: Counts,
        /** Costly grades that run only if the cheaper graders regraded now pass. */
        maybe: Counts,
        estimate: Type.Optional(Type.Number({ minimum: 0 })),
        upTo: Type.Optional(Type.Number({ minimum: 0 })),
        unpriced: Type.Array(Text),
        /** Trials left because their case changed since they ran. */
        changed: Type.Array(
          Type.Object(
            { case: Text, trial: Type.Integer({ minimum: 1 }) },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    /** What was graded; absent on `--dry-run` and when the plan was empty. */
    done: Type.Optional(
      Type.Object(
        {
          graded: Counts,
          errored: Counts,
          estimate: Type.Number({ minimum: 0 }),
          stopped: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    /** The run's report after grading; absent on `--dry-run`. */
    report: Type.Optional(CaseReportSchema),
  },
  { additionalProperties: false, description: "awf-lab score --json." },
);
export type Scored = Type.Static<typeof ScoredSchema>;
