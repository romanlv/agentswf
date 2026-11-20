import Type from "typebox";
import { FactSchema } from "./settings";

// The trial file: lines `defineEnv` appends, in the trial's process, to the file the lab names in
// `AWF_LAB_TRIAL`. The lab reads it whatever the run's ending, since `awf run --json` carries a
// value only for a run that completed. Written by `@agentswf/lab/cases`, read by the lab of the
// same checkout, so it has no version of its own beyond the lab's.

const PHASES = ["setup", "body", "observe", "teardown"] as const;
export type Phase = (typeof PHASES)[number];
/** What the lab checks once the run has ended (`reach`): its own, never in the trial file. */
export type Blamed = Phase | "after";

const PhaseSchema = Type.Enum(PHASES);

/** Why a trial is the dataset's to fix, by a code the report and tests can name. */
export const DATASET_ERRORS = [
  "threw",
  "timed-out",
  "refused",
  "prepare",
  "workflow-missing",
  "workflow-loaded-early",
  "events",
  "given-refused",
  "stage-missing",
  "facts-missing",
  "fact-type",
  "no-observe",
] as const;
export type DatasetError = (typeof DATASET_ERRORS)[number];

export const RefusedSchema = Type.Object(
  {
    /** `mail.delete`, `Mailbox.archive`, or `GET https://api.example.com/x`. */
    what: Type.String(),
    by: Type.Union([Type.Literal("function"), Type.Literal("host")]),
    phase: PhaseSchema,
    message: Type.String(),
  },
  { additionalProperties: false },
);
export type Refused = Type.Static<typeof RefusedSchema>;

const Facts = Type.Record(Type.String(), FactSchema);

export const TrialLineSchema = Type.Union([
  Type.Object({ phase: PhaseSchema }, { additionalProperties: false }),
  Type.Object({ refused: RefusedSchema }, { additionalProperties: false }),
  Type.Object(
    {
      error: Type.Object(
        {
          by: Type.Union([Type.Literal("dataset"), Type.Literal("workflow")]),
          phase: PhaseSchema,
          code: Type.Optional(Type.Enum(DATASET_ERRORS)),
          reason: Type.String(),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object({ timedOut: PhaseSchema }, { additionalProperties: false }),
  /** The run was cancelled, by SIGTERM or SIGINT, in this phase. */
  Type.Object({ cancelled: PhaseSchema }, { additionalProperties: false }),
  /** The process exited in this phase before the trial ended, short of the run's deadline. */
  Type.Object({ exited: PhaseSchema }, { additionalProperties: false }),
  Type.Object(
    { stopped: Type.Object({ reason: Type.String() }, { additionalProperties: false }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      workflow: Type.Object(
        { name: Type.String(), version: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      unused: Type.Array(Type.String(), {
        description: "Fakes and routes the case gave that were never called.",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      end: Type.Object(
        {
          facts: Facts,
          /** Every stage's value by name, given or live. */
          stages: Type.Record(Type.String(), Type.Unknown()),
          given: Type.Array(Type.String()),
          /** The `until` stage, reached; absent when there was none. */
          until: Type.Optional(Type.String()),
          /** Stages `stages` or `until` named that the body never entered. */
          neverReached: Type.Optional(Type.Array(Type.String())),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type TrialLine = Type.Static<typeof TrialLineSchema>;
