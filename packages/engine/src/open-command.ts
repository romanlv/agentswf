import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type {
  AgentOp,
  OpenResultJson,
  OpRecord,
  RefusalCode,
  RunView,
  SessionSandbox,
} from "@agentswf/contract/records";
import {
  type AgentSkills,
  findHarness,
  forkRecordedSession,
  HARNESSES,
  type Harness,
  hostHome,
  launchSettings,
  type RunProcess,
  runAttached,
  runProcess,
  sandboxedArgs,
  sandboxedOperatorArgs,
  skillsLaunch,
} from "@agentswf/harness";
import type { SandboxProviders } from "@agentswf/sandbox";
import { installSandboxedDoor } from "./agent-launcher";
import { messageOf } from "./errors";
import help from "./help/open.txt" with { type: "text" };
import { coordinatorDir } from "./machine";
import { listOps, opFile } from "./ops";
import { asksJson, printRefusal } from "./refusals";
import { failed, type Out, parsePlace, type ReadPlace, shellLine } from "./run-commands";
import { readRunLines } from "./run-lines";
import {
  type ClaimHolder,
  claimNow,
  releaseClaim,
  runLockFile,
  runOpenFile,
  withRunLock,
} from "./run-lock";
import { findRunByRef, RunNotFound, type RunStatus } from "./run-state";
import { isLive, readAttempts, workDir } from "./runs";
import { refreshHome, type SeededHome } from "./sandbox-homes";
import { type ReopenedPlace, reopenSandbox } from "./sandboxes";
import { type Launch, wake } from "./wake";

export const openUsage = help.trimEnd();

type Environment = Readonly<Record<string, string | undefined>>;
type SessionLine = RunView["sessions"]["all"][number];

/** A harness's TUI, run on this terminal: its exit code once it ends. */
export type Attach = (input: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** A sandbox's command, which gets exactly `env` and nothing of this process's. */
  exact?: true;
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
  /** The operator's sandbox providers, which reopen a sandboxed agent's place. */
  providers?: () => Promise<SandboxProviders>;
  /** The CLI's cancel, at SIGINT, SIGTERM or SIGHUP: ends a fork or a `-p` question. */
  signal?: AbortSignal;
};

/** What a sandboxed agent's `wfa` does in a reopened place: nothing reaches the run. */
const INERT_WFA = `console.error("wfa: this session was opened with awf open, outside its run; nothing reaches the run");
process.exit(1);
`;

/**
 * How long a person's TUI in a sandbox may stay open. A docker box lives as long, so one an `awf
 * open` killed outright left behind is gone within a day.
 */
const TUI_TIMEOUT_MS = 24 * 60 * 60_000;

