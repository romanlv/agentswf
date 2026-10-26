#!/usr/bin/env -S bun --no-env-file
import {
  type ControlRequest,
  type ControlResponse,
  type MessageRequest,
  validWaitingReason,
  WIRE_VERSION,
} from "@agentswf/contract/wire";
import { NotSentError, submitControl } from "./client";

/** `wf` is its launcher's full path, as an agent must type it; `wf` alone when it is not known. */
function usage(wf: string): string {
  return [
    `usage: ${wf} result <call-id> --<name> '<value>' ...`,
    `       ${wf} result <call-id> <<'WF_JSON'`,
    "       <json>",
    "       WF_JSON",
    `       ${wf} waiting <call-id> --reason <text> [--timeout <duration>]`,
    `       ${wf} peers [--json]`,
    ...messageUsage(wf, "       "),
    "",
    "The call id is the one named in the request. Give the result as the flags the request names,",
    "each value in single quotes, or as JSON on standard input, as a quoted heredoc.",
  ].join("\n");
}

function messageUsage(wf: string, indent = "usage: "): string[] {
  return [
    `${indent}${wf} send [--await-reply [--timeout <duration>]] <peer> <<'EOF'`,
    "       <message>",
    "       EOF",
    `       ${wf} reply [--await-reply [--timeout <duration>]] <peer> <<'EOF'`,
    "       <answer>",
    "       EOF",
    "",
    "Flags go before the message. The message comes from a quoted heredoc, standard input or one",
    "final argument; given an argument, standard input is not read. One that starts with -- goes",
    "in a heredoc.",
  ];
}
const MAX_STDIN_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 30_000;

export type CliOutcome = { exitCode: number; stdout: string; stderr: string };

type Submit = (endpoint: string, request: ControlRequest) => Promise<ControlResponse>;

export async function runCli(
  argv: readonly string[],
  stdin: string | null,
  submit: Submit = submitControl,
): Promise<CliOutcome> {
  // The launcher the engine installs supplies `--at`; the socket is an address, not a secret.
  const {
    endpoint,
    session,
    launcher,
    command: [command, ...args],
  } = launched(argv);
  const wf = launcher ?? "wf";
  if (!endpoint) {
    return usageError("wf must be run through the launcher the workflow engine installed");
  }
  switch (command) {
    case "waiting":
      return runWaiting(endpoint, session, args, submit);
    case "result":
      return runResult(endpoint, session, args, stdin, submit);
    case "peers":
      return runPeers(endpoint, session, args, submit);
    case "send":
    case "reply":
      return runMessage(endpoint, session, command, args, stdin, wf, submit);
    default:
      return usageError(usage(wf));
  }
}

