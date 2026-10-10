import type { RuntimeSelection } from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

export type Role = "planner" | "implementer" | "reviewer";
export type AdditionalReviewer = { name: string; runtime: RuntimeSelection };

export type FeatureArgs = {
  ticket: string;
  runtimes: Record<Role, RuntimeSelection>;
  additionalReviewers?: AdditionalReviewer[];
  /** Revisions a review allows before the run stops; 3 when left out. */
  maxRevisions?: number;
};

/** An author's account of the work: the ticket doc it keeps, and what it did. */
export const WORK = outputSchema(
  Type.Object(
    {
      docPath: Type.String(),
      summary: Type.String(),
      decisions: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
);

/** A review stage's value: the work as approved, and the reviewer's summary of it. */
export const REVIEWED = outputSchema(
  Type.Object({ summary: Type.String(), work: WORK }, { additionalProperties: false }),
);

export const VERDICT = outputSchema(
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

const ADDITIONAL_REVIEW = Type.Union([
  Type.Object(
    { reviewer: Type.String(), kind: Type.Literal("ready"), summary: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      reviewer: Type.String(),
      kind: Type.Literal("changes-requested"),
      feedback: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

/** The additional reviews, and the work as finally approved after their feedback. */
export const ADDITIONAL = outputSchema(
  Type.Object(
    { final: REVIEWED, additional: Type.Array(ADDITIONAL_REVIEW) },
    { additionalProperties: false },
  ),
);

export type WorkUpdate = Type.Static<typeof WORK>;
export type Reviewed = Type.Static<typeof REVIEWED>;
export type AdditionalReview = Type.Static<typeof ADDITIONAL_REVIEW>;

export type Handoff = {
  docPath: string;
  summary: string;
  decisions: string[];
  review: { primary: string; additional: AdditionalReview[] };
};