/** What a TUI in a sandbox is given of the operator's terminal, which a provider's environment drops. */
const TERMINAL_ENVIRONMENT = ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE"];

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
    const skills = where.skills
      ? await skillsLaunch(where.harness, where.skills, environment)
      : undefined;
    // On the host, a home of its own is pointed at here; in a sandbox, by the provider.
    const env: Record<string, string> = {
      ...(where.home && !where.sandbox ? hostHome(where.harness, where.home, environment).env : {}),
      ...skills?.env,
    };
    const webSearch = where.sandbox?.spec.webSearch === true;
    const launchArgs = (person: boolean) => [
      ...(where.sandbox
        ? (person ? sandboxedOperatorArgs : sandboxedArgs)(where.harness, webSearch)
        : []),
      ...(skills?.args ?? []),
    ];
    const turnContext = (sessionHint: string) => ({
      ...settings,
      sessionHint,
      launchArgs: launchArgs(false),
      ...(where.home ? { home: where.home } : {}),
    });
    const hostRun = context.run ?? runProcess;
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
    const held = options.noFork
      ? await holdRun(status, options.agent, place, where.sandbox !== undefined)
      : undefined;
    let box: ReopenedPlace | undefined;
    let doors: string | undefined;
    let boxClaim: { file: string; held: ClaimHolder } | undefined;
    let ownHome: SeededHome | undefined;
    let finished: Promise<void> | undefined;
    // The sandbox closed first, then the run let go: an attempt the release wakes finds it closed.
    const finish = () => {
      finished ??= (async () => {
        await ownHome
          ?.writeBack()
          .catch((error: unknown) =>
            out.stderr(`awf: ${options.agent}'s login was not handed back: ${messageOf(error)}`),
          );
        for (const failure of (await box?.close()) ?? [])
          out.stderr(`awf: the sandbox did not close cleanly: ${failure}`);
        if (doors) await rm(doors, { recursive: true, force: true });
        if (boxClaim) await releaseClaim(boxClaim.file, boxClaim.held);
        await held?.release(out, context);
      })();
      return finished;
    };
    try {
      // Read again once held: an attempt that ended meanwhile may have recorded a newer session.
      if (held && (await agentPlace(status, options)).session !== where.session)
        throw new OpenRefused(
          `${options.agent}'s session changed as the run was held; open it again: ${shellLine(["awf", "open", status.ref, options.agent, "--no-fork", ...place.repeat])}`,
          "live",
        );
      // A home of its own on the host holds the login copied when the run started: refreshed from
      // the operator's now, and a refresh handed back at the end, as a run's turns do.
      if (where.home && !where.sandbox)
        ownHome = await refreshHome(
          where.home,
          hostHome(where.harness, where.home, environment),
          new Map(),
        ).catch((error: unknown) => {
          throw new OpenRefused(messageOf(error), "unreachable");
        });
      if (where.sandbox) {
        // A provider keeps a sandbox's open state in its directory: the run's own sandbox, open
        // while an attempt runs, or another awf open's, would be broken by this one's close.
        const plain = shellLine(["awf", "open", status.ref, options.agent, ...place.repeat]);
        if ((await readAttempts(status.run)).some((attempt) => isLive(attempt)))
          throw new OpenRefused(
            `${status.ref} is running, and ${options.agent}'s sandbox is open in it; open it once the run is parked or done: ${plain}`,
            "live",
          );
        const file = `${where.sandbox.directory}.open`;
        const claimed = await claimNow(file);
        if ("heldBy" in claimed)
          throw new OpenRefused(
            `${options.agent}'s sandbox is open in another awf open (pid ${claimed.heldBy.pid}); open it once that exits: ${plain}`,
            "opened",
          );
        boxClaim = { file, held: claimed.held };
        doors = await mkdtemp(join(tmpdir(), "awf-open-"));
        const door = await installSandboxedDoor(
          doors,
          join(doors, "open.sock"),
          INERT_WFA,
          spec.sessionEnv,
        );
        const providers = context.providers ? await context.providers() : { installed: {} };
        box = await reopenSandbox(
          where.sandbox,
          { harness: where.harness, model: settings.model, cwd: where.cwd, home: where.home! },
          {
            providers,
            runRoot: status.run.root,
            door,
            // The box lives as long as what runs in it may: a docker box ends at its deadline.
            deadline: {
              unixMilliseconds:
                Date.now() + (text === undefined ? TUI_TIMEOUT_MS : PRINT_TIMEOUT_MS + 10 * 60_000),
            },
            environment,
            machineHome: home,
            coordinatorRoot: coordinatorDir(home, environment),
          },
        ).catch((error: unknown) => {
          throw new OpenRefused(
            `${options.agent}'s ${where.sandbox!.provider} sandbox could not be opened again: ${messageOf(error)}`,
            "unreachable",
          );
        });
      }
      const occupant = box?.occupant;
      const run: RunProcess = occupant
        ? (input) => {
            const { holdStdinUntil, onStdoutLine, timeoutAt, ...process } = input as Parameters<
              typeof runProcess
            >[0] & { holdStdinUntil?: (line: string) => boolean };
            return hostRun({
              ...occupant.launch(process as Parameters<typeof occupant.launch>[0]),
              ...(holdStdinUntil ? { holdStdinUntil } : {}),
              ...(onStdoutLine ? { onStdoutLine } : {}),
              ...(timeoutAt ? { timeoutAt } : {}),
            });
          }
        : hostRun;
      let session = where.session;
      let forkedFrom: string | undefined;
      if (!where.copy && !options.noFork) {
        forkedFrom = session;
        const forked = await forkRecordedSession(
          where.harness,
          session,
          { cwd: where.cwd, env, context: turnContext(session) },
          run,
          context.signal ? { signal: context.signal } : {},
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
        const result = await run({
          argv: plan.argv,
          cwd: where.cwd,
          env,
          ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
          timeoutMs: PRINT_TIMEOUT_MS,
          signal: context.signal ?? new AbortController().signal,
        });
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
        await finish();
        out.stderr(`again: ${again}`);
        return 0;
      }
      const { model, effort } = settings;
      out.stderr(
        [
          options.agent,
          [where.harness, model, effort].filter(Boolean).join(" "),
          ...(where.sandbox ? [where.sandbox.provider] : []),
          forkedFrom
            ? `a copy of ${forkedFrom}`
            : held
              ? `session ${session}, the run held until you exit`
              : `session ${session}`,
        ].join(" · "),
      );
      // A Ctrl-C while the place was made is the operator's no; once the TUI has the terminal, it is the TUI's.
      if (context.signal?.aborted)
        throw new OpenRefused(
          `interrupted before the TUI opened; open it again: ${again}`,
          "internal-error",
        );
      const plan = spec.operatorResume!(session, settings, launchArgs(true));
      const attach =
        context.attach ?? ((input) => runAttached(input, input.exact ? {} : environment));
      let code: number;
      if (occupant) {
        const terminal = Object.fromEntries(
          TERMINAL_ENVIRONMENT.flatMap((name) => {
            const value = environment[name];
            return value === undefined ? [] : [[name, value]];
          }),
        );
        const command = occupant.launch({
          argv: plan.argv,
          cwd: where.cwd,
          env: { ...terminal, ...env },
          timeoutMs: TUI_TIMEOUT_MS,
          terminal: true,
        });
        try {
          code = await attach({
            argv: command.argv,
            cwd: where.cwd,
            env: command.env ?? {},
            exact: true,
          });
        } finally {
          await command.reap?.().catch(() => undefined);
        }
      } else code = await attach({ argv: plan.argv, cwd: where.cwd, env });
      await finish();
      out.stderr(`again: ${again}`);
      return code;
    } finally {
      // Once, by whichever comes first; a refusal or a throw lets go here.
      await finish();
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
async function holdRun(
  status: RunStatus,
  agent: string,
  place: ReadPlace,
  sandboxed: boolean,
): Promise<Held> {
  const { run, ref } = status;
  const { workflow, id } = run.record;
  const file = runOpenFile(run.root, workflow, id);
  const plain = shellLine(["awf", "open", ref, agent, ...place.repeat]);
  // A sandboxed agent's copy reopens its sandbox, which a live attempt has open.
  const instead = sandboxed
    ? `open a copy once the run is parked or done: ${plain}`
    : `a copy opens anyway: ${plain}`;
  const live = () =>
    readAttempts(run).then((attempts) => attempts.find((attempt) => isLive(attempt)));
  const running = () =>
    new OpenRefused(
      `${ref} is running, and ${agent}'s session may be written as you type; ${instead}`,
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
    try {
      if (await live()) throw running();
    } catch (error) {
      await releaseClaim(file, claimed.held);
      throw error;
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
  /** The sandbox it ran in, reopened for it. */
  sandbox?: SessionSandbox;
  /** The skills its harness was given, given again. */
  skills?: AgentSkills;
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
  const line = named ?? (await copysLine(view.sessions.all, agent, options.session)) ?? latest;
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
    // A home outside the run's folder is a sandbox's: a line written before it named the sandbox
    // says nothing of where it ran.
    if (!line.sandbox && !(await within(workDir(status.run.dir), line.home)))
      throw new OpenRefused(
        `${agent} ran in a sandbox this run did not record, so it cannot be reopened where it ran`,
        "unreachable",
      );
    home = line.home;
  }
  if (line.sandbox && home === undefined)
    throw new OpenRefused(`${agent}'s session line names a sandbox but no home`, "unreachable");
  let skills: AgentSkills | undefined;
  if (line.skills) {
    if (!(await isDirectory(line.skills.directory)))
      throw new OpenRefused(
        `${agent}'s skills were in ${line.skills.directory}, which is gone`,
        "unreachable",
      );
    skills = {
      names: line.skills.names,
      directory: line.skills.directory,
      sandboxed: line.sandbox !== undefined,
      ...(line.sandbox === undefined && home !== undefined ? { ownHome: home } : {}),
    };
  }
  return {
    harness: line.harness as Harness,
    session: options.session ?? latest.session,
    copy: options.session !== undefined && named === undefined,
    line,
    execution: op.execution,
    cwd,
    ...(home === undefined ? {} : { home }),
    ...(line.sandbox ? { sandbox: line.sandbox } : {}),
    ...(skills ? { skills } : {}),
  };
}

/**
 * The line a copy was made from, by the home that holds it: an agent with a home of its own gets a
 * new one each attempt, and a copy is made in its source's. Every harness names a session's files
 * for its id. None for an agent on the operator's home, whose latest line places it as well.
 */
async function copysLine(
  lines: readonly SessionLine[],
  agent: string,
  session: string | undefined,
): Promise<SessionLine | undefined> {
  if (session === undefined) return undefined;
  const seen = new Set<string>();
  for (const line of lines.toReversed()) {
    if (line.agent !== agent || line.home === undefined || seen.has(line.home)) continue;
    seen.add(line.home);
    const names = await readdir(line.home, { recursive: true }).catch(() => [] as string[]);
    if (names.some((name) => name.includes(session))) return line;
  }
  return undefined;
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
