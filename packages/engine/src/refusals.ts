import { ClientError, type ClientErrorCode } from "@agentswf/contract/client";
import { REFUSAL_CODES, type RefusalCode, type RefusalJson } from "@agentswf/contract/records";
import type { ParticipantCode } from "@agentswf/contract/wire";
import { EmitError } from "./emit";
import { messageOf } from "./errors";
import { EngineRefused } from "./project-engine";
import { RunNotFound } from "./run-state";
import { isSystemError, RunUnreachable } from "./run-unreachable";
import { RunRefused } from "./runs";
import { WorkflowFileError } from "./workflow-loader";

/**
 * The codes only a command prints: a program's call has no argv and reads no run's socket, and
 * `internal-error` is the command's word for an error with no code, which the client throws as it
 * is.
 */
const COMMAND_ONLY = new Set<RefusalCode>(
  Object.keys({
    usage: true,
    ambiguous: true,
    "not-started": true,
    unreachable: true,
    "internal-error": true,
    "no-session": true,
    live: true,
    opened: true,
    // Every code a client doesn't throw, so a new one is either a client's or listed here.
  } satisfies Record<Exclude<RefusalCode, ClientErrorCode>, true>) as RefusalCode[],
);

/**
 * The code an engine error is refused with, by a `--json` command and as a `ClientError` alike, so
 * the two can't drift; none for an error that isn't the caller's.
 */
export function refusalCode(error: unknown): RefusalCode | undefined {
  if (error instanceof EmitError || error instanceof EngineRefused) return error.code;
  if (error instanceof RunNotFound || error instanceof WorkflowFileError) return error.code;
  if (error instanceof RunUnreachable) return error.code;
  if (error instanceof RunRefused) return error.code;
  return undefined;
}

/** `code` as a client's word, when it is one: what a command refused with, read back. */
export function clientCode(code: unknown): ClientErrorCode | undefined {
  const known = (REFUSAL_CODES as readonly unknown[]).includes(code);
  return known && !COMMAND_ONLY.has(code as RefusalCode) ? (code as ClientErrorCode) : undefined;
}

/**
 * A failure while reading a run: the error's own code; else a system error, a file that couldn't
 * be read, `unreachable`; else `internal-error`.
 */
export function readFailureCode(error: unknown): RefusalCode {
  const cause = error instanceof Error ? error.cause : undefined;
  return (
    refusalCode(error) ??
    (cause === undefined ? undefined : refusalCode(cause)) ??
    (isSystemError(error) ? "unreachable" : "internal-error")
  );
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
  if (json.json) out.stdout(refusalLine(json.v, refusalCode(error) ?? otherwise, sentence));
  out.stderr(`awf: ${sentence}${usage === undefined ? "" : `\n\n${usage}`}`);
}

/** A refusal as its one line on stdout, for a command whose stderr says it in its own words. */
export function refusalLine(v: number, code: RefusalCode | ParticipantCode, error: string): string {
  return JSON.stringify({ v, code, error } satisfies RefusalJson<RefusalCode | ParticipantCode>);
}

/**
 * Whether `argv` asks for `--json`, anywhere before `--`: what follows is a message's text or a
 * workflow's arguments, which can't ask for it, and a usage error counts it before any parse.
 */
export function asksJson(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).includes("--json");
}

/** No `--json`: the failure on stderr only. */
export const NO_JSON = { json: false, v: 0 };
