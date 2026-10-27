#!/usr/bin/env -S bun --no-env-file
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { HarnessAllowance } from "@agentswf/contract/records";
import type { JsonObject, JsonValue } from "@agentswf/contract/workflow";
import { type Harness, handBack, type RunProcess } from "@agentswf/harness";
import manifest from "../package.json" with { type: "json" };
import { stageFigures } from "./accounting/format";
import { allowanceCommand } from "./allowance-command";
import {
  type AttemptEnd,
  cleanupFailed,
  decideEnding,
  endedBeforeStart,
  type Finished,
  type GoOn,
  signalExitCode,
} from "./attempt-ending";
import { type Kept, keepRecords } from "./attempt-output";
import { continueCommand, printEnding, toldOf } from "./attempt-view";
import { type CommandName, helpOf, index, isCommand, reference, unknownCommand } from "./commands";
import {
  type LineReader,
  promptCoordinator,
  replyHints,
  terminalReader,
} from "./coordinator-prompt";
import { coordinatorSocket, prepareCoordinatorDir } from "./coordinator-socket";
import { EmitError, emitEvent, openEventRun } from "./emit";
import { emitCommand } from "./emit-command";
import { messageOf } from "./errors";
import { type Caller, showOwnTab, startHere, takeCaller } from "./here";
import { holderCommand } from "./holder-command";
import { inboxCommand } from "./inbox-command";
import { initCommand } from "./init-command";
import { logsCommand } from "./logs-command";
import { coordinatorDir, machinePaths, sandboxesDirOf } from "./machine";
import {
  allowanceReader,
  herdrConfig,
  installOperatorRuntime,
  type OperatorRuntimeInstallation,
  type RunSession,
} from "./operator-runtime";
import { ANSI, describeRunSession, type Terminal, watchProgress } from "./progress-view";
import { parseCommand, type RunCommand, usage } from "./run-command";
import { placeFlags, shellLine, startedLine } from "./run-commands";
import { runLockFile, withRunLock } from "./run-lock";
import { claimNext, loadAndPrepare, type PreparedRun, workspaceLabel } from "./run-prepare";
import { findRun } from "./run-state";
import { type Attempt, createRun, discardRun, endAttempt, type Run, RunRefused } from "./runs";
import { runsCommand } from "./runs-command";
import { stopCrashed } from "./stop-crashed";
import { testCommand } from "./test-command";
import { tickCommand } from "./tick-command";
import type { Launch } from "./wake";
import type { LoadedWorkflow } from "./workflow-loader";
import {
  type RunWorkflowOptions,
  startWorkflow,
  WorkflowCancelledError,
  type WorkflowRunHandle,
} from "./workflow-runner";

/** What the CLI reaches the machine through; each is the real one when absent. */
export type OperatorEnvironment = {
  cwd?: string;
  home?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  installRuntime?: (
    timeoutMilliseconds: number | undefined,
    options: {
      watchSandboxes: boolean;
      caller?: Caller;
      home?: string;
      onRunSession?: (session: RunSession) => void;
    },
  ) => Promise<OperatorRuntimeInstallation>;
  /** Given, progress is redrawn in place on it; otherwise each change is a line on stderr. */
  terminal?: Terminal;
  bunVersion?: string;
  /** Runs `herdr` for `--here` and `--session`. */
  herdr?: RunProcess;
  environment?: Readonly<Record<string, string | undefined>>;
  /** The command that runs this awf, which `--here` types into the run's tab. */
  self?: readonly string[];
  /** How long `--session` looks for the pane showing its code. */
  callerSearchMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** What `awf init` runs to install, in the folder it set up. */
  install?: (dir: string) => Promise<number>;
  /** How `awf allowance` reads a harness's plan. */
  readAllowance?: (harness: Harness) => Promise<HarnessAllowance>;
  /** Starts or continues an event run's attempt for `awf emit`; absent, a detached `awf run`. */
  launch?: Launch;
  /**
   * Where agents may `--await-reply`, past the engine's list: for the live checks that decide
   * what goes on it (story 029's M2 gate).
   */
  awaitReply?: RunWorkflowOptions["awaitReply"];
  /** Answers for the run's coordinators in place of a person: for the live checks of story 032. */
  coordinators?: RunWorkflowOptions["coordinators"];
  /**
   * Given, stdin is a terminal and these are the lines typed at it: `awf run` asks a coordinator's
   * questions there. Absent, it is so when stdin and stderr are both terminals.
   */
  lines?: LineReader;
  /** What `awf reply` and `awf send` read their text from without an argument; stdin otherwise. */
  stdin?: () => Promise<string>;
};

