import { homedir } from "node:os";
import type { ParticipantResultJson, RefusalCode } from "@agentswf/contract/records";
import { type HolderWireAnswer, type ParticipantCode, WIRE_VERSION } from "@agentswf/contract/wire";
import { liveCoordinatorSocket } from "./coordinator-socket";
import { messageOf } from "./errors";
import { isCode } from "./files";
import help from "./help/reply.txt" with { type: "text" };
import { ItemFold } from "./inbox-command";
import { coordinatorDir } from "./machine";
import { asksJson, printRefusal } from "./refusals";
import { failed, type Out, parsePlace, type ReadPlace } from "./run-commands";
import { findRunByRef, RunNotFound, type RunStatus } from "./run-state";
import { RunUnreachable } from "./run-unreachable";
import { readAttempts, readNumberedEvents } from "./runs";
import { exchange } from "./socket-exchange";

export const replyUsage = help.trimEnd();

type Options = {
  command: "reply" | "send";
  ref: string;
  to?: string;
  text?: string;
  agent: string;
  as?: string;
};

type HolderIo = Out & {
  /** Stdin, when no text is given as an argument. */
  stdin(): Promise<string>;
  /** Then there is nothing piped in to read: refused rather than waited on. */
  stdinIsTerminal?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  home?: string;
};

/** A refusal of `reply` or `send`: its document with `--json`, its sentence on stderr, exit 1. */
type Refuse = (code: ParticipantCode | RefusalCode, error: string, choices?: string[]) => number;

export async function holderCommand(
  argv: readonly string[],
  shellCwd: string,
  io: HolderIo,
): Promise<number> {
  // Help only as the first word after the command: a message's text may say anything.
  if (argv[1] === "-h" || argv[1] === "--help") {
    io.stdout(replyUsage);
    return 0;
  }
  let place: ReadPlace;
  let json: boolean;
  let options: Options;
  try {
    const parsed = parsePlace(argv.slice(1), shellCwd);
    place = parsed.place;
    json = parsed.json;
    options = parseHolder(argv[0] as "reply" | "send", parsed.rest);
  } catch (error) {
    printRefusal(io, { json: asksJson(argv), v: 3 }, error, "usage", replyUsage);
    return 2;
  }
  const delivered = (id: string, line: string): number => {
    io.stdout(json ? JSON.stringify({ v: 3, id } satisfies ParticipantResultJson) : line);
    return 0;
  };
  const refused: Refuse = (code, error, choices) => {
    if (json)
      io.stdout(
        JSON.stringify({
          v: 3,
          code,
          error,
          ...(choices ? { choices } : {}),
        } satisfies ParticipantResultJson),
      );
    io.stderr(
      `awf: ${options.command} refused (${code}): ${error}${choices ? ` Choose: ${choices.join(", ")}` : ""}`,
    );
    return 1;
  };
  const usage = (problem: string) => {
    printRefusal(io, { json, v: 3 }, problem, "usage", replyUsage);
    return 2;
  };
  if (options.text !== undefined && options.text.trim() === "")
    return usage("nothing to say: the text is blank");
  if (options.text === undefined && io.stdinIsTerminal)
    return usage("nothing to say: give the text as an argument, or pipe it in");
  try {
    let status: RunStatus;
    try {
      status = await findRunByRef(options.ref, place, io.home ?? homedir());
    } catch (error) {
      if (error instanceof RunNotFound) return refused(error.code, error.message);
      throw error;
    }
    if (status.state !== "running")
      return refused("ended", `${status.ref} has ended (${status.state}); start a new run`);
    // After the run is found: one that is not there says so before stdin is waited on.
    const text = options.text ?? (await io.stdin());
    if (text.trim() === "") return usage("nothing to say: stdin was empty");
    const unreachable = () =>
      refused(
        "no-participant",
        `${status.ref} has no participant${options.as ? ` ${options.as}` : ""} to reach yet; try again once it connects one`,
      );
    const dir = coordinatorDir(io.home ?? homedir(), io.environment ?? process.env);
    // Live with no socket: its attempt has not connected one yet, or is opening it.
    const socket = await liveCoordinatorSocket(dir, status);
    if (!socket) return unreachable();
    const request = {
      version: WIRE_VERSION,
      command: options.command,
      ...(options.as === undefined ? {} : { participant: options.as }),
      agent: options.agent,
      ...(options.to === undefined ? {} : { to: options.to }),
      text,
    };
    let answer: string;
    try {
      answer = await exchange(socket, `${JSON.stringify(request)}\n`);
    } catch (error) {
      // A socket an attempt left when it was killed: this attempt has not opened its own yet.
      if (["ECONNREFUSED", "ENOENT", "ENOTSOCK"].some((code) => isCode(error, code)))
        return unreachable();
      // Open and silent, or gone mid-answer: the run doesn't answer.
      throw new RunUnreachable(`${status.ref} did not answer: ${messageOf(error)}`);
    }
    if (!answer)
      throw new RunUnreachable(
        `${status.ref} did not answer, most likely as it runs an older awf than this one, which speaks wire version ${WIRE_VERSION}: reach it with the awf it started with, or let it end and continue it under this one.`,
      );
    const result = JSON.parse(answer) as HolderWireAnswer;
    if (result.code !== "delivered") return refused(result.code, result.error, result.choices);
    if (options.command === "reply") return delivered(result.id, `answered ${result.id}`);
    // Held for an agent awaiting this participant's answer: it comes with that answer.
    // Only the line's wording: the message is delivered, whatever reading this finds.
    const awaited = await awaitedBy(status, options.agent, options.as).catch(() => undefined);
    return delivered(
      result.id,
      `delivered as ${result.id}${awaited ? `; ${options.agent} still awaits the reply to ${awaited}` : ""}`,
    );
  } catch (error) {
    return failed(error, place, io, messageOf(error), { json, v: 3 });
  }
}

