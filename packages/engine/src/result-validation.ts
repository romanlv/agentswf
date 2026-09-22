import { acceptAny, type SemanticCheck } from "@wf/contract";
import type { CallSpec } from "@wf/contract/records";
import { formatErrors, validate } from "@wf/contract/schema";

export type CandidateEvaluation =
  | { kind: "accepted"; value: unknown }
  | { kind: "rejected"; error: string };

/** Validates without repairing or persisting; the result-slot transition owns acceptance. */
export async function evaluateResult(
  call: Pick<CallSpec, "question" | "schema">,
  raw: string,
  semantic: SemanticCheck = acceptAny,
): Promise<CandidateEvaluation> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "rejected",
      error: [
        `the value is not valid JSON: ${reason}`,
        `expected: ${expectedShape(call)}`,
        "send one JSON value, quoted as a single shell argument.",
      ].join("\n"),
    };
  }

  if (call.schema) {
    const errors = validate(call.schema, value);
    if (errors.length > 0) return { kind: "rejected", error: formatErrors(errors) };
  }

  const verdict = await semantic({ question: call.question, value: structuredClone(value) });
  return verdict.kind === "accepted"
    ? { kind: "accepted", value }
    : {
        kind: "rejected",
        error: `the value does not answer what was asked: ${verdict.reason}`,
      };
}

function expectedShape(call: Pick<CallSpec, "schema">): string {
  return call.schema ? JSON.stringify(call.schema) : "any JSON value";
}