type Output = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** For what awf says beside a problem rather than about one, which is never painted. */
  notice: (text: string) => void;
  terminal: Terminal | undefined;
  now: () => number;
};

export async function runOperatorCli(
  argv: readonly string[],
  environment: OperatorEnvironment = {},
): Promise<number> {
  const stdout = environment.stdout ?? ((text) => console.log(text));
  const write = (text: string) => void process.stderr.write(text);
  const stderr =
    environment.stderr ??
    stderrLines(write, { color: process.stderr.isTTY && !process.env.NO_COLOR });
  const notice = environment.stderr ?? ((text: string) => write(`${text}\n`));
  const terminal =
    environment.terminal ??
    (!environment.stderr && process.stderr.isTTY
      ? {
          write: (text: string) => void process.stderr.write(text),
          color: !process.env.NO_COLOR,
        }
      : undefined);
  const now = environment.now ?? Date.now;
  const tooOld = bunProblem(environment.bunVersion ?? Bun.version);
  if (tooOld) {
    stderr(`awf: ${tooOld}`);
    return 1;
  }
  const cwd = environment.cwd ?? process.cwd();
  const holder = () =>
    holderCommand(argv, cwd, {
      stdout,
      stderr,
      stdin: environment.stdin ?? (() => new Response(Bun.stdin.stream()).text()),
      ...(environment.stdin ? {} : { stdinIsTerminal: process.stdin.isTTY === true }),
      ...(environment.environment ? { environment: environment.environment } : {}),
      ...(environment.home ? { home: environment.home } : {}),
    });
  const wakes = {
    home: environment.home ?? homedir(),
    environment: environment.environment ?? process.env,
    ...(environment.launch ? { launch: environment.launch } : {}),
  };
  const handlers = {
    run: () => runCommand(argv, environment, { stdout, stderr, notice, terminal, now }),
    test: () => {
      const captured = environment.stdout || environment.stderr ? { stdout, stderr } : undefined;
      return testCommand(argv.slice(1), cwd, {
        stdout,
        stderr,
        ...(captured ? { output: captured } : {}),
        ...(environment.signal ? { signal: environment.signal } : {}),
      });
    },
    init: () =>
      initCommand(argv.slice(1), cwd, {
        stdout,
        stderr,
        ...(environment.install ? { install: environment.install } : {}),
      }),
    emit: () => emitCommand(argv.slice(1), cwd, { stdout, stderr }, wakes),
    tick: () => tickCommand(argv.slice(1), { stdout, stderr }, wakes),
    runs: () => runsCommand(argv.slice(1), cwd, { stdout, stderr }, Date.now(), wakes.home),
    logs: () => logsCommand(argv.slice(1), cwd, { stdout, stderr }, undefined, wakes.home),
    inbox: () =>
      inboxCommand(
        argv.slice(1),
        cwd,
        { stdout, stderr },
        { home: wakes.home, ...(environment.signal ? { signal: environment.signal } : {}) },
      ),
    reply: () => holder(),
    send: () => holder(),
    allowance: () =>
      allowanceCommand(argv.slice(1), {
        stdout,
        stderr,
        read:
          environment.readAllowance ??
          allowanceReader(
            environment.environment ?? process.env,
            undefined,
            environment.signal,
            environment.home ?? homedir(),
          ),
        now,
      }),
  } satisfies Record<CommandName, () => Promise<number>>;
  const [word, ...rest] = argv;
  if (word === undefined) {
    stdout(index());
    return 0;
  }
  if (word === "--version") {
    if (rest.length > 0) {
      stderr("awf: --version takes nothing after it; awf -h lists the commands");
      return 2;
    }
    stdout(describeVersion());
    return 0;
  }
  if (word === "help" || word === "-h" || word === "--help") return help(rest, stdout, stderr);
  if (isCommand(word)) return handlers[word]();
  stderr(unknownCommand(word));
  return 2;
}

