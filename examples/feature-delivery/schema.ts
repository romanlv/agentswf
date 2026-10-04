import Type from "typebox";
import { outputSchema } from "../output-schema";

const WORK_UPDATE = Type.Object(
  {
    docPath: Type.String(),
    summary: Type.String(),
    decisions: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export const WORK_UPDATE_SCHEMA = outputSchema(WORK_UPDATE);

/** A review stage's value: the work as approved, and the reviewer's summary of it. */
const REVIEWED = Type.Object(
  { summary: Type.String(), work: WORK_UPDATE },
  { additionalProperties: false },
);
export const REVIEWED_SCHEMA = outputSchema(REVIEWED);

const COMPLETED_ADDITIONAL_REVIEW = Type.Union([
  Type.Object(
    { reviewer: Type.String(), kind: Type.Literal("ready"), summary: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      reviewer: Type.String(),
      kind: Type.Literal("changes-addressed"),
      feedback: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

/** The additional reviews, and the work as finally approved after their feedback. */
export const ADDITIONAL_SCHEMA = outputSchema(
  Type.Object(
    { final: REVIEWED, additional: Type.Array(COMPLETED_ADDITIONAL_REVIEW) },
    { additionalProperties: false },
  ),
);

export const REVIEW_VERDICT_SCHEMA = outputSchema(
  Type.Union([
    Type.Object(
      { kind: Type.Literal("ready"), summary: Type.String() },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("changes-requested"),
        feedback: Type.Array(Type.String(), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { kind: Type.Literal("inconclusive"), reason: Type.String() },
      { additionalProperties: false },
    ),
  ]),
);

export type WorkUpdate = Type.Static<typeof WORK_UPDATE_SCHEMA>;
export type ReviewVerdict = Type.Static<typeof REVIEW_VERDICT_SCHEMA>;
export type Reviewed = Type.Static<typeof REVIEWED_SCHEMA>;
export type CompletedAdditionalReview = Type.Static<typeof COMPLETED_ADDITIONAL_REVIEW>;
