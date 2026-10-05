#!/usr/bin/env -S bun --no-env-file
import {
  type ControlRequest,
  type ControlResponse,
  validWaitingReason,
  WIRE_VERSION,
} from "@agentswf/contract/wire";
import { submitControl } from "./client";

const usage = [
  "usage: wf result <call-id> '<json>'",
  "       wf result <call-id> < result.json",
  "       wf waiting <call-id> --reason <text> [--timeout <duration>]",
  "",
  "The call id is the one named in the request. Pass JSON as one argument; with no argument,",
  "JSON is read from standard input.",
].join("\n");
const MAX_STDIN_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 30_000;

export type CliOutcome = { exitCode: number; stdout: string; stderr: string };

export async function runCli(
  argv: readonly string[],
  stdin: string | null,
  submit: (endpoint: string, request: ControlRequest) => Promise<ControlResponse> = submitControl,
): Promise<CliOutcome> {
  // The launcher the engine installs supplies `--at`; the socket is an address, not a secret.
  const {
    endpoint,
    session,
    command: [command, ...args],
  } = launched(argv);
  if (!endpoint) {
    return usageError("wf must be run through the launcher the workflow engine installed");
  }
  if (command === "waiting") return runWaiting(endpoint, session, args, submit);
  if (command !== "result") return usageError(usage);
  const [operationId, ...rest] = args;
  if (!operationId) return usageError("wf result needs the call id it is answering");
  if (rest.length > 1) {
    return usageError("wf result takes exactly one JSON argument or standard input");
  }
  if (rest.length === 1 && stdin !== null) {
    return usageError("wf result cannot read both an argument and standard input");
  }
  if (rest.length === 0 && stdin === null) {
    return usageError("wf result needs one JSON argument or standard input");
  }
  const raw = rest[0] ?? stdin ?? "";
  if (raw.trim() === "") return usageError("wf result input cannot be empty");

  let response: ControlResponse;
  try {
    response = await submit(endpoint, {
      version: WIRE_VERSION,
      command: "result",
      operationId,
      raw,
      ...(session ? { session } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `wf: result submission failed.\n${reason}` };
  }

  if (response.kind === "rejected") {
    return { exitCode: 1, stdout: "", stderr: `wf: ${rejection(response, operationId)}` };
  }
  if (response.kind !== "accepted")
    return { exitCode: 1, stdout: "", stderr: "wf: unexpected waiting acknowledgement for result" };
  return { exitCode: 0, stdout: "wf: result accepted", stderr: "" };
}

async function runWaiting(
  endpoint: string,
  session: string | undefined,
  args: readonly string[],
  submit: (endpoint: string, request: ControlRequest) => Promise<ControlResponse>,
): Promise<CliOutcome> {
  const [operationId, ...flags] = args;
  if (!operationId?.trim() || operationId.startsWith("--"))
    return usageError("wf waiting needs the call id it is waiting on");
  const values = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i]!;
    const value = flags[i + 1];
    if ((flag !== "--reason" && flag !== "--timeout") || values.has(flag) || value === undefined)
      return usageError("wf waiting accepts --reason once and optional --timeout once");
    values.set(flag, value);
  }
  const reason = values.get("--reason");
  if (!validWaitingReason(reason))
    return usageError("wf waiting --reason must be non-blank and at most 2048 UTF-8 bytes");
  const duration = values.get("--timeout");
  let timeoutMs: number | undefined;
  if (duration !== undefined) {
    const match = /^([0-9]+)(ms|s|m|h)$/.exec(duration);
    if (!match)
      return usageError("wf waiting --timeout must be a positive integer with ms, s, m or h");
    const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!]!;
    timeoutMs = Number(match[1]) * factor;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      return usageError("wf waiting --timeout must fit a positive safe integer in milliseconds");
  }
  let response: ControlResponse;
  try {
    response = await submit(endpoint, {
      version: WIRE_VERSION,
      command: "waiting",
      operationId,
      reason,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(session ? { session } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `wf: waiting acknowledgement is uncertain; the engine may have granted the wait. No retry was sent.\n${detail}`,
    };
  }
  if (response.kind === "rejected")
    return {
      exitCode: 1,
      stdout: "",
      stderr: `wf: waiting rejected (${response.code}).\n${response.error}`,
    };
  if (response.kind !== "waiting")
    return {
      exitCode: 1,
      stdout: "",
      stderr: "wf: unexpected result acknowledgement for waiting; wait is uncertain",
    };
  return {
    exitCode: 0,
    stdout: `wf: waiting granted until ${response.waitUntil}; operation deadline ${response.deadline} (Unix milliseconds)`,
    stderr: "",
  };
}

/**
 * An agent reads this and decides whether to try again, so each case has to say what it can do
 * about it. E5 measured what that is worth: a rejection carrying the reason was corrected in 2.00
 * attempts, a bare refusal in 2.90 to 4.95.
 */
function rejection(
  response: Extract<ControlResponse, { kind: "rejected" }>,
  operationId: string,
): string {
  switch (response.code) {
    case "invalid-result":
      return (
        `result rejected.\n${response.error}\nFix the value and run wf result again. ` +
        "A long value can be written to a file and passed with < file."
      );
    case "wrong-agent":
      return `${operationId} is another agent's call, not yours to answer`;
    case "unknown-operation":
      // Correctable, unlike the two below: the id is wrong, not the call gone. Transposing the id
      // and the JSON lands here, and telling the agent to give up would end a live turn.
      return (
        `no call named ${operationId} is open. ` +
        "Check the id in the request and run wf result again."
      );
    case "expired-operation":
    case "closed-operation":
      return "that call is no longer open; the workflow engine must start a new one";
    default:
      // Everything else — too large, malformed, wrong version — is only distinguishable by what
      // the engine said, and whether a shorter or different value would be taken.
      return `result submission was rejected.\n${response.error}`;
  }
}

/**
 * The launcher supplies `--at <socket>`, then `--session <id>` expanded from the harness's own
 * variable, which is empty when the agent's shell does not set it.
 */
function launched(argv: readonly string[]): {
  endpoint?: string;
  session?: string;
  command: readonly string[];
} {
  const [flag, endpoint, ...rest] = argv;
  if (flag !== "--at" || !endpoint) return { command: rest };
  if (rest[0] !== "--session") return { endpoint, command: rest };
  const session = rest[1]?.trim();
  return { endpoint, ...(session ? { session } : {}), command: rest.slice(2) };
}

function usageError(stderr: string): CliOutcome {
  return { exitCode: 2, stdout: "", stderr };
}

if (import.meta.main) {
  let stdinText: string | null;
  try {
    stdinText = await readCliStdin(
      process.argv.slice(2),
      process.stdin.isTTY === true,
      Bun.stdin.stream(),
    );
  } catch (error) {
    console.error(`wf result: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const outcome = await runCli(process.argv.slice(2), stdinText);
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exit(outcome.exitCode);
}

export async function readCliStdin(
  argv: readonly string[],
  isTTY: boolean,
  stream: ReadableStream<Uint8Array>,
): Promise<string | null> {
  // `result <call-id>` and nothing more: the value is coming from standard input.
  const { command } = launched(argv);
  if (isTTY || command[0] !== "result" || command.length !== 2) return null;
  const text = await readBoundedStdin(stream);
  return text === "" ? null : text;
}

/**
 * Bounded in time as well as size. Everything else on this path has a deadline — the client waits
 * 30s, the control plane 30s — and a tool runner that hands the child an inherited pipe instead of
 * `/dev/null` would otherwise stall the agent's whole turn on a read that never ends.
 */
export async function readBoundedStdin(
  stream: ReadableStream<Uint8Array>,
  maxBytes = MAX_STDIN_BYTES,
  timeoutMs = STDIN_TIMEOUT_MS,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let expire!: () => void;
  const expired = new Promise<"expired">((resolve) => {
    expire = () => resolve("expired");
  });
  const expiry = setTimeout(expire, timeoutMs);
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === "expired") {
        await reader.cancel().catch(() => undefined);
        throw new Error("stdin was not closed in time");
      }
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("stdin exceeds the size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(expiry);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
