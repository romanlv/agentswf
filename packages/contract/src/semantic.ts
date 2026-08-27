/**
 * The seam for the optional semantic check: does the value actually answer what was asked,
 * as opposed to merely matching the schema. Nothing here calls a model. A small-model call
 * is dropped in by passing a different `SemanticCheck` to the result layer; the engine and
 * the CLI never change.
 */
export type SemanticVerdict = { kind: "accepted" } | { kind: "rejected"; reason: string };

export type SemanticCheck = (input: {
  /** What the step asked for, recorded with the call so the checker sees it without the prompt. */
  question: string;
  value: unknown;
}) => Promise<SemanticVerdict>;

export const acceptAny: SemanticCheck = async () => ({ kind: "accepted" });