/** `awf help`, `awf help {command}` and `awf help reference`; `-h` and `--help` are `help`. */
function help(
  words: readonly string[],
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): number {
  const [word] = words;
  if (words.length > 1) {
    stderr("awf: help takes one command; awf -h lists the commands");
    return 2;
  }
  if (word === undefined || word === "help" || word === "-h" || word === "--help") {
    stdout(index());
  } else if (word === "reference") {
    stdout(reference());
  } else if (isCommand(word)) {
    stdout(helpOf(word));
  } else {
    stderr(unknownCommand(word));
    return 2;
  }
  return 0;
}

/** `awf run`: parses it, then starts or continues the run, here or in a tab. */
/**
 * `awf run --id` for a workflow with events: the run is made with no event and started detached, as
 * an event starts one, so it runs to its first wait and parks; one already there is only woken.
 */
async function openRun(
  { loaded, id }: { loaded: LoadedWorkflow; id: string },
  environment: OperatorEnvironment,
  { stdout, stderr }: Output,
): Promise<number> {
  try {
    const opened = await openEventRun({ file: loaded.file, definition: loaded.keyed! }, id, {
      home: environment.home ?? homedir(),
      environment: environment.environment ?? process.env,
      ...(environment.launch ? { launch: environment.launch } : {}),
    });
    const did = opened.did === "none" ? opened.why : opened.did;
    stdout(
      `${opened.run}${opened.created ? "" : " was there"}${did === undefined ? "" : `: ${did}`}`,
    );
    if (opened.why !== "launch-failed") return 0;
    stderr(`awf: the run's attempt did not start: ${opened.error}`);
    return 1;
  } catch (error) {
    stderr(`awf: ${messageOf(error)}`);
    return error instanceof EmitError ? 2 : 1;
  }
}

async function runCommand(
  argv: readonly string[],
  environment: OperatorEnvironment,
  output: Output,
): Promise<number> {
  const { stdout, stderr, notice, terminal, now } = output;
  let parsed: RunCommand | "help";
  try {
    parsed = parseCommand(argv, environment.cwd ?? process.cwd());
  } catch (error) {
    stderr(`awf: ${messageOf(error)}\n\n${usage}`);
    return 2;
  }
  if (parsed === "help") {
    stdout(usage);
    return 0;
  }
  let command: RunCommand = parsed;
  const meant = await runNamed(command);
  if (meant) {
    const look = shellLine([
      "awf",
      "runs",
      meant,
      ...(command.cwdGiven ? ["--cwd", command.cwd] : []),
      ...(command.runRootGiven ? ["--run-root", command.runRoot] : []),
    ]);
    stderr(`awf: ${command.workflowFile} is not a workflow file; did you mean: ${look}`);
    return 2;
  }
  if (command.here) return startHere(argv, command, environment, stdout, stderr, notice);
  // The session that started a `--session` run waits on it, and its tab opened unfocused: until the
  // run takes the session over, a refusal is said where the operator will look.
  const unstarted = async (exitCode: number) => {
    if (command.session !== undefined) await showOwnTab(environment);
    return exitCode;
  };
  const home = environment.home ?? homedir();
  const { sandboxes, callers } = machinePaths(home);
  const ready = await loadAndPrepare(command, now(), home);
  if ("refused" in ready) {
    stderr(`awf: ${ready.refused}`);
    return unstarted(2);
  }
  if ("opens" in ready) return openRun(ready.opens, environment, output);
  // After loading: an event run's root is its project's, which this checks too.
  command = ready.command;
  if (!relative(command.runRoot, sandboxes).startsWith("..")) {
    stderr(
      `awf: --run-root ${command.runRoot} holds ${sandboxes}, which every sandbox must reach and none may reach the run root`,
    );
    return unstarted(2);
  }
  for (const line of ready.prepared.continued?.warnings ?? []) notice(line);

  // Loading the workflow imports operator-supplied code before anything listens to the signal, so
  // a Ctrl-C in it would otherwise be swallowed and have to be pressed again.
  if (environment.signal?.aborted) {
    return unstarted(cancelledBeforeStart(environment.signal, stderr));
  }
  let calling: { caller: Caller; release: () => void } | undefined;
  if (command.session !== undefined) {
    const taken = await takeCaller(command.session, callers, environment);
    if (typeof taken === "string") {
      stderr(`awf: --session: ${taken}`);
      return 1;
    }
    calling = taken;
    if (environment.signal?.aborted) {
      calling.release();
      return cancelledBeforeStart(environment.signal, stderr);
    }
  }
  return runAttempt(command, ready, calling, environment, home, {
    stdout,
    stderr,
    notice,
    terminal,
    now,
  });
}

