import { acceptAny, type SemanticCheck } from "@agentswf/contract";
import type { CallSpec } from "@agentswf/contract/records";
import type { GivenInput } from "@agentswf/contract/wire";
import { checkGiven, readGiven } from "./simple-input";

export type CandidateEvaluation =
  | { kind: "accepted"; value: unknown }
  | { kind: "rejected"; error: string };

/**
 * A result as `wf` sent it, validated without repairing or persisting; the result-slot transition
 * owns acceptance.
 */
export async function evaluateGiven(
  call: Pick<CallSpec, "question" | "schema">,
  given: GivenInput,
  semantic: SemanticCheck = acceptAny,
): Promise<CandidateEvaluation> {
  const read = readGiven(call.schema, given);
  if (!read.ok) {
    const advice =
      given.raw === undefined
        ? ""
        : "\nsend one JSON value in a quoted heredoc, as the request shows.";
    return { kind: "rejected", error: `${read.error}${advice}` };
  }
  const value = read.value;
  const invalid = call.schema ? checkGiven(call.schema, given, value) : undefined;
  if (invalid) return { kind: "rejected", error: invalid };

  const verdict = await semantic({ question: call.question, value: structuredClone(value) });
  return verdict.kind === "accepted"
    ? { kind: "accepted", value }
    : {
        kind: "rejected",
        error: `the value does not answer what was asked: ${verdict.reason}`,
      };
}