function parseHolder(command: "reply" | "send", rest: readonly string[]): Options {
  const words: string[] = [];
  let to: string | undefined;
  let as: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    const value = () => {
      const given = rest[index + 1];
      if (given === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return given;
    };
    if (arg === "--to" && command === "reply") to = value();
    else if (arg === "--as") as = value();
    else if ((arg === "--event-id" || arg === "--author") && command === "send")
      throw new Error(
        `send ${arg} was removed: a message on a participant to the run's code is awf emit {run} {participant}:reply '{"text":…,"author":…}' --event-id {id}, with {participant}:reply declared in the workflow's events`,
      );
    else if (arg === "--") {
      words.push(...rest.slice(index + 1));
      break;
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else words.push(arg);
  }
  const [ref, agent, text, ...extra] = words;
  if (!ref || !agent?.trim())
    throw new Error(`${command} needs a run, <workflow>/<id> or <id>, and an agent`);
  if (extra.length > 0) throw new Error("the text is one argument: quote it, or pipe it in");
  if (as !== undefined && as.trim() === "") throw new Error("--as needs a participant's key");
  if (to !== undefined && !/^\d+\.\d+$/.test(to))
    throw new Error(`--to takes a question's id as awf inbox prints it, such as 1.5, not ${to}`);
  return {
    command,
    ref,
    agent,
    ...(as === undefined ? {} : { as }),
    ...(to === undefined ? {} : { to }),
    ...(text === undefined ? {} : { text }),
  };
}

/** The question `agent` still awaits from the coordinator, as the run's log has it. */
async function awaitedBy(
  status: RunStatus,
  agent: string,
  as: string | undefined,
): Promise<string | undefined> {
  const items =
    new ItemFold()
      .add(await readNumberedEvents(status.run.dir))
      .items(await readAttempts(status.run), true) ?? [];
  const closed = new Set(
    items.flatMap((item) => (item.kind === "answered" || item.kind === "expired" ? [item.id] : [])),
  );
  const open = items.flatMap((item) =>
    item.kind === "message" &&
    item.asks === true &&
    item.from === agent &&
    (as === undefined || item.participant === as) &&
    !closed.has(item.id)
      ? [item.id]
      : [],
  );
  return open.at(-1);
}
