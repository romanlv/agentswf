import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import type {
  AgentOp,
  OpenResultJson,
  OpRecord,
  RefusalCode,
  RunView,
} from "@agentswf/contract/records";
import {
  findHarness,
  forkRecordedSession,
  HARNESSES,
  type Harness,
  HOME_ENV,
  launchSettings,
  type RunProcess,
  runProcess,
  withholding,
} from "@agentswf/harness";
import { messageOf } from "./errors";
import help from "./help/open.txt" with { type: "text" };
import { listOps, opFile } from "./ops";
import { asksJson, printRefusal } from "./refusals";
import { failed, type Out, parsePlace, type ReadPlace, shellLine } from "./run-commands";
import { readRunLines } from "./run-lines";
import { findRunByRef, RunNotFound, type RunStatus } from "./run-state";
import { workDir } from "./runs";

export const openUsage = help.trimEnd();

type Environment = Readonly<Record<string, string | undefined>>;
type SessionLine = RunView["sessions"]["all"][number];

/** A harness's TUI, run on this terminal: its exit code once it ends. */
export type Attach = (input: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
}) => Promise<number>;

export type OpenContext = {
  home?: string;
  environment?: Environment;
  /** What an agent never inherits: withheld from the fork, the `-p` turn and the TUI alike. */
  withheld?: readonly string[];
  /** Runs a fork, or the turn `-p` asks. */
  run?: RunProcess;
  /** Runs the TUI on this terminal. */
  attach?: Attach;
  stdin?: () => Promise<string>;
  /** Then nothing is piped in: `-p` without text is refused rather than waiting. */
  stdinIsTerminal?: boolean;
};

type Options = {
  ref: string;
  agent: string;
  session?: string;
  /** `-p`: its text, or `""` for stdin. */
  print?: string;
};

/** A refusal with its code, its sentence the next step. */
class OpenRefused extends Error {
  constructor(
    message: string,
    readonly code: RefusalCode,
  ) {
    super(message);
    this.name = "OpenRefused";
  }
}

/** How long one question asked with `-p` may take. */
const PRINT_TIMEOUT_MS = 60 * 60_000;

