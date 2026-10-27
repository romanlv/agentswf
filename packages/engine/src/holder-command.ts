import { homedir } from "node:os";
import type { ParticipantResultJson } from "@agentswf/contract/records";
import { type ParticipantCode, WIRE_VERSION } from "@agentswf/contract/wire";
import { liveCoordinatorSocket } from "./coordinator-socket";
import { deliver, eventIdProblem } from "./emit";
import { printEmit } from "./emit-command";
import { messageOf } from "./errors";
import { isCode } from "./files";
import { ItemFold } from "./inbox-command";
import { coordinatorDir } from "./machine";
import { failed, type Out, parsePlace, type ReadPlace } from "./run-commands";
import { findRunByRef, RunNotFound, type RunStatus } from "./run-state";
import { readAttempts, readEvents, readNumberedEvents } from "./runs";
import { exchange } from "./socket-exchange";

export const replyUsage = [
  "usage: awf reply <run> <agent> [--to <id>] [--as <key>] [<text>]",
  "       awf send <run> <agent> [--as <key>] [<text>]",
  "       awf send <run> --as <participant> --event-id <id> [--author <name>] [<text>]",
  "each takes [--cwd <directory>] [--run-root <directory>] [--json]",
  "",
  "A run is <workflow>/<id>, or an <id> only one workflow has, here or in a project awf knows.",
  "Answers a question an agent asked a participant outside the run, or messages an agent first,",
  "over a route the workflow allowed. The text is the argument, or stdin without one. --to names",
  "the question, as awf inbox prints it; it may be left out when the agent has one open. --as",
  "names the participant when the workflow connects more than one. Neither waits for an answer:",
  "it comes back in awf inbox. With --event-id, send is a reply on a participant the run routes to its",
  "code: no agent, it reaches the run whether it runs or is parked, and the same id again is a",
  "duplicate. The id is one the run has not had from anyone, as a chat's message ids are. It prints",
  "as awf emit does, and exits 0 for whatever the run did with it (delivered, duplicate, or refused",
  "by a run that returned); 1 when the run or participant isn't found, or its attempt didn't start.",
  "",
  "Exits 0 when delivered, 1 when refused (the code says why), 2 on a usage error, 3 when the run",
  "could not be reached.",
].join("\n");

type Options = {
  command: "reply" | "send";
  ref: string;
  author?: string;
  to?: string;
  text?: string;
} & (
  | { agent: string; as?: string; id?: undefined }
  /**
   * `--event-id`: the message's own id, which a participant routed to the code takes as its event's. It
   * goes to no agent.
   */
  | { id: string; as: string; agent?: undefined }
);

export type HolderIo = Out & {
  /** Stdin, when no text is given as an argument. */
  stdin(): Promise<string>;
  /** Then there is nothing piped in to read: refused rather than waited on. */
  stdinIsTerminal?: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  home?: string;
};

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
    io.stderr(`awf: ${messageOf(error)}\n\n${replyUsage}`);
    return 2;
  }
  const say = (result: ParticipantResultJson, line: string): number => {
    if (json) io.stdout(JSON.stringify(result));
    else if (result.code === "delivered") io.stdout(line);
    else
      io.stderr(
        `awf: ${options.command} refused (${result.code}): ${result.error}${result.choices ? ` Choose: ${result.choices.join(", ")}` : ""}`,
      );
    return result.code === "delivered" ? 0 : 1;
  };
  const refused = (code: ParticipantCode, error: string) => say({ v: 1, code, error }, "");
  const usage = (problem: string) => {
    io.stderr(`awf: ${problem}\n\n${replyUsage}`);
    return 2;
  };
  if (options.text !== undefined && options.text.trim() === "")
    return usage("nothing to say: the text is blank");
  if (options.text === undefined && io.stdinIsTerminal)
    return usage("nothing to say: give the text as an argument, or pipe it in");
  if (options.id !== undefined) return toTheCode(options, place, json, io, { refused, usage });
  try {
    let status: RunStatus;
    try {
      status = await findRunByRef(options.ref, place, io.home ?? homedir());
    } catch (error) {
      if (error instanceof RunNotFound) return refused("not-found", error.message);
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
      throw error;
    }
    if (!answer)
      throw new Error(
        `${status.ref} did not answer the request; it may run another version of awf`,
      );
    const result = JSON.parse(answer) as ParticipantResultJson;
    if (result.code !== "delivered") return say(result, "");
    if (options.command === "reply") return say(result, `answered ${result.id}`);
    // Held for an agent awaiting this coordinator's answer: it comes with that answer.
    const awaited = await awaitedBy(status, options.agent, options.as);
    return say(
      result,
      `delivered as ${result.id}${awaited ? `; ${options.agent} still awaits the reply to ${awaited}` : ""}`,
    );
  } catch (error) {
    return failed(error, place, io, messageOf(error));
  }
}