/** The run `awf run {ref}` names where `{ref}` is no file: one meant for `awf runs`. */
async function runNamed(command: RunCommand): Promise<string | undefined> {
  if (existsSync(resolve(command.shellCwd, command.workflowFile))) return undefined;
  const found = await findRun(command.runRoot, command.workflowFile).catch(() => undefined);
  return found?.status.ref;
}

/**
 * Claims the run, new or continued, and its next attempt, runs it, and keeps its records; then
 * hands the calling session, if one was taken, back.
 */
async function runAttempt(
  command: RunCommand,
  { loaded, prepared }: { loaded: LoadedWorkflow; prepared: PreparedRun },
  calling: { caller: Caller; release: () => void } | undefined,
  environment: OperatorEnvironment,
  home: string,
  output: Output,
): Promise<number> {
  const { stdout, stderr, notice, terminal, now } = output;
  const { executable } = loaded;
  const { meta } = executable.definition;
  /** The run, once it is claimed. */
  let run: Run | undefined;
  // Once the run has taken the session over, however it ends, the session gets it back.
  let handedBack = false;
  const handOver = async (ended: string, stopped = false) => {
    if (!calling || handedBack) return;
    handedBack = true;
    calling.release();
    const failed = await handBack(
      herdrConfig(calling.caller.session),
      calling.caller.pane.paneId,
      `[awf] The workflow ${meta.name}${run ? `, run ${run.record.id},` : ""} ${ended}. ${stopped ? "This session was released from the run" : "The run is over"} and this session is yours; nothing here needs an answer.`,
      environment.herdr,
    );
    if (failed) stderr(`awf: the calling session was not told the run ended: ${failed}`);
  };

  const refuse = async (why: string) => {
    stderr(`awf: ${why}`);
    await handOver(`did not start: ${why}`);
    return 2;
  };
  // The operator's, never where the workflow's agents work.
  const coordinatorRoot = coordinatorDir(home, environment.environment ?? process.env);
  try {
    await prepareCoordinatorDir(
      coordinatorRoot,
      command.cwd,
      Boolean((environment.environment ?? process.env).AWF_COORDINATOR_DIR),
    );
  } catch (error) {
    return refuse(messageOf(error));
  }
  try {
    run =
      prepared.continued?.run ??
      (await createRun(command.runRoot, {
        ...(prepared.id === undefined ? {} : { id: prepared.id }),
        workflow: meta.name,
        argv: command.workflowArgs,
        cwd: command.cwd,
        sandbox: (command.sandbox ?? null) as JsonValue,
      }));
  } catch (error) {
    return refuse(
      `${error instanceof RunRefused ? "" : `${command.runRoot}: `}${messageOf(error)}`,
    );
  }
  let attempt: Attempt;
  try {
    attempt = await claimNext(run, loaded, command, notice, now());
  } catch (error) {
    // A run this call created and never ran is not left to hold its id.
    if (!prepared.continued) await discardRun(run).catch(() => undefined);
    return refuse(messageOf(error));
  }
  const { id, cwd } = run.record;
  const locked = <T>(work: () => Promise<T>) =>
    withRunLock(runLockFile(run.root, meta.name, id), work);
  const sandbox = run.record.sandbox ?? undefined;
  const n = attempt.record.attempt;
  // Claimed first, which `wake` waits for holding the run's lock; only then waited on: two
  // attempts never share an agent's session.
  const previous = prepared.continued?.attempts.at(-1);
  // An event run continued after a crash: what that attempt left working is stopped first (Q17).
  if (run.record.events && previous && previous.ended === undefined)
    await stopCrashed(previous, workspaceLabel(meta.name, run.record.id, previous.attempt), {
      home,
      environment: environment.environment ?? process.env,
    }).catch((error: unknown) =>
      notice(
        `awf: what attempt ${previous.attempt} left running was not all stopped: ${messageOf(error)}`,
      ),
    );
  const goOn: GoOn = (stop, entered) => continueCommand(command, id, stop, entered);
  const records = {
    attempt,
    executable,
    workflow: { name: meta.name, file: loaded.file },
    stderr,
    ...(!run.record.events ? {} : { locked }),
  };
  const close = (end: AttemptEnd, kept: Kept, cleanupAlso?: string) =>
    printEnding(end, kept, {
      executable,
      run: { id, dir: run.dir },
      n,
      earlier: prepared.continued?.attempts ?? [],
      json: command.json,
      fromStage: command.fromStage !== undefined,
      now: now(),
      shellCwd: command.shellCwd,
      home,
      ...(cleanupAlso === undefined ? {} : { cleanupAlso }),
      ...(terminal ? { terminal } : {}),
      stdout,
      stderr,
      notice,
    });
  // Timed from here: finding the calling session can take minutes the run itself never had.
  const startedAt = now();
  // Every way out from here writes the attempt's ending, before the hand-back: a session told the
  // run is over may continue it at once. One that never does is interrupted. A new run that never
  // started is not kept at all, so the same command starts it again, unless another attempt has
  // claimed it since: then its records are kept as a continued run's are.
  const deadline =
    command.timeoutMilliseconds === undefined
      ? undefined
      : { unixMilliseconds: startedAt + command.timeoutMilliseconds };
  const endUnstarted = async (error: unknown, cleanupAlso?: string) => {
    const end = endedBeforeStart(error, deadline, { runId: id, startedAt, endedAt: now() }, goOn);
    const cancelled = end.ending.kind === "cancelled";
    if (!prepared.continued && (await discardRun(run, attempt).catch(() => false))) {
      if (cleanupAlso) stderr(`awf: runtime cleanup also failed: ${cleanupAlso}`);
      const said = cancelled
        ? "run cancelled before it started"
        : `${end.ending.reason}; the run did not start`;
      stderr(`awf: ${said}, and nothing of it is kept`);
      await handOver(`did not start: ${cancelled ? "cancelled" : end.ending.reason}`);
      return end.exitCode;
    }
    const kept = await keepRecords(end, records);
    await handOver(toldOf(end, kept));
    return close(end, kept, cleanupAlso);
  };
  // Relied on: the session is told only from a pane agent's `openRun`, inside `startWorkflow`, by
  // when `placed` says it on the progress.
  let placed: (session: RunSession) => void = () => undefined;
  let installed: OperatorRuntimeInstallation;
  try {
    installed = await (environment.installRuntime ?? installOperatorRuntime)(
      command.timeoutMilliseconds,
      {
        watchSandboxes: command.watch,
        home,
        onRunSession: (session) => placed(session),
        ...(calling ? { caller: calling.caller } : { shellCwd: command.shellCwd }),
      },
    );
  } catch (error) {
    return endUnstarted(new Error(`runtime: ${messageOf(error)}`));
  }
  const cleanUp = () =>
    installed.cleanup().then(
      () => undefined,
      (error: unknown) => messageOf(error),
    );
  // Installing the runtime probes two subscription logins, with nothing listening to the signal
  // either.
  if (environment.signal?.aborted) {
    return endUnstarted(new WorkflowCancelledError(environment.signal.reason), await cleanUp());
  }

  // Before any agent starts; in a terminal, the progress block's header names the run instead.
  if (!terminal) notice(startedLine(meta.name, id, command));
  const progress = watchProgress(`${meta.name}/${id}${n > 1 ? ` · attempt ${n}` : ""}`, startedAt, {
    stderr,
    terminal,
    now,
  });
  placed = (session) => {
    progress.placedIn(session.name);
    const label = workspaceLabel(meta.name, id, n);
    const insideHerdr = (environment.environment ?? process.env).HERDR_ENV === "1";
    for (const line of describeRunSession(session, label, insideHerdr)) progress.log(line);
  };
  // Interactive: a coordinator's questions are asked here, unless the output is for a program.
  const reader =
    terminal && !command.json
      ? (environment.lines ?? (process.stdin.isTTY ? terminalReader() : undefined))
      : undefined;
  const prompt = reader && promptCoordinator(reader, progress);
  // Without a prompt, each question says how to answer it, so the run does not look stuck.
  const asked =
    prompt ??
    replyHints(`${meta.name}/${id}`, placeFlags(command), n, (line) => progress.log(line));
  progress.showsMessages((message) => asked.shows(message));
  const { events } = run.record;
  let nudge: (() => void) | undefined;
  const socket = coordinatorSocket({
    dir: coordinatorRoot,
    runDir: run.dir,
    attempt: n,
    ...(events ? { nudged: () => nudge?.() } : {}),
    failed: (reason) =>
      progress.log(
        `awf: the coordinator socket did not open, so awf reply and awf send cannot reach this run: ${reason}`,
      ),
  });
  const coordinators = [...(environment.coordinators ?? []), socket, asked];
  let handle: WorkflowRunHandle<JsonValue>;
  try {
    handle = await startWorkflow(executable.definition, prepared.args, {
      runRoot: run.root,
      run: {
        dir: run.dir,
        id,
        attempt: n,
        label: workspaceLabel(meta.name, id, n),
        ...(command.fromStage === undefined ? {} : { fromStage: command.fromStage }),
        ...(command.values === undefined ? {} : { values: command.values.stages }),
        ...(!events
          ? {}
          : {
              events,
              locked,
              listenNudges: (given) => {
                nudge = given;
              },

              // After a crash its agents start new sessions: a harness may still count the killed
              // writer as its session's, as codex's thread store did (story 034, task 6).
              resumeSessions: previous === undefined || previous.ended !== undefined,
              park: async () => {
                await endAttempt(attempt, { outcome: "parked" });
              },
            }),
      },
      emit: async (target, event, from) =>
        (
          await emitEvent(target, event, {
            from,
            home,
            environment: environment.environment ?? process.env,
            ...(environment.launch ? { launch: environment.launch } : {}),
          })
        ).outcome,
      runtime: installed.config,
      sandboxes: {
        providers: installed.sandboxes ?? { installed: {} },
        sandboxesDir: sandboxesDirOf(home, run.record),
        machineRoot: machinePaths(home).root,
        coordinatorRoot,
        ...(sandbox === undefined ? {} : { run: sandbox }),
      },
      ...(installed.decisions ? { decisions: installed.decisions } : {}),
      ...(installed.allowance ? { allowance: installed.allowance } : {}),
      deadline,
      cwd,
      ...(environment.signal ? { signal: environment.signal } : {}),
      ...(environment.awaitReply ? { awaitReply: environment.awaitReply } : {}),
      ...(coordinators.length > 0 ? { coordinators } : {}),
      onCallerStopped: () => handOver("stopped using this session", true),
      onLog: (logMessage, fields?: JsonObject) =>
        progress.log(fields ? `${logMessage} ${JSON.stringify(fields)}` : logMessage),
    });
  } catch (error) {
    prompt?.close();
    await socket.close();
    progress.stop();
    return endUnstarted(error, await cleanUp());
  }
  let finished: Finished;
  progress.watch(handle);
  try {
    finished = { result: await handle.result };
  } catch (error) {
    finished = { error };
  }
  prompt?.close();
  // Gone with the run: a holder now finds it ended.
  await socket.close();

  let end = decideEnding(finished, deadline, goOn);
  progress.stop(end.settled ? stageFigures(end.settled.accounting) : undefined);
  let kept: Kept;
  let cleanupAlso: string | undefined;
  if (end.ending.kind === "completed") {
    // Cleaned up before it is ended, as a failed cleanup fails it: ended, it lets the next attempt
    // start, whose records this one's would otherwise overwrite.
    try {
      await installed.cleanup();
    } catch (error) {
      end = cleanupFailed(end, error, goOn(undefined, end.ending.stages));
    }
    kept = await keepRecords(end, records);
  } else {
    // Ended before cleanup, so a second Ctrl-C during it leaves the attempt ended.
    kept = await keepRecords(end, records);
    try {
      await installed.cleanup();
    } catch (error) {
      cleanupAlso = messageOf(error);
    }
  }
  await handOver(toldOf(end, kept));
  return close(end, kept, cleanupAlso);
}