export async function openCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  context: OpenContext = {},
): Promise<number> {
  if (argv[0] === "-h" || argv[0] === "--help") {
    out.stdout(openUsage);
    return 0;
  }
  let place: ReadPlace;
  let json: boolean;
  let options: Options;
  try {
    const parsed = parsePlace(argv, shellCwd);
    place = parsed.place;
    json = parsed.json;
    options = parseOpen(parsed.rest);
    if (json && options.print === undefined)
      throw new Error("a TUI has no JSON: --json goes with -p");
  } catch (error) {
    printRefusal(out, { json: asksJson(argv), v: 1 }, error, "usage", openUsage);
    return 2;
  }
  const refuse = (error: OpenRefused) => {
    printRefusal(out, { json, v: 1 }, error, error.code);
    return error.code === "unreachable" ? 3 : 1;
  };
  const home = context.home ?? homedir();
  const environment = context.environment ?? process.env;
  try {
    if (
      options.print === "" &&
      (context.stdinIsTerminal ?? (context.stdin === undefined && process.stdin.isTTY === true))
    )
      throw new OpenRefused("nothing to ask: give -p its text, or pipe it in", "usage");
    let status: RunStatus;
    try {
      status = await findRunByRef(options.ref, place, home);
    } catch (error) {
      if (error instanceof RunNotFound)
        return failed(error, place, out, error.message, { json, v: 1 });
      throw error;
    }
    const where = await agentPlace(status, options);
    const spec = HARNESSES[where.harness];
    const settings = launchSettings(where.execution);
    const env: Record<string, string> = where.home ? { [HOME_ENV[where.harness]]: where.home } : {};
    const withheld = Object.fromEntries((context.withheld ?? []).map((name) => [name, undefined]));
    const turnContext = (sessionHint: string) => ({
      ...settings,
      sessionHint,
      ...(where.home ? { home: where.home } : {}),
    });
    const run = withholding(context.run ?? runProcess, context.withheld ?? []);
    // A copy is made first, before anything waits on stdin or opens a TUI.
    let session = where.session;
    let forkedFrom: string | undefined;
    if (!where.copy) {
      forkedFrom = session;
      session = await forkRecordedSession(
        where.harness,
        session,
        { cwd: where.cwd, env, context: turnContext(session) },
        run,
      ).catch((error: unknown) => {
        throw new OpenRefused(
          `${options.agent}'s session ${where.session} could not be copied: ${messageOf(error)}`,
          "internal-error",
        );
      });
    }
    const again = shellLine([
      "awf",
      "open",
      status.ref,
      options.agent,
      "--session",
      session,
      ...place.repeat,
    ]);
    const model = where.execution.model || undefined;
    const said = `${options.agent} · ${where.harness}${model ? ` ${model}` : ""}`;
    if (options.print !== undefined) {
      if (!spec.resumeTurn)
        throw new OpenRefused(
          `${where.harness} cannot be asked headless: ${spec.absent.resumeTurn}`,
          "usage",
        );
      if (spec.meteredHeadless && where.execution.metered !== true)
        throw new OpenRefused(
          `headless ${where.harness} is billed per token even on a subscription login, and ${options.agent} did not run metered: open it without -p`,
          "usage",
        );
      const text = options.print || (await (context.stdin ?? readStdin)());
      if (text.trim() === "") throw new OpenRefused("nothing to ask: stdin was empty", "usage");
      const plan = spec.resumeTurn(text, session, turnContext(session));
      const stop = new AbortController();
      const interrupt = () => stop.abort();
      process.on("SIGINT", interrupt);
      let result: Awaited<ReturnType<RunProcess>>;
      try {
        result = await run({
          argv: plan.argv,
          cwd: where.cwd,
          env,
          ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
          timeoutMs: PRINT_TIMEOUT_MS,
          signal: stop.signal,
        });
      } finally {
        process.off("SIGINT", interrupt);
      }
      if (result.cancelled) throw new OpenRefused("the question was interrupted", "internal-error");
      if (result.exitCode !== 0)
        throw new OpenRefused(
          `${where.harness} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-400)}`,
          "internal-error",
        );
      const reply = (spec.readTranscript?.(result.stdout) ?? result.stdout).trim();
      if (json) {
        out.stdout(
          JSON.stringify({
            v: 1,
            agent: options.agent,
            harness: where.harness,
            session,
            ...(forkedFrom ? { forkedFrom } : {}),
            cwd: where.cwd,
            ...(model ? { model } : {}),
            reply,
            again,
          } satisfies OpenResultJson),
        );
      } else out.stdout(reply);
      out.stderr(`again: ${again}`);
      return 0;
    }
    if (!spec.operatorResume)
      throw new OpenRefused(
        `${where.harness} has no TUI a person can resume: ${spec.absent.operatorResume}`,
        "usage",
      );
    out.stderr(
      `${said} · ${forkedFrom ? `a copy of ${forkedFrom}, ${session}` : `session ${session}`}`,
    );
    const plan = spec.operatorResume(session, settings, [], false);
    const code = await (context.attach ?? attachHere(environment))({
      argv: plan.argv,
      cwd: where.cwd,
      env: { ...env, ...withheld },
    });
    out.stderr(`again: ${again}`);
    return code;
  } catch (error) {
    if (error instanceof OpenRefused) return refuse(error);
    return failed(error, place, out, messageOf(error), { json, v: 1 });
  }
}

/** Where the agent's session is and how it ran, as the run recorded it; or why it can't be opened. */
type AgentPlace = {
  harness: Harness;
  /** The session to open: one the run recorded, copied first, or the operator's copy as it is. */
  session: string;
  /** `--session` named an id the run never recorded: a copy an earlier `awf open` made. */
  copy: boolean;
  line: SessionLine;
  execution: AgentOp["execution"];
  cwd: string;
  /** The agent's own harness home, where it had one. */
  home?: string;
};

async function agentPlace(status: RunStatus, options: Options): Promise<AgentPlace> {
  const { view } = await readRunLines(status.run.dir);
  const { agent } = options;
  const latest = view.sessions.latest[agent];
  if (!latest) {
    const known = Object.keys(view.sessions.latest);
    throw new OpenRefused(
      `${status.ref} has no session of ${agent}'s recorded${known.length > 0 ? `; agents with one: ${known.join(", ")}` : ": no agent's session is"}`,
      "no-session",
    );
  }
  const named =
    options.session === undefined
      ? latest
      : view.sessions.all.findLast(
          (line) => line.agent === agent && line.session === options.session,
        );
  const line = named ?? latest;
  if (!findHarness(line.harness))
    throw new OpenRefused(
      `${agent} ran on ${line.harness}, a harness this awf does not know`,
      "usage",
    );
  const op = await agentOp(status.run.dir, agent, line, view);
  const cwd = op.cwd;
  if (!(await isDirectory(cwd)))
    throw new OpenRefused(
      `${agent} worked in ${cwd}, which is gone; its harness finds the session only from there`,
      "unreachable",
    );
  let home: string | undefined;
  if (line.home !== undefined) {
    if (!(await isDirectory(line.home)))
      throw new OpenRefused(`${agent}'s own home ${line.home} is gone`, "unreachable");
    // A home outside the run's folder is a sandbox's, which this session line does not record.
    if (!(await within(workDir(status.run.dir), line.home)))
      throw new OpenRefused(
        `${agent} ran in a sandbox this run did not record, so it cannot be reopened where it ran`,
        "unreachable",
      );
    home = line.home;
  }
  return {
    harness: line.harness as Harness,
    session: options.session ?? latest.session,
    copy: options.session !== undefined && named === undefined,
    line,
    execution: op.execution,
    cwd,
    ...(home === undefined ? {} : { home }),
  };
}

