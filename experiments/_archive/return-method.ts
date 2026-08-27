import { acceptResult } from "./deps";
import { describe, type JsonSchema } from "./deps";
import { acceptAny, type SemanticCheck } from "./deps";
import { readAccepted, readAttempts, writeCall, type CallSpec } from "./deps";
import type { ReturnMethod } from "./deps";

/**
 * What E2 recorded beside a call: which of the three channels it used, and where `write-a-file`
 * expected the value. The engine's `CallSpec` carries neither — production settles through one
 * channel — so the extra fields ride along here.
 */
export type E2CallSpec = CallSpec & { method: ReturnMethod; filePath?: string };

export async function writeE2Call(runDir: string, spec: E2CallSpec): Promise<void> {
  await writeCall(runDir, spec);
}

export const RESULT_START = "<<<WF_RESULT";
export const RESULT_END = "WF_RESULT>>>";

export type MethodContext = {
  runDir: string;
  callId: string;
  /** Where `write-a-file` expects the value. Ignored by the other two methods. */
  filePath: string;
  schema?: JsonSchema;
};

/** Appended to the task prompt. Short on purpose: E2 measures compliance, not comprehension. */
export function instructions(method: ReturnMethod, context: MethodContext): string {
  const shape = context.schema
    ? `The value must match this shape: ${describe(context.schema)}`
    : "The value must be a single JSON value.";

  switch (method) {
    case "cli-callback":
      return [
        "When you have the answer, hand it back by running exactly:",
        "",
        "  wf result '<json>'",
        "",
        shape,
        "If wf exits nonzero it prints what was wrong with the value. Fix it and run wf again.",
        "Reporting the answer any other way does not count.",
      ].join("\n");
    case "write-a-file":
      return [
        `When you have the answer, write it to this exact path, overwriting anything there:`,
        "",
        `  ${context.filePath}`,
        "",
        `${shape} The file must contain that value and nothing else.`,
        "Reporting the answer any other way does not count.",
      ].join("\n");
    case "delimited-line":
      return [
        "When you have the answer, print it on its own line between these two marker lines:",
        "",
        `  ${RESULT_START}`,
        `  <json>`,
        `  ${RESULT_END}`,
        "",
        shape,
        "Reporting the answer any other way does not count.",
      ].join("\n");
  }
}

/** One line. The agent still holds the whole task, so nothing about it is restated. */
export function nudge(method: ReturnMethod, context: MethodContext, error?: string): string {
  const channel: Record<ReturnMethod, string> = {
    "cli-callback": `run  wf result '<json>'`,
    "write-a-file": `write the JSON value to ${context.filePath}`,
    "delimited-line": `print the JSON value between ${RESULT_START} and ${RESULT_END}`,
  };
  if (error) {
    return `The value you reported was rejected:\n${error}\nCorrect it and ${channel[method]} again.`;
  }
  return `You finished without reporting the result. Do it now: ${channel[method]}. Nothing else.`;
}

export type Collected =
  | { kind: "value"; value: unknown }
  | { kind: "malformed"; error: string }
  | { kind: "absent" };

/**
 * Looks for the value on the method's channel. `absent` means the agent never tried;
 * `malformed` means it tried and the result layer refused — the two are different outcomes
 * for E2 and must not be collapsed.
 */
export async function collect(
  method: ReturnMethod,
  context: MethodContext,
  transcript: string | null,
  semantic: SemanticCheck = acceptAny,
): Promise<Collected> {
  const accepted = await readAccepted(context.runDir, context.callId);
  if (accepted) return { kind: "value", value: accepted.value };

  if (method === "cli-callback") {
    // `wf` already ran the result layer in the agent's own process; nothing to re-check here.
    const attempts = await readAttempts(context.runDir, context.callId);
    const last = attempts.at(-1);
    return last ? { kind: "malformed", error: last.error ?? "rejected" } : { kind: "absent" };
  }

  const raw = method === "write-a-file" ? await readFile(context.filePath) : extract(transcript);
  if (raw === null) return { kind: "absent" };

  const outcome = await acceptResult(context.runDir, context.callId, raw, method, semantic);
  return outcome.kind === "accepted"
    ? { kind: "value", value: outcome.value }
    : { kind: "malformed", error: outcome.error };
}

async function readFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = (await file.text()).trim();
  return text === "" ? null : text;
}

/** The last marked block wins: a nudged turn appends its correction after the bad one. */
function extract(transcript: string | null): string | null {
  if (!transcript) return null;
  const start = transcript.lastIndexOf(RESULT_START);
  if (start === -1) return null;
  const from = start + RESULT_START.length;
  const end = transcript.indexOf(RESULT_END, from);
  if (end === -1) return null;
  const body = transcript.slice(from, end).trim();
  return body === "" ? null : body;
}
