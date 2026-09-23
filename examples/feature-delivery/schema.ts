import Type from "typebox";
import { outputSchema } from "../output-schema";

export const WORK_UPDATE_SCHEMA = outputSchema(
  Type.Object(
    {
      docPath: Type.String(),
      summary: Type.String(),
      decisions: Type.Array(Type.String()),
    },
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
