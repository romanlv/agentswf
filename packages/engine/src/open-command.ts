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
  hostHome,
  launchSettings,
  type RunProcess,
  runAttached,
  runProcess,
} from "@agentswf/harness";
import { messageOf } from "./errors";
import help from "./help/open.txt" with { type: "text" };
import { listOps, opFile } from "./ops";
import { asksJson, printRefusal } from "./refusals";
import { failed, type Out, parsePlace, type ReadPlace, shellLine } from "./run-commands";
import { readRunLines } from "./run-lines";
import { claimNow, releaseClaim, runLockFile, runOpenFile, withRunLock } from "./run-lock";
import { findRunByRef, RunNotFound, type RunStatus } from "./run-state";
import { isLive, readAttempts, workDir } from "./runs";
import { type Launch, wake } from "./wake";

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
  /** Runs a fork, or the turn `-p` asks; the operator runtime's withholds what no agent inherits. */
  run?: RunProcess;
  /** Runs the TUI on this terminal, withholding the same. */
  attach?: Attach;
  stdin?: () => Promise<string>;
  /** Then nothing is piped in: `-p` without text is refused rather than waiting. */
  stdinIsTerminal?: boolean;
  /** How the wake at a held run's release starts its attempt; absent, as `awf tick` does. */
  launch?: Launch;
};

type Options = {
  ref: string;
  agent: string;
  /** `--no-fork`: the agent's own session, the run held while it is open. */
  noFork: boolean;
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
    return error.code === "usage" ? 2 : error.code === "unreachable" ? 3 : 1;
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
    const env: Record<string, string> = where.home
      ? hostHome(where.harness, where.home, environment).env
      : {};
    const turnContext = (sessionHint: string) => ({
      ...settings,
      sessionHint,
      ...(where.home ? { home: where.home } : {}),
    });
    const run = context.run ?? runProcess;
    if (options.noFork && where.copy)
      throw new OpenRefused(
        `${options.session} is not one of ${options.agent}'s sessions in ${status.ref}: a copy an earlier awf open made is yours already; open it without --no-fork`,
        "usage",
      );
    // Every refusal comes before the copy: a refused open leaves nothing behind.
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
    } else if (!spec.operatorResume)
      throw new OpenRefused(
        `${where.harness} has no TUI a person can resume: ${spec.absent.operatorResume}`,
        "usage",
      );
    const text =
      options.print === undefined
        ? undefined
        : options.print || (await (context.stdin ?? readStdin)());
    if (text !== undefined && text.trim() === "")
      throw new OpenRefused("nothing to ask: stdin was empty", "usage");
    const held = options.noFork ? await holdRun(status, options.agent, place) : undefined;
    try {
      let session = where.session;
      let forkedFrom: string | undefined;
      if (!where.copy && !options.noFork) {
        forkedFrom = session;
        const forked = await forkRecordedSession(
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
        session = forked.sessionRef;
      }
      const again = shellLine([
        "awf",
        "open",
        status.ref,
        options.agent,
        ...(options.noFork ? ["--no-fork"] : []),
        ...(!options.noFork || options.session !== undefined ? ["--session", session] : []),
        ...place.repeat,
      ]);
      if (text !== undefined) {
        const plan = spec.resumeTurn!(text, session, turnContext(session));
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
        if (result.cancelled)
          throw new OpenRefused("the question was interrupted", "internal-error");
        if (result.timedOut)
          throw new OpenRefused(
            `${where.harness} gave no answer within ${PRINT_TIMEOUT_MS / 60_000} minutes`,
            "internal-error",
          );
        if (result.exitCode !== 0)
          throw new OpenRefused(
            `${where.harness} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-400)}`,
            "internal-error",
          );
        const reply = (spec.readTranscript?.(result.stdout) ?? result.stdout).trim();
        out.stdout(
          json
            ? JSON.stringify({
                v: 1,
                session,
                ...(forkedFrom ? { forkedFrom } : {}),
                reply,
                again,
              } satisfies OpenResultJson)
            : reply,
        );
        await held?.release(out, context);
        out.stderr(`again: ${again}`);
        return 0;
      }
      const { model, effort } = settings;
      out.stderr(
        [
          options.agent,
          [where.harness, model, effort].filter(Boolean).join(" "),
          forkedFrom
            ? `a copy of ${forkedFrom}`
            : held
              ? `session ${session}, the run held until you exit`
              : `session ${session}`,
        ].join(" · "),
      );
      const plan = spec.operatorResume!(session, settings, []);
      const code = await (context.attach ?? ((input) => runAttached(input, environment)))({
        argv: plan.argv,
        cwd: where.cwd,
        env,
      });
      await held?.release(out, context);
      out.stderr(`again: ${again}`);
      return code;
    } finally {
      // Released once, by whichever comes first; a refusal or a throw lets go here.
      await held?.release(out, context);
    }
  } catch (error) {
    if (error instanceof OpenRefused) return refuse(error);
    return failed(error, place, out, messageOf(error), { json, v: 1 });
  }
}

/** A run `--no-fork` holds: let go once, then woken as `awf tick` would wake it. */
type Held = { release(out: Out, context: OpenContext): Promise<void> };

/**
 * Holds the run for `--no-fork`: refused while an attempt is live or another `awf open --no-fork`
 * holds it. Checked under the run's lock, which is let go at once: senders take it for every
 * append. An attempt claims its number without that lock, then looks for this claim, so this one
 * looks for a live attempt again once it holds: of the two, one always sees the other.
 */