function parseHolder(command: "reply" | "send", rest: readonly string[]): Options {
  const words: string[] = [];
  let to: string | undefined;
  let as: string | undefined;
  let id: string | undefined;
  let author: string | undefined;
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
    else if (arg === "--event-id" && command === "send") id = value();
    else if (arg === "--author" && command === "send") author = value();
    else if (arg === "--") {
      words.push(...rest.slice(index + 1));
      break;
    } else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    else words.push(arg);
  }
  // With --event-id, the participant's reply goes to the run's code: there is no agent to name.
  let target: { agent: string; as?: string } | { id: string; as: string };
  let ref: string | undefined;
  let text: string | undefined;
  let extra: string[];
  if (id !== undefined) {
    [ref, text, ...extra] = words;
    if (!ref) throw new Error("send needs a run, <workflow>/<id> or <id>");
    if (!as) throw new Error("--event-id sends as a participant routed to the code: --as names it");
    const problem = eventIdProblem(id);
    if (problem) throw new Error(`--event-id ${id}: ${problem}`);
    target = { id, as };
  } else {
    let agent: string | undefined;
    [ref, agent, text, ...extra] = words;
    if (author !== undefined) throw new Error("--author goes with --event-id");
    if (!ref || !agent)
      throw new Error(`${command} needs a run, <workflow>/<id> or <id>, and an agent`);
    target = { agent, ...(as === undefined ? {} : { as }) };
  }
  if (extra.length > 0) throw new Error("the text is one argument: quote it, or pipe it in");
  if (to !== undefined && !/^\d+\.\d+$/.test(to))
    throw new Error(`--to takes a question's id as awf inbox prints it, such as 1.5, not ${to}`);
  return {
    command,
    ref,
    ...target,
    ...(to === undefined ? {} : { to }),
    ...(text === undefined ? {} : { text }),
    ...(author === undefined ? {} : { author }),
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

/**
 * `awf send {ref} --as {participant} --event-id {message id} {text}`: a reply on a participant the run
 * routed to the code, delivered through the one way in as `participant:reply`, so it continues a
 * parked run. The run is found here, or in a project awf started an event run in (Q15).
 */
async function toTheCode(
  options: Extract<Options, { id: string }>,
  place: ReadPlace,
  json: boolean,
  io: HolderIo,
  say: { refused(code: ParticipantCode, error: string): number; usage(problem: string): number },
): Promise<number> {
  const home = io.home ?? homedir();
  const environment = io.environment ?? process.env;
  const { id, as } = options;
  const { refused } = say;
  let found: RunStatus;
  try {
    found = await findRunByRef(options.ref, place, home);
  } catch (error) {
    if (error instanceof RunNotFound) return refused("not-found", error.message);
    return failed(error, place, io, messageOf(error));
  }
  const { run } = found;
  const routed = (await readEvents(run.dir)).some(
    (line) =>
      line.kind === "participant-connected" && line.participant === as && line.to === "code",
  );
  if (!run.record.events || !routed)
    return refused(
      "no-participant",
      `${found.ref} has no participant ${as} routed to its code; --event-id is for one`,
    );
  const text = options.text ?? (await io.stdin());
  if (text.trim() === "") return say.usage("nothing to say: stdin was empty");
  try {
    const result = await deliver(
      {
        runRoot: run.root,
        workflow: run.record.workflow,
        runId: run.record.id,
        event: {
          id,
          name: "participant:reply",
          data: { text, ...(options.author === undefined ? {} : { author: options.author }) },
          from: as,
          at: new Date().toISOString(),
        },
        deduplicate: true,
      },
      { home, environment },
    );
    return printEmit(result, json, io);
  } catch (error) {
    return failed(error, place, io, messageOf(error));
  }
}
