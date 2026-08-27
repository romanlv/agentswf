import { formatErrors, validate } from "@wf/contract/schema";
import { acceptAny, type SemanticCheck } from "@wf/contract";
import type { AttemptSource, CallSpec } from "@wf/contract/records";
import { readCall, recordAttempt, writeAccepted } from "./run-dir";

export type Acceptance =
  | { kind: "accepted"; value: unknown }
  | { kind: "rejected"; error: string };

/**
 * The one place a candidate value becomes a result, whichever channel carried it. It parses,
 * validates against the schema recorded for the call, runs the semantic seam, and records the
 * attempt either way. It never repairs a value: a near-miss is a rejection the agent corrects,
 * not something the engine quietly fixes up.
 */
export async function acceptResult(
  runDir: string,
  callId: string,
  raw: string,
  source: AttemptSource,
  semantic: SemanticCheck = acceptAny,
): Promise<Acceptance> {
  const call = await readCall(runDir, callId);
  if (!call) {
    return { kind: "rejected", error: `no call ${callId} is recorded in ${runDir}` };
  }

  const rejected = async (error: string): Promise<Acceptance> => {
    await recordAttempt(runDir, callId, {
      at: new Date().toISOString(),
      source,
      accepted: false,
      raw,
      error,
    });
    return { kind: "rejected", error };
  };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return rejected(
      [
        `the value is not valid JSON: ${reason}`,
        `expected: ${expectedShape(call)}`,
        "send one JSON value, quoted as a single shell argument.",
      ].join("\n"),
    );
  }

  if (call.schema) {
    const errors = validate(call.schema, value);
    if (errors.length > 0) return rejected(formatErrors(errors));
  }

  const verdict = await semantic({ question: call.question, value });
  if (verdict.kind === "rejected") {
    return rejected(`the value does not answer what was asked: ${verdict.reason}`);
  }

  await recordAttempt(runDir, callId, {
    at: new Date().toISOString(),
    source,
    accepted: true,
    raw,
  });
  await writeAccepted(runDir, callId, value);
  return { kind: "accepted", value };
}

function expectedShape(call: CallSpec): string {
  if (!call.schema) return "any JSON value";
  return JSON.stringify(call.schema);
}
