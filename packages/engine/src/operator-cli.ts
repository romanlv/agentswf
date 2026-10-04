#!/usr/bin/env -S bun --no-env-file
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AttemptRecord } from "@agentswf/contract/records";
import type { JsonObject, JsonValue } from "@agentswf/contract/workflow";
import { handBack } from "@agentswf/harness";
import manifest from "../package.json" with { type: "json" };
import {
  type AttemptEnd,
  attemptEnd,
  cleanupFailed,
  ENDINGS,
  signalExitCode,
} from "./attempt-ending";
import { accountingLines, type Kept, keepRecords, present, tilde } from "./attempt-output";
import { messageOf } from "./errors";
import { type Caller, type HereEnvironment, startHere, takeCaller } from "./here";
import {
  herdrConfig,
  installOperatorRuntime,
  type OperatorRuntimeInstallation,
} from "./operator-runtime";
import { ANSI, PLAIN, progressEvents, renderProgress } from "./progress-view";
import { parseCommand, type RunCommand, usage } from "./run-command";
import {
  continueCommand,
  type PreparedRun,
  prepareRun,
  sameStop,
  workspaceLabel,
} from "./run-continue";
import {
  type Attempt,
  claimAttempt,
  createRun,
  discardRun,
  endAttempt,
  machinePaths,
  type Run,
  RunRefused,
  readTurns,
  sandboxesOf,
} from "./runs";
import type { WorkflowStopped } from "./stopped";
import { parseTestCommand, runWorkflowTests, type TestCommand, testUsage } from "./test-command";
import { type LoadedWorkflow, loadWorkflowFile } from "./workflow-loader";
import { startWorkflow, type WorkflowRunHandle, type WorkflowRunSnapshot } from "./workflow-runner";

