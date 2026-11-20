import Type from "typebox";
import { checkSchema, describeProblems, explainProblems } from "../../shared/validate";
import { type GraderEntry, GraderEntrySchema } from "../format/records";

/** What a grader returns: its entry's verdict, numbers, reasons, parts and notApplies. */
const AnswerSchema = Type.Object(
  {
    verdict: Type.Optional(Type.Index(GraderEntrySchema, ["verdict"])),
    numbers: Type.Optional(Type.Index(GraderEntrySchema, ["numbers"])),
    reasons: Type.Optional(Type.Index(GraderEntrySchema, ["reasons"])),
    parts: Type.Optional(Type.Index(GraderEntrySchema, ["parts"])),
    notApplies: Type.Optional(Type.Index(GraderEntrySchema, ["notApplies"])),
  },
  { additionalProperties: false },
);

export type Answer = Pick<GraderEntry, "verdict" | "numbers" | "parts" | "notApplies"> & {
  reasons: GraderEntry["reasons"];
};

/**
 * A grader's answer, checked: a verdict or numbers, or `notApplies` alone. Throws grading's error,
 * naming the grader, otherwise.
 */
export function checkAnswer(name: string, raw: unknown): Answer {
  const value = raw ?? {};
  const checked = checkSchema(AnswerSchema, value);
  if (!checked.ok) {
    const problems = explainProblems(checked.problems, {
      schema: AnswerSchema,
      value,
      noun: "an answer",
    });
    throw new Error(describeProblems(`grader ${name}'s answer`, problems));
  }
  const grade = checked.value;
  const judged = grade.verdict !== undefined || grade.numbers !== undefined;
  if (!judged && grade.notApplies === undefined) {
    throw new Error(
      `grader ${name} gave no verdict, numbers or notApplies: did grade return its answer?`,
    );
  }
  if (judged && grade.notApplies !== undefined) {
    throw new Error(`grader ${name} gave notApplies with a verdict or numbers: one or the other`);
  }
  return { ...grade, reasons: grade.reasons ?? [] };
}
