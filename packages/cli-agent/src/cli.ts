#!/usr/bin/env bun
import { WIRE_VERSION, type ResultSubmitRequest, type ResultSubmitResponse } from "@wf/contract/wire";
import { submitResult } from "./client";

const usage = [
  "usage: wf result '<json>'",
  "       wf result < result.json",
  "",
  "Pass JSON as one argument; with no argument, JSON is read from standard input.",
].join("\n");
const MAX_STDIN_BYTES = 1024 * 1024;

export type CliOutcome = { exitCode: number; stdout: string; stderr: string };

export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  stdin: string | null,
  submit: (endpoint: string, request: ResultSubmitRequest) => Promise<ResultSubmitResponse> =
    submitResult,
): Promise<CliOutcome> {
  const [command, ...args] = argv;
  if (command !== "result") return usageError(usage);
  if (args.length > 1) return usageError("wf result takes exactly one JSON argument or standard input");
  if (args.length === 1 && stdin !== null) {
    return usageError("wf result cannot read both an argument and standard input");
  }
  if (args.length === 0 && stdin === null) {
    return usageError("wf result needs one JSON argument or standard input");
  }
  const raw = args[0] ?? stdin ?? "";
  if (raw.trim() === "") return usageError("wf result input cannot be empty");

  const endpoint = env.WF_ENDPOINT;
  const operationId = env.WF_OPERATION;
  const capability = env.WF_CAPABILITY;
  if (!endpoint || !operationId || !capability) {
    return usageError(
      "wf: WF_ENDPOINT, WF_OPERATION, and WF_CAPABILITY must be set by the workflow engine",
    );
  }

  let response: ResultSubmitResponse;
  try {
    response = await submit(endpoint, {
      version: WIRE_VERSION,
      operationId,
      capability,
      raw,
    });
  } catch (error) {
    const reason = protect(
      error instanceof Error ? error.message : String(error),
      [operationId, capability],
    );
    return { exitCode: 1, stdout: "", stderr: `wf: result submission failed.\n${reason}` };
  }

  if (response.kind === "rejected") {
    if (response.code === "invalid-result") {
      const error = protect(response.error, [operationId, capability]);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `wf: result rejected.\n${error}\nFix the value and run wf result again.`,
      };
    }
    if (["unknown-capability", "wrong-operation", "expired-capability", "closed-capability"].includes(response.code)) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "wf: result binding is no longer valid; the workflow engine must start a new operation",
      };
    }
    if (response.code === "internal-error") {
      return { exitCode: 1, stdout: "", stderr: "wf: result submission failed internally" };
    }
    return { exitCode: 1, stdout: "", stderr: "wf: result submission protocol was rejected" };
  }
  return { exitCode: 0, stdout: "wf: result accepted", stderr: "" };
}

function usageError(stderr: string): CliOutcome {
  return { exitCode: 2, stdout: "", stderr };
}

function protect(text: string, authorities: readonly string[]): string {
  const decodedEscapes = text
    .replace(/\\u([0-9a-f]{4})/gi, (_match, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/gi, (_match, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 16)),
    );
  return authorities.some((authority) => text.includes(authority) || decodedEscapes.includes(authority))
    ? "submission failed without safe diagnostic detail"
    : text;
}

if (import.meta.main) {
  let stdinText: string | null;
  try {
    stdinText = await readCliStdin(
      process.argv.slice(2),
      process.stdin.isTTY === true,
      Bun.stdin.stream(),
    );
  } catch {
    console.error("wf result input exceeds the size limit");
    process.exit(2);
  }
  const stdin = stdinText === "" ? null : stdinText;
  const outcome = await runCli(process.argv.slice(2), process.env, stdin);
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exit(outcome.exitCode);
}

export async function readCliStdin(
  argv: readonly string[],
  isTTY: boolean,
  stream: ReadableStream<Uint8Array>,
): Promise<string | null> {
  if (isTTY || argv[0] !== "result" || argv.length !== 1) return null;
  const text = await readBoundedStdin(stream);
  return text === "" ? null : text;
}

export async function readBoundedStdin(
  stream: ReadableStream<Uint8Array>,
  maxBytes = MAX_STDIN_BYTES,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      await stream.cancel().catch(() => undefined);
      throw new Error("stdin exceeds the size limit");
    }
    chunks.push(chunk);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
