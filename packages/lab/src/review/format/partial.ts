import Type from "typebox";
import { ScoreRecordSchema } from "./scoring";

// Apart from `scoring.ts` and `validate.ts`, which every judge imports. It shares the score
// record's fields, so a change to those changes this format too: bump both.

export const PARTIAL_FORMAT = "awf.review-partial/1";

const { format: _format, ...scoreFields } = ScoreRecordSchema.properties;

/**
 * A first-version partial score, beside the findings: a judge's labels for some of a
 * review's findings, `asked`, with another judging's labels kept for the rest (`base`). Its
 * judgement is whole, the base's labels in place, and it passes the same check as any judging;
 * `plan` and `report` never read it, so it is never a score.
 */
export const PartialRecordSchema = Type.Object(
  {
    format: Type.Literal(PARTIAL_FORMAT),
    ...scoreFields,
    picked: Type.Array(Type.Integer({ minimum: 0 }), {
      minItems: 1,
      description: "The findings named, by index, ascending.",
    }),
    asked: Type.Array(Type.Integer({ minimum: 0 }), {
      minItems: 1,
      description:
        "The findings the judge labelled, ascending: the picked ones and the base labels that depend on them.",
    }),
    base: Type.Object(
      {
        judge: ScoreRecordSchema.properties.judge,
        at: Type.String({ minLength: 1, description: "The base judging's `at`." }),
        digest: Type.String({
          pattern: "^sha256:[0-9a-f]{64}$",
          description: "SHA-256 of the base judging's record as canonical JSON: which one it is.",
        }),
      },
      {
        additionalProperties: false,
        description: "The judging whose labels the other findings kept.",
      },
    ),
  },
  {
    additionalProperties: false,
    description: "A judging of chosen findings of one review, the rest kept from another judging.",
  },
);

export type PartialRecord = Type.Static<typeof PartialRecordSchema>;
