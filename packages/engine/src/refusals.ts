import { ClientError, type ClientErrorCode } from "@agentswf/contract/client";
import type { RefusalCode, RefusalJson } from "@agentswf/contract/records";
import type { ParticipantCode } from "@agentswf/contract/wire";
import { EmitError } from "./emit";
import { messageOf } from "./errors";
import { EngineRefused } from "./project-engine";
import { RunNotFound } from "./run-state";
import { RunUnreadable } from "./runs";
import { WorkflowFileError } from "./workflow-loader";

/**
 * The codes only a command prints: a program's call has no argv and reads no run's socket, and
 * `internal-error` is the command's word for an error with no code, which the client throws as it
 * is.
 */
const COMMAND_ONLY = new Set<RefusalCode>([
  "usage",
  "ambiguous",
  "not-started",
  "unreachable",
  "internal-error",
] satisfies Exclude<RefusalCode, ClientErrorCode>[]);

/**
 * The code an engine error is refused with, by a `--json` command and as a `ClientError` alike, so
 * the two can't drift; none for an error that isn't the caller's.
 */
export function refusalCode(error: unknown): RefusalCode | undefined {
  if (error instanceof EmitError || error instanceof EngineRefused) return error.code;
  if (error instanceof RunNotFound || error instanceof WorkflowFileError) return error.code;
  if (error instanceof RunUnreadable) return "unreachable";
  return undefined;
}

/** An engine error that is the caller's mistake as a `ClientError`; anything else as it is. */
export function asClientError(error: unknown, ref?: string): unknown {
  const code = refusalCode(error);
  if (code === undefined || COMMAND_ONLY.has(code)) return error;
  return new ClientError(code as ClientErrorCode, messageOf(error), ref);
}

/**
 * A failure as a `--json` command prints it: the sentence on stderr, for people, and with `json`
 * the refusal as stdout's last document. The code is the error's own, as `refusalCode` gives it;
 * `otherwise` is the command's word for an error that has none. A caller's mistake never reaches a
 * host as `internal-error`: it gets an error class `refusalCode` reads. `usage` follows the
 * sentence.
 */
export function printRefusal(
  out: { stdout(text: string): void; stderr(text: string): void },
  json: { json: boolean; v: number },
  error: unknown,
  otherwise: RefusalCode | ParticipantCode,
  usage?: string,
): void {
  const sentence = messageOf(error);
  if (json.json) {
    const refusal: RefusalJson<RefusalCode | ParticipantCode> = {
      v: json.v,
      code: refusalCode(error) ?? otherwise,
      error: sentence,
    };
    out.stdout(JSON.stringify(refusal));
  }
  out.stderr(`awf: ${sentence}${usage === undefined ? "" : `\n\n${usage}`}`);
}