async function holdRun(status: RunStatus, agent: string, place: ReadPlace): Promise<Held> {
  const { run, ref } = status;
  const { workflow, id } = run.record;
  const file = runOpenFile(run.root, workflow, id);
  const plain = shellLine(["awf", "open", ref, agent, ...place.repeat]);
  const live = () =>
    readAttempts(run).then((attempts) => attempts.find((attempt) => isLive(attempt)));
  const running = () =>
    new OpenRefused(
      `${ref} is running, and ${agent}'s session may be written as you type; a copy opens anyway: ${plain}`,
      "live",
    );
  const holding = await withRunLock(runLockFile(run.root, workflow, id), async () => {
    if (await live()) throw running();
    const claimed = await claimNow(file);
    if ("heldBy" in claimed)
      throw new OpenRefused(
        `${ref} is open in awf open --no-fork (pid ${claimed.heldBy.pid}); a copy opens anyway: ${plain}`,
        "opened",
      );
    if (await live()) {
      await releaseClaim(file, claimed.held);
      throw running();
    }
    return claimed.held;
  });
  let released: Promise<void> | undefined;
  return {
    release: (out, context) => {
      released ??= (async () => {
        await releaseClaim(file, holding);
        if (run.record.events) await wakeAfter(status, out, context);
      })();
      return released;
    },
  };
}

/** What waited while the run was held, taken as `awf tick` takes it: said, never thrown. */
async function wakeAfter(status: RunStatus, out: Out, context: OpenContext): Promise<void> {
  const { run, ref } = status;
  try {
    const woken = await withRunLock(runLockFile(run.root, run.record.workflow, run.record.id), () =>
      wake(run, {
        home: context.home ?? homedir(),
        environment: context.environment ?? process.env,
        nudgeLive: false,
        ...(context.launch ? { launch: context.launch } : {}),
      }),
    );
    if (woken.why === "launch-failed")
      out.stderr(`awf: ${ref} was not woken: ${woken.error}; awf tick tries again`);
    else if (woken.did === "started" || woken.did === "continued")
      out.stderr(`woke ${ref}: ${woken.did}, for ${WOKEN_FOR[woken.cause ?? "event"]}`);
  } catch (error) {
    out.stderr(`awf: ${ref} was not woken: ${messageOf(error)}; awf tick wakes it`);
  }
}

const WOKEN_FOR = {
  event: "an event that waited",
  timer: "a timer due",
  crashed: "an attempt that was interrupted",
  failed: "an attempt that failed",
} as const;

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
  const others = named
    ? undefined
    : view.sessions.all.find((each) => each.session === options.session && each.agent !== agent);
  if (others)
    throw new OpenRefused(
      `${options.session} is ${others.agent}'s session, not ${agent}'s: awf open ${status.ref} ${others.agent} --session ${options.session}`,
      "no-session",
    );
  const line = named ?? latest;
  if (!findHarness(line.harness))
    throw new OpenRefused(
      `${agent} ran on ${line.harness}, a harness this awf does not know`,
      "usage",
    );
  const op = await agentOp(status.run.dir, agent, line);
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
 * The operation that recorded the session: its line's, else the agent's latest, whose cwd and
 * settings are the agent's: a fork's line is written before its first operation names it.
 */
async function agentOp(runDir: string, agent: string, line: SessionLine): Promise<AgentOp> {
  const ops = line.operation ? [line.operation] : await agentOps(runDir, agent);
  if (ops.length === 0)
    throw new OpenRefused(
      `${agent} has no operation recorded, so where it ran is unknown`,
      "no-session",
    );
  let failure: unknown;
  for (const op of ops) {
    try {
      const record = JSON.parse(await readFile(opFile(runDir, op), "utf8")) as OpRecord;
      if (record.kind !== "decision" && typeof record.cwd === "string") return record;
    } catch (error) {
      failure = error;
    }
  }
  throw new OpenRefused(
    `${agent}'s operation ${ops[0]} could not be read${failure ? `: ${messageOf(failure)}` : ""}`,
    "unreachable",
  );
}

/** The agent's operations, latest first. */
async function agentOps(runDir: string, agent: string): Promise<string[]> {
  const last = (await listOps(runDir)).get(agent);
  if (last?.of !== "agent") return [];
  return Array.from({ length: last.last }, (_, index) => `${agent}.${last.last - index}`);
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

/** The options `parseOpen` takes, which `-p` never reads as its text. */
const OPTIONS = new Set(["--no-fork", "--session", "--"]);

function parseOpen(rest: readonly string[]): Options {
  const words: string[] = [];
  let session: string | undefined;
  let print: string | undefined;
  let noFork = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--no-fork") noFork = true;
    else if (arg === "--session") {
      const value = rest[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--session needs a session's id");
      session = value;
      index += 1;
    } else if (arg === "-p") {
      const value = rest[index + 1];
      // Its text, unless it is absent, `-`, or one of this command's options: then stdin.
      if (value !== undefined && value !== "-" && !OPTIONS.has(value)) print = value;
      else print = "";
      if (value === "-" || (value !== undefined && !OPTIONS.has(value))) index += 1;
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
    noFork,
    ...(session === undefined ? {} : { session }),
    ...(print === undefined ? {} : { print }),
  };
}

function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}