async function runResult(
  endpoint: string,
  session: string | undefined,
  args: readonly string[],
  stdin: string | null,
  submit: Submit,
): Promise<CliOutcome> {
  const [operationId, ...flags] = args;
  if (!operationId?.trim() || operationId.startsWith("--"))
    return usageError("wf result needs the call id it is answering");
  // The engine reads the flags by the schema, which wf doesn't know. Standard input was read only
  // with nothing after the call id; with nothing there either, the result is no input.
  const given =
    flags.length > 0
      ? { args: flags }
      : stdin !== null && stdin.trim() !== ""
        ? { raw: stdin }
        : {};

  let response: ControlResponse;
  try {
    response = await submit(endpoint, {
      version: WIRE_VERSION,
      command: "result",
      operationId,
      ...given,
      ...(session ? { session } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `wf: result submission failed.\n${reason}` };
  }

  if (response.kind === "rejected") {
    return refused(response, `wf: ${rejection(response, operationId)}`);
  }
  if (response.kind !== "accepted")
    return { exitCode: 1, stdout: "", stderr: "wf: unexpected waiting acknowledgement for result" };
  return succeeded(response, "wf: result accepted");
}

async function runWaiting(
  endpoint: string,
  session: string | undefined,
  args: readonly string[],
  submit: Submit,
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
    timeoutMs = durationOf(duration);
    if (timeoutMs === undefined)
      return usageError("wf waiting --timeout must be a positive integer with ms, s, m or h");
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
    return refused(
      response,
      response.code === "owes-reply" || response.code === "no-result"
        ? `wf: waiting refused (${response.code}): ${response.error}`
        : `wf: waiting rejected (${response.code}).\n${response.error}`,
    );
  if (response.kind === "awaiting-reply") return succeeded(response, `wf: ${response.notice}`);
  if (response.kind !== "waiting")
    return {
      exitCode: 1,
      stdout: "",
      stderr: "wf: unexpected acknowledgement for waiting; wait is uncertain",
    };
  return succeeded(
    response,
    response.deadline === undefined
      ? `wf: waiting granted until ${response.waitUntil}; the operation has no deadline (Unix milliseconds)`
      : `wf: waiting granted until ${response.waitUntil}; operation deadline ${response.deadline} (Unix milliseconds)`,
  );
}

async function runPeers(
  endpoint: string,
  session: string | undefined,
  args: readonly string[],
  submit: Submit,
): Promise<CliOutcome> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json"))
    return usageError("wf peers takes only --json");
  let response: ControlResponse;
  try {
    response = await submit(endpoint, {
      version: WIRE_VERSION,
      command: "peers",
      ...(session ? { session } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `wf: peers failed; nothing changed.\n${detail}` };
  }
  if (response.kind === "rejected")
    return refused(response, `wf: peers refused (${response.code}): ${response.error}`);
  if (response.kind !== "peers")
    return { exitCode: 1, stdout: "", stderr: "wf: unexpected acknowledgement for peers" };
  // The table says what is owed itself, so the owed-answer line does not lead it.
  if (args[0] === "--json") {
    const { peers, owes, awaits } = response;
    return {
      exitCode: 0,
      stdout: JSON.stringify({ peers, owes, ...(awaits ? { awaits } : {}) }),
      stderr: "",
    };
  }
  return { exitCode: 0, stdout: response.text, stderr: "" };
}

async function runMessage(
  endpoint: string,
  session: string | undefined,
  command: "send" | "reply",
  args: readonly string[],
  stdin: string | null,
  wf: string,
  submit: Submit,
): Promise<CliOutcome> {
  const parsed = messageArgs(args);
  const wrong = (problem: string) =>
    usageError(`wf: ${command}: ${problem}\n\n${messageUsage(wf).join("\n")}`);
  if ("error" in parsed) return wrong(parsed.error);
  const { peer, message, awaitReply, timeoutMs } = parsed;
  // A heredoc ends with a newline the agent did not mean as part of the message.
  const text = message ?? stdin?.replace(/\r?\n$/, "") ?? null;
  if (text === null || text.trim() === "") return wrong("it needs a message");
  const request: MessageRequest = {
    version: WIRE_VERSION,
    command,
    peer,
    text,
    ...(awaitReply ? { awaitReply: true as const } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(session ? { session } : {}),
  };
  let response: ControlResponse;
  try {
    response = await submit(endpoint, request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const what = command === "send" ? "message" : "reply";
    // Refused at the connection, nothing reached the engine; after, it may have been admitted.
    if (error instanceof NotSentError) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `wf: the ${what} was not sent: the engine could not be reached. Try again.\n${detail}`,
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr: `wf: the engine did not confirm this ${what}, so it may have been queued. Nothing was retried: do not send it again.\n${detail}`,
    };
  }
  if (response.kind === "rejected")
    return refused(response, `wf: ${command} refused (${response.code}): ${response.error}`);
  if (response.kind !== "sent")
    return { exitCode: 1, stdout: "", stderr: `wf: unexpected acknowledgement for ${command}` };
  return succeeded(response, `wf: ${response.notice}`);
}

/**
 * Flags, the peer and the message if it is an argument. Flags may come before the peer or right
 * after it, as agents type them; one after the message would otherwise go as its text.
 */
function messageArgs(
  args: readonly string[],
): { peer: string; message?: string; awaitReply: boolean; timeoutMs?: number } | { error: string } {
  let awaitReply = false;
  let timeoutMs: number | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (positional.length > 1) return { error: "flags go before the message" };
    if (arg === "--await-reply" && !awaitReply) awaitReply = true;
    else if (arg === "--timeout" && timeoutMs === undefined) {
      timeoutMs = durationOf(args[i + 1] ?? "");
      if (timeoutMs === undefined)
        return { error: "--timeout takes a positive integer with ms, s, m or h, such as 5m" };
      i += 1;
    } else if (positional.length === 1 && arg !== "--await-reply" && arg !== "--timeout") {
      return { error: `${arg} is not a flag; a message that starts with -- goes in a heredoc` };
    } else return { error: `${arg} is not a flag it takes, or is given twice` };
  }
  if (timeoutMs !== undefined && !awaitReply) return { error: "--timeout needs --await-reply" };
  const [peer, ...rest] = positional;
  if (!peer) return { error: "it needs the peer to send to" };
  if (rest.length > 1)
    return { error: "the message is one argument; quote it, or use a heredoc or standard input" };
  return {
    peer,
    ...(rest[0] === undefined ? {} : { message: rest[0] }),
    awaitReply,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function durationOf(text: string): number | undefined {
  const match = /^([0-9]+)(ms|s|m|h)$/.exec(text);
  if (!match) return undefined;
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]!]!;
  const value = Number(match[1]) * factor;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** What is owed leads, so it comes back after a harness compacts; then the acknowledgement. */
function succeeded(response: { owing?: string }, line: string): CliOutcome {
  return {
    exitCode: 0,
    stdout: response.owing ? `wf: ${response.owing}\n${line}` : line,
    stderr: "",
  };
}

function refused(response: { owing?: string }, line: string): CliOutcome {
  return {
    exitCode: 1,
    stdout: "",
    stderr: response.owing ? `wf: ${response.owing}\n${line}` : line,
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
    // Messaging's: the engine names the peer and the next step.
    case "owes-reply":
    case "no-result":
      return `result refused (${response.code}): ${response.error}`;
    default:
      // Everything else — too large, malformed, wrong version — is only distinguishable by what
      // the engine said, and whether a shorter or different value would be taken.
      return `result submission was rejected.\n${response.error}`;
  }
}

/**
 * The launcher supplies `--at <socket>`, then `--as <its own path>`, then `--session <id>`
 * expanded from the harness's own variable, which is empty when the agent's shell does not set it.
 */
function launched(argv: readonly string[]): {
  endpoint?: string;
  session?: string;
  launcher?: string;
  command: readonly string[];
} {
  const [flag, endpoint, ...rest] = argv;
  if (flag !== "--at" || !endpoint) return { command: rest };
  let command = rest;
  let launcher: string | undefined;
  if (command[0] === "--as") {
    launcher = command[1]?.trim() || undefined;
    command = command.slice(2);
  }
  const named = launcher ? { launcher } : {};
  if (command[0] !== "--session") return { endpoint, ...named, command };
  const session = command[1]?.trim();
  return { endpoint, ...named, ...(session ? { session } : {}), command: command.slice(2) };
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
    console.error(`wf: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const outcome = await runCli(process.argv.slice(2), stdinText);
  if (outcome.stdout) console.log(outcome.stdout);
  if (outcome.stderr) console.error(outcome.stderr);
  process.exit(outcome.exitCode);
}

/**
 * Standard input, for the commands that take it: `result <call-id>` and nothing more, or `send`
 * and `reply` with no message argument after the peer.
 */
export async function readCliStdin(
  argv: readonly string[],
  isTTY: boolean,
  stream: ReadableStream<Uint8Array>,
): Promise<string | null> {
  if (isTTY) return null;
  const [verb, ...args] = launched(argv).command;
  const parsed = verb === "send" || verb === "reply" ? messageArgs(args) : undefined;
  const reads =
    (verb === "result" && args.length === 1) ||
    (parsed !== undefined && !("error" in parsed) && parsed.message === undefined);
  if (!reads) return null;
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
