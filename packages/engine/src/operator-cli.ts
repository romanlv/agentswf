#!/usr/bin/env -S bun --no-env-file
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { JsonObject, JsonValue } from "@agentswf/contract/workflow";
import { handBack, type RunProcess } from "@agentswf/harness";
import manifest from "../package.json" with { type: "json" };
import { stageFigures } from "./accounting/format";
import {
  type AttemptEnd,
  cleanupFailed,
  decideEnding,
  endedBeforeStart,
  type Finished,
  signalExitCode,
} from "./attempt-ending";
import { type Kept, keepRecords } from "./attempt-output";
import { printEnding, toldOf } from "./attempt-view";
import { messageOf } from "./errors";
import { type Caller, showOwnTab, startHere, takeCaller } from "./here";
import { machinePaths, sandboxesDirOf } from "./machine";
import {
  herdrConfig,
  installOperatorRuntime,
  type OperatorRuntimeInstallation,
} from "./operator-runtime";
import { ANSI, type Terminal, watchProgress } from "./progress-view";
import { parseCommand, type RunCommand, usage } from "./run-command";
import {
  claimNext,
  continueCommand,
  loadAndPrepare,
  type PreparedRun,
  workspaceLabel,
} from "./run-prepare";
import { type Attempt, createRun, discardRun, type Run, RunRefused } from "./runs";
import type { WorkflowStopped } from "./stopped";
import { parseTestCommand, runWorkflowTests, type TestCommand, testUsage } from "./test-command";
import type { LoadedWorkflow } from "./workflow-loader";
import { startWorkflow } from "./workflow-runner";

/** What the CLI reaches the machine through; each is the real one when absent. */
export type OperatorEnvironment = {
  cwd?: string;
  home?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  installRuntime?: (
    timeoutMilliseconds: number,
    options: { watchSandboxes: boolean; caller?: Caller },
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
};

type Output = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  terminal: Terminal | undefined;
  now: () => number;
};