type OperatorEnvironment = HereEnvironment & {
  cwd?: string;
  home?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  installRuntime?: (
    timeoutMilliseconds: number,
    options: { watchSandboxes: boolean; caller?: Caller },
  ) => Promise<OperatorRuntimeInstallation>;
  /** Given, progress is redrawn in place on it; otherwise each change is a line on stderr. */
  terminal?: { write(text: string): void; color: boolean };
  bunVersion?: string;
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
  const home = environment.home ?? homedir();
  const { sandboxes, callers } = machinePaths(home);
  if (!relative(command.runRoot, sandboxes).startsWith("..")) {
    stderr(
      `awf: --run-root ${command.runRoot} holds ${sandboxes}, which every sandbox must reach and none may reach the run root`,
    );
    return 2;
  }

  if (command.here) return startHere(argv, command, environment, stdout, stderr);

  let loaded: LoadedWorkflow;
  try {
    loaded = await loadWorkflowFile(command.workflowFile, command.shellCwd);
  } catch (error) {
    stderr(`awf: load: ${messageOf(error)}`);
    return 2;
  }
  const { executable } = loaded;
  const { meta } = executable.definition;

  let prepared: PreparedRun;
  try {
    prepared = await prepareRun(command, loaded, now());
  } catch (error) {
    stderr(`awf: ${error instanceof RunRefused ? "" : "prepare: "}${messageOf(error)}`);
    return 2;
  }
  for (const line of prepared.continued?.recorded ?? []) stderr(line);

  // Loading the workflow imports operator-supplied code, and installing the runtime probes two
  // subscription logins. Both run before anything is listening to the signal, so a Ctrl-C in that
  // window would otherwise be swallowed and have to be pressed again.
  if (environment.signal?.aborted) return interrupted(environment.signal, stderr);

  let caller: Caller | undefined;
  let releaseCaller: () => void = () => undefined;
  if (command.session !== undefined) {
    const taken = await takeCaller(command.session, callers, environment);
    if (typeof taken === "string") {
      stderr(`awf: --session: ${taken}`);
      return 1;
    }
    ({ caller, release: releaseCaller } = taken);
    if (environment.signal?.aborted) {
      releaseCaller();
      return interrupted(environment.signal, stderr);
    }
  }
  /** The run, once it is claimed. */
  let run: Run | undefined;
  // Once the run has taken the session over, however it ends, the session gets it back.
  const handOver = async (ended: string) => {
    if (!caller) return;
    releaseCaller();
    const failed = await handBack(
      herdrConfig(caller.session),
      caller.pane.paneId,
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
    attempt = await claimNext(run, loaded, command, stderr);
  } catch (error) {
    // A run this call created and never ran is not left to hold its id.
    if (!prepared.continued) await discardRun(run).catch(() => undefined);
    return refuse(messageOf(error));
  }
  const { id, cwd } = run.record;
  const sandbox = run.record.sandbox ?? undefined;
  const n = attempt.record.n;
  const named = `${meta.name} ${id}${n > 1 ? ` · attempt ${n}` : ""}`;
  // Every way out from here writes the attempt's ending, before the hand-back: a session told the
  // run is over may continue it at once. One that never does is interrupted.
  const endEarly = async (outcome: "failed" | "cancelled", reason: string, told: string) => {
    try {
      await endAttempt(attempt, { outcome, reason });
    } catch (error) {
      stderr(`awf: the attempt's ending was not written to ${attempt.file}: ${messageOf(error)}`);
    }
    await handOver(told);
  };
  // Timed from here: finding the calling session can take minutes the run itself never had.
  const startedAt = now();
  const deadline = { unixMilliseconds: startedAt + command.timeoutMilliseconds };
  let installed: OperatorRuntimeInstallation;
  try {
    installed = await (environment.installRuntime ?? installOperatorRuntime)(
      command.timeoutMilliseconds,
      { watchSandboxes: command.watch, ...(caller ? { caller } : {}) },
    );
  } catch (error) {
    stderr(`awf: runtime: ${messageOf(error)}`);
    await endEarly("failed", `runtime: ${messageOf(error)}`, `did not start: ${messageOf(error)}`);
    return 1;
  }
  if (environment.signal?.aborted) {
    await installed.cleanup().catch(() => undefined);
    await endEarly("cancelled", "cancelled before it started", "was cancelled before it started");
    return interrupted(environment.signal, stderr);
  }

  let finished: Parameters<typeof attemptEnd>[0];
  const progress = watchProgress(named, startedAt, { stderr, terminal, now });
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
      // Every run under the run root is out of each sandbox's reach, not only this one.
      sandboxes: {
        providers: installed.sandboxes ?? { installed: {} },
        runRoot: run.root,
        directory: sandboxesOf(home, run),
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
  } finally {
    progress.stop();
  }

  const goOn = (stop?: WorkflowStopped) => continueCommand(command, id, stop);
  const records = { attempt, executable, workflow: { name: meta.name, file: loaded.file }, stderr };
  let end = attemptEnd(finished, deadline, goOn);
  // Kept before cleanup, so a second Ctrl-C during it leaves the attempt ended.
  let kept = await keepRecords(end, records);
  let cleanupAlso: string | undefined;
  try {
    await installed.cleanup();
  } catch (error) {
    if (end.ending.kind === "completed") {
      end = cleanupFailed(end, error, goOn());
      kept = await keepRecords(end, records);
    } else {
      cleanupAlso = messageOf(error);
    }
  }
  const { ending } = end;
  const recorded = kept.output ? `; its record is ${kept.output}` : "";
  await handOver(
    ending.kind === "completed"
      ? `succeeded${recorded}`
      : `${ENDINGS[ending.kind].told}${recorded}: ${ending.reason}`,
  );
  return tell(end, kept, {
    command,
    executable,
    run,
    n,
    named,
    earlier: prepared.continued?.attempts ?? [],
    ...(cleanupAlso === undefined ? {} : { cleanupAlso }),
    stdout,
    stderr,
  });
}

/**
 * Prints how the attempt ended, and returns its exit code. A completed one's result goes to stdout;
 * otherwise stdout stays empty but for the record `--json` asks for, since a caller reading it
 * without checking the exit code would take it for a result.
 */
function tell(
  end: AttemptEnd,
  kept: Kept,
  context: {
    command: RunCommand;
    executable: LoadedWorkflow["executable"];
    run: Run;
    n: number;
    named: string;
    earlier: readonly AttemptRecord[];
    cleanupAlso?: string;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  },
): number {
  const { command, run, stdout, stderr } = context;
  const { ending, settled } = end;
  // Beside the result rather than in it: stdout stays the workflow's report or the JSON.
  const accounting = settled
    ? ["", ...accountingLines(run.record.id, context.n, settled.accounting, context.earlier)]
    : [];
  const report = kept.report ? [`Report: ${tilde(kept.report)}`] : [];
  if (ending.kind === "completed") {
    const json = kept.json ?? JSON.stringify(ending.value);
    stdout(command.json ? json : (present(context.executable, ending, stderr) ?? json));
    for (const line of [...accounting, ...report, `Records: ${tilde(run.dir)}`]) stderr(line);
    return 0;
  }
  for (const line of accounting) stderr(line);
  const stagedAt = ending.stage === undefined ? "" : ` in ${ending.stage}`;
  stderr(
    `awf: ${ENDINGS[ending.kind].ended}${stagedAt} (${context.named}); its records are in ${run.dir}: ${ending.reason}`,
  );
  if (end.alsoFailed) stderr(`awf: also failed: ${end.alsoFailed}`);
  const again = command.fromStage === undefined ? sameStop(ending, context.earlier) : undefined;
  if (again) stderr(`awf: ${again}`);
  stderr(`awf: to go on: ${ending.continue}`);
  for (const line of report) stderr(line);
  if (context.cleanupAlso) stderr(`awf: runtime cleanup also failed: ${context.cleanupAlso}`);
  if (command.json && kept.json !== undefined) stdout(kept.json);
  return end.exitCode;
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

/** Claims the run's next attempt, naming each earlier one found interrupted. */
async function claimNext(
  run: Run,
  loaded: LoadedWorkflow,
  command: RunCommand,
  stderr: (text: string) => void,
): Promise<Attempt> {
  const { meta } = loaded.executable.definition;
  const claimed = await claimAttempt(
    run,
    {
      file: loaded.file,
      ...(meta.version === undefined ? {} : { workflowVersion: meta.version }),
      flags: {
        timeout: command.timeout,
        ...(command.fromStage === undefined ? {} : { fromStage: command.fromStage }),
      },
    },
    { redo: command.fromStage !== undefined },
  );
  const turns = claimed.interrupted.length > 0 ? await readTurns(run.dir).catch(() => []) : [];
  for (const earlier of claimed.interrupted) {
    // Its last turn says the stage it was in, as nothing else it wrote does.
    const stage = turns.findLast((turn) => turn.attempt === earlier.n)?.stage;
    stderr(
      `awf: attempt ${earlier.n} of ${run.record.id} was interrupted${stage ? ` in ${stage}` : ""}; its panes may still be open in Herdr workspace "${workspaceLabel(meta.name, run.record.id, earlier.n)}"`,
    );
  }
  return claimed.attempt;
}

/**
 * Polls the run's snapshot. On a terminal it keeps one block redrawn under the log; elsewhere it
 * writes a line per change, so a log file or a calling agent reads what happened and when.
 */
function watchProgress(
  name: string,
  startedAt: number,
  output: {
    stderr: (text: string) => void;
    terminal: OperatorEnvironment["terminal"];
    now: () => number;
  },
) {
  const { stderr, terminal, now } = output;
  let handle: WorkflowRunHandle<JsonValue> | undefined;
  let last: WorkflowRunSnapshot | undefined;
  let drawn = 0;
  const clear = () => {
    if (terminal && drawn > 0) terminal.write(`\x1b[${drawn}F\x1b[0J`);
    drawn = 0;
  };
  const tick = (final = false) => {
    if (!handle) return;
    const snapshot = handle.inspect();
    if (terminal) {
      const lines = renderProgress(snapshot, {
        name,
        startedAt,
        now: now(),
        paint: terminal.color ? ANSI : PLAIN,
      });
      // The header's name and clock are the command's and the accounting's once the run is over.
      if (final) lines.shift();
      clear();
      if (lines.length > 0) terminal.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    } else {
      for (const line of progressEvents(last, snapshot, { startedAt, now: now() })) stderr(line);
    }
    last = snapshot;
  };
  // Lines too long for the terminal are clipped rather than wrapped, so the redraw stays exact.
  terminal?.write("\x1b[?25l\x1b[?7l");
  const timer = setInterval(() => tick(), terminal ? 100 : 1000);
  return {
    watch(started: WorkflowRunHandle<JsonValue>) {
      handle = started;
      tick();
    },
    log(text: string) {
      clear();
      stderr(text);
      if (terminal) tick();
    },
    stop() {
      clearInterval(timer);
      tick(true);
      terminal?.write("\x1b[?7h\x1b[?25h");
    },
  };
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

function interrupted(signal: AbortSignal, stderr: (line: string) => void): number {
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
