#!/usr/bin/env bun
import {
  WIRE_VERSION,
  type ResultSubmitRequest,
  type ResultSubmitResponse,
} from "@wf/contract/wire";
import { submitResult } from "./client";

const usage = [
  "usage: wf result <call-id> '<json>'",
  "       wf result <call-id> < result.json",
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
  submit: (endpoint: string, request: ResultSubmitRequest) => Promise<ResultSubmitResponse> =
    submitResult,
): Promise<CliOutcome> {
  // The launcher the engine installs supplies `--at`; the socket is an address, not a secret.
  const [flag, endpoint, command, ...args] = argv;
  if (flag !== "--at" || !endpoint) {
    return usageError("wf must be run through the launcher the workflow engine installed");
  }
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

  let response: ResultSubmitResponse;
  try {
    response = await submit(endpoint, { version: WIRE_VERSION, operationId, raw });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `wf: result submission failed.\n${reason}` };
  }

  if (response.kind === "rejected") {
    return { exitCode: 1, stdout: "", stderr: `wf: ${rejection(response, operationId)}` };
  }
  return { exitCode: 0, stdout: "wf: result accepted", stderr: "" };
}

/**
 * An agent reads this and decides whether to try again, so each case has to say what it can do
 * about it. E5 measured what that is worth: a rejection carrying the reason was corrected in 2.00
 * attempts, a bare refusal in 2.90 to 4.95.
 */
function rejection(
  response: Extract<ResultSubmitResponse, { kind: "rejected" }>,
  operationId: string,
): string {
  switch (response.code) {
    case "invalid-result":
      return `result rejected.\n${response.error}\nFix the value and run wf result again.`;
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
  // `--at <socket> result <call-id>` and nothing more: the value is coming from standard input.
  if (isTTY || argv[2] !== "result" || argv.length !== 4) return null;
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