/**
 * Not `console.error`, which Bun paints red on a terminal: a workflow's log and the accounting
 * are ordinary lines. Only awf's own problems, which it prefixes `awf: `, are red: their first line.
 */
export function stderrLines(
  write: (text: string) => void,
  options: { color: boolean },
): (line: string) => void {
  return (text) => {
    if (!options.color || !text.startsWith("awf: ")) return write(`${text}\n`);
    const end = text.indexOf("\n");
    write(end < 0 ? `${ANSI.bad(text)}\n` : `${ANSI.bad(text.slice(0, end))}${text.slice(end)}\n`);
  };
}

function cancelledBeforeStart(signal: AbortSignal, stderr: (line: string) => void): number {
  stderr("awf: run cancelled before it started");
  return signalExitCode(signal.reason);
}

/** Why this Bun can't run awf, against the engine's `engines.bun`; undefined when it can. */
function bunProblem(running: string, required: string = manifest.engines.bun) {
  if (Bun.semver.satisfies(running, required)) return undefined;
  return `awf needs Bun ${required}, and this is Bun ${running}; bun upgrade installs a newer one`;
}

/** The engine's version, and the commit when it runs from a clone of this repository. */
function describeVersion(): string {
  const engine = resolve(import.meta.dir, "..");
  const git = (...args: string[]): string | undefined => {
    try {
      const done = Bun.spawnSync(["git", "-C", engine, ...args], { stderr: "ignore" });
      return done.success ? done.stdout.toString().trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const top = git("rev-parse", "--show-toplevel");
  // Installed inside someone else's repository, its commit would be theirs, not awf's.
  const inTop = top === undefined ? undefined : join(top, "packages/engine");
  const clone =
    inTop !== undefined && existsSync(inTop) && realpathSync(inTop) === realpathSync(engine);
  const commit = clone ? git("rev-parse", "--short", "HEAD") : undefined;
  return commit ? `awf ${manifest.version} (${commit})` : `awf ${manifest.version}`;
}

/** How soon a repeated signal is the copy `bun awf` forwards, not the operator pressing again. */
const REPEAT_MS = 1_000;

/**
 * Cancels `controller` at the first signal that asks the run to stop, and stops the process at
 * once at a second the operator sends, without the run's cleanup. Ctrl-C reaches the whole
 * process group and `bun awf` forwards it once more, so a repeat within `REPEAT_MS` is ignored:
 * taken as the second, it would kill the run mid-cleanup and leave its sandboxes behind. Returns
 * what removes the handlers.
 */
export function cancelOnSignals(
  controller: AbortController,
  exit: (code: number) => void = (code) => process.exit(code),
  now: () => number = Date.now,
): () => void {
  let first: number | undefined;
  const cancel = (signal: NodeJS.Signals) => {
    if (first === undefined) {
      first = now();
      controller.abort(signal);
    } else if (now() - first > REPEAT_MS) {
      exit(signalExitCode(signal));
    }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, cancel);
  return () => {
    for (const signal of signals) process.off(signal, cancel);
  };
}

/** Runs `awf` with this process's arguments and signals; `agentswf`'s bin calls it too. */
export async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = cancelOnSignals(controller);
  try {
    process.exitCode = await runOperatorCli(process.argv.slice(2), { signal: controller.signal });
  } finally {
    stop();
  }
}

if (import.meta.main) await main();