/**
 * The operation that recorded the session: its line's, else the agent's latest one that names an
 * operation, else its highest-numbered folder.
 */
async function agentOp(
  runDir: string,
  agent: string,
  line: SessionLine,
  view: RunView,
): Promise<AgentOp> {
  const named =
    line.operation ??
    view.sessions.all.findLast((each) => each.agent === agent && each.operation !== undefined)
      ?.operation;
  const op = named ?? (await lastOp(runDir, agent));
  if (op === undefined)
    throw new OpenRefused(
      `${agent} has no operation recorded, so where it ran is unknown`,
      "no-session",
    );
  let record: OpRecord;
  try {
    record = JSON.parse(await readFile(opFile(runDir, op), "utf8")) as OpRecord;
  } catch (error) {
    throw new OpenRefused(
      `${agent}'s operation ${op} could not be read: ${messageOf(error)}`,
      "unreachable",
    );
  }
  if (record.kind === "decision" || typeof record.cwd !== "string")
    throw new OpenRefused(`operation ${op} is not ${agent}'s`, "unreachable");
  return record;
}

async function lastOp(runDir: string, agent: string): Promise<string | undefined> {
  const last = (await listOps(runDir)).get(agent);
  return last?.of === "agent" ? `${agent}.${last.last}` : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );
}

/** Whether `path` is inside `directory`, both by their real paths. */
async function within(directory: string, path: string): Promise<boolean> {
  const [outer, inner] = await Promise.all([
    realpath(directory).catch(() => directory),
    realpath(path).catch(() => path),
  ]);
  const inside = relative(outer, inner);
  return inside !== "" && !inside.startsWith(`..${sep}`) && inside !== "..";
}

function parseOpen(rest: readonly string[]): Options {
  const words: string[] = [];
  let session: string | undefined;
  let print: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--session") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--session needs a session's id");
      session = value;
      index += 1;
    } else if (arg === "-p") {
      const value = rest[index + 1];
      // Its text, unless what follows is an option: then it reads stdin.
      if (value !== undefined && !value.startsWith("-")) {
        print = value;
        index += 1;
      } else print = "";
    } else if (arg === "--") {
      words.push(...rest.slice(index + 1));
      break;
    } else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else words.push(arg);
  }
  const [ref, agent, ...extra] = words;
  if (!ref || !agent?.trim())
    throw new Error("open needs a run, <workflow>/<id> or <id>, and an agent");
  if (extra.length > 0)
    throw new Error(`open takes a run and an agent; ${extra[0]} is neither: -p takes the question`);
  return {
    ref,
    agent,
    ...(session === undefined ? {} : { session }),
    ...(print === undefined ? {} : { print }),
  };
}

function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

/**
 * The TUI on this terminal: its stdio this process's, and this process deaf to the keys that stop
 * it, which are the harness's while it runs, as a shell is to its foreground job.
 */
export function attachHere(environment: Environment): Attach {
  return async ({ argv, cwd, env }) => {
    const merged: Record<string, string> = {};
    for (const [name, value] of Object.entries({ ...environment, ...env }))
      if (value !== undefined) merged[name] = value;
    const ignore = () => undefined;
    const signals = ["SIGINT", "SIGQUIT", "SIGTSTP"] as const;
    for (const signal of signals) process.on(signal, ignore);
    try {
      const child = Bun.spawn({
        cmd: [...argv],
        cwd,
        env: merged,
        stdio: ["inherit", "inherit", "inherit"],
      });
      return await child.exited;
    } finally {
      for (const signal of signals) process.off(signal, ignore);
    }
  };
}