export async function runOperatorCli(
  argv: readonly string[],
  environment: OperatorEnvironment = {},
): Promise<number> {
  const stdout = environment.stdout ?? ((text) => console.log(text));
  const stderr =
    environment.stderr ??
    stderrLines((text) => void process.stderr.write(text), {
      color: process.stderr.isTTY && !process.env.NO_COLOR,
    });
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
  if (argv.length === 1 && argv[0] === "--version") {
    stdout(describeVersion());
    return 0;
  }
  if (argv[0] === "test") return testCommand(argv.slice(1), environment, stdout, stderr);
  let command: RunCommand;
  try {
    command = parseCommand(argv, environment.cwd ?? process.cwd());
  } catch (error) {
    stderr(`awf: ${messageOf(error)}\n\n${usage}`);
    return 2;
  }
  if (command.here) return startHere(argv, command, environment, stdout, stderr);
  // The session that started a `--session` run waits on it, and its tab opened unfocused: until the
  // run takes the session over, a refusal is said where the operator will look.
  const unstarted = async (exitCode: number) => {
    if (command.session !== undefined) await showOwnTab(environment);
    return exitCode;
  };
  const home = environment.home ?? homedir();
  const { sandboxes, callers } = machinePaths(home);
  if (!relative(command.runRoot, sandboxes).startsWith("..")) {
    stderr(
      `awf: --run-root ${command.runRoot} holds ${sandboxes}, which every sandbox must reach and none may reach the run root`,
    );
    return unstarted(2);
  }
  const ready = await loadAndPrepare(command, now());
  if ("refused" in ready) {
    stderr(`awf: ${ready.refused}`);
    return unstarted(2);
  }
  for (const line of ready.prepared.continued?.warnings ?? []) stderr(line);

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
  return runAttempt(command, ready, calling, environment, home, { stdout, stderr, terminal, now });
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
  const { stdout, stderr, terminal, now } = output;
  const { executable } = loaded;
  const { meta } = executable.definition;
  /** The run, once it is claimed. */
  let run: Run | undefined;
  // Once the run has taken the session over, however it ends, the session gets it back.
  const handOver = async (ended: string) => {
    if (!calling) return;
    calling.release();
    const failed = await handBack(
      herdrConfig(calling.caller.session),
      calling.caller.pane.paneId,
      `[awf] The workflow ${meta.name}${run ? `, run ${run.record.id},` : ""} ${ended}. The run is over and this session is yours; nothing here needs an answer.`,
      environment.herdr,
    );
    if (failed) stderr(`awf: the calling session was not told the run ended: ${failed}`);
  };

  const refuse = async (why: string) => {
    stderr(`awf: ${why}`);
    await handOver(`did not start: ${why}`);
    return 2;
  };
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
    attempt = await claimNext(run, loaded, command, stderr, now());
  } catch (error) {
    // A run this call created and never ran is not left to hold its id.
    if (!prepared.continued) await discardRun(run).catch(() => undefined);
    return refuse(messageOf(error));
  }
  const { id, cwd } = run.record;
  const sandbox = run.record.sandbox ?? undefined;
  const n = attempt.record.attempt;
  const goOn = (stop?: WorkflowStopped) => continueCommand(command, id, stop);
  const records = { attempt, executable, workflow: { name: meta.name, file: loaded.file }, stderr };
  // Every way out from here writes the attempt's ending, before the hand-back: a session told the
  // run is over may continue it at once. One that never does is interrupted.
  const endUnstarted = async (end: AttemptEnd) => {
    await handOver(toldOf(end, await keepRecords(end, records)));
    return end.exitCode;
  };
  // Timed from here: finding the calling session can take minutes the run itself never had.
  const startedAt = now();
  const deadline = { unixMilliseconds: startedAt + command.timeoutMilliseconds };
  let installed: OperatorRuntimeInstallation;
  try {
    installed = await (environment.installRuntime ?? installOperatorRuntime)(
      command.timeoutMilliseconds,
      { watchSandboxes: command.watch, ...(calling ? { caller: calling.caller } : {}) },
    );
  } catch (error) {
    stderr(`awf: runtime: ${messageOf(error)}`);
    return endUnstarted(
      endedBeforeStart({ kind: "failed", reason: `runtime: ${messageOf(error)}` }, goOn()),
    );
  }
  // Installing the runtime probes two subscription logins, with nothing listening to the signal
  // either.
  if (environment.signal?.aborted) {
    await installed.cleanup().catch(() => undefined);
    cancelledBeforeStart(environment.signal, stderr);
    return endUnstarted(
      endedBeforeStart({ kind: "cancelled", signal: environment.signal }, goOn()),
    );
  }

  let finished: Finished;
  const progress = watchProgress(`${meta.name} ${id}${n > 1 ? ` · attempt ${n}` : ""}`, startedAt, {
    stderr,
    terminal,
    now,
  });
  try {
    const handle = await startWorkflow(executable.definition, prepared.args, {
      runRoot: run.root,
      run: {
        dir: run.dir,
        id,
        attempt: n,
        label: workspaceLabel(meta.name, id, n),
        ...(command.fromStage === undefined ? {} : { fromStage: command.fromStage }),
      },
      runtime: installed.config,
      sandboxes: {
        providers: installed.sandboxes ?? { installed: {} },
        sandboxesDir: sandboxesDirOf(home, run.record),
        ...(sandbox === undefined ? {} : { run: sandbox }),
      },
      ...(installed.decisions ? { decisions: installed.decisions } : {}),
      deadline,
      cwd,
      ...(environment.signal ? { signal: environment.signal } : {}),
      onLog: (logMessage, fields?: JsonObject) =>
        progress.log(fields ? `${logMessage} ${JSON.stringify(fields)}` : logMessage),
    });
    progress.watch(handle);
    finished = { result: await handle.result };
  } catch (error) {
    finished = { error };
  }

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
      end = cleanupFailed(end, error, goOn());
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
  return printEnding(end, kept, {
    executable,
    run: { id, dir: run.dir },
    n,
    earlier: prepared.continued?.attempts ?? [],
    json: command.json,
    fromStage: command.fromStage !== undefined,
    shellCwd: command.shellCwd,
    ...(cleanupAlso === undefined ? {} : { cleanupAlso }),
    ...(terminal ? { terminal } : {}),
    stdout,
    stderr,
  });
}

/** `awf test`: the workflow tests under the given paths, with Bun's test runner. */
async function testCommand(
  argv: readonly string[],
  environment: OperatorEnvironment,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  let tests: TestCommand | "help";
  try {
    tests = parseTestCommand(argv, environment.cwd ?? process.cwd());
  } catch (error) {
    stderr(`awf: ${messageOf(error)}\n\n${testUsage}`);
    return 2;
  }
  if (tests === "help") {
    stdout(testUsage);
    return 0;
  }
  const captured = environment.stdout || environment.stderr ? { stdout, stderr } : undefined;
  return runWorkflowTests(tests, environment.cwd ?? process.cwd(), {
    ...(environment.signal ? { signal: environment.signal } : {}),
    ...(captured ? { output: captured } : {}),
  });
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

if (import.meta.main) {
  const controller = new AbortController();
  const stop = cancelOnSignals(controller);
  try {
    process.exitCode = await runOperatorCli(process.argv.slice(2), { signal: controller.signal });
  } finally {
    stop();
  }
}
