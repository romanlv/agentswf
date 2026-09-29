#!/usr/bin/env -S bun --no-env-file
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { join, resolve } from "node:path";
import { OUTPUT_RECORD_VERSION, type OutputRecord } from "@agentswf/contract/records";
import {
  type AbsoluteDeadline,
  DeadlineExceededError,
  type ExecutableWorkflow,
  type JsonObject,
  type JsonValue,
} from "@agentswf/contract/workflow";
import manifest from "../package.json" with { type: "json" };
import { describeAccounting } from "./accounting/format";
import { installOperatorRuntime, type OperatorRuntimeInstallation } from "./operator-runtime";
import { ANSI, PLAIN, progressEvents, renderProgress } from "./progress-view";
import { assertJsonValue, loadWorkflowFile } from "./workflow-loader";
import {
  type SettledRun,
  startWorkflow,
  WorkflowCancelledError,
  WorkflowRunError,
  type WorkflowRunHandle,
  type WorkflowRunSnapshot,
} from "./workflow-runner";

const DEFAULT_TIMEOUT_MILLISECONDS = 30 * 60_000;

const usage = [
  "usage: awf run [options] <workflow-file> [options] [-- workflow arguments...]",
  "       awf --version",
  "options: --timeout <duration>, --run-root <directory>, --cwd <directory>, --json, --no-watch",
  "",
  "The deadline defaults to 30m. Run artifacts go to ~/.awf/runs unless --run-root says otherwise.",
  "A workflow that knows how to present its result prints that; --json prints the full result instead.",
  "Either way the full result is kept as output.json among the run's artifacts, beside report.md",
  "when the workflow writes one. A run that fails or is cancelled once its agents have started keeps",
  "output.json too, with what it spent and why it ended; --json prints it. A second Ctrl-C stops",
  "awf at once, without it.",
  "--cwd sets the directory the workflow and its agents work in; it defaults to the current one.",
  "A sandbox with its own Herdr, as a docker box has, gets a tab in the run's workspace showing its",
  "panes; --no-watch leaves it out, and awf still prints the command that shows them.",
  "",
  "Examples:",
  "  awf run examples/minimum-review/review-loop.ts",
  "  awf run --timeout 20m examples/minimum-review/review-loop.ts",
  "  awf run examples/minimum-review/review-loop.ts -- packages/engine/src",
  "  awf run examples/minimum-review/review-loop.ts --cwd ../other-repo",
  "",
  "Workflow files are trusted code and run with your filesystem and process authority.",
].join("\n");

type OperatorEnvironment = {
  cwd?: string;
  home?: string;
  now?: () => number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  installRuntime?: (
    timeoutMilliseconds: number,
    options: { watchSandboxes: boolean },
  ) => Promise<OperatorRuntimeInstallation>;
  signal?: AbortSignal;
  /** Given, progress is redrawn in place on it; otherwise each change is a line on stderr. */
  terminal?: { write(text: string): void; color: boolean };
  bunVersion?: string;
};

export async function runOperatorCli(
  argv: readonly string[],
  environment: OperatorEnvironment = {},
): Promise<number> {
  const stdout = environment.stdout ?? ((text) => console.log(text));
  const stderr = environment.stderr ?? ((text) => console.error(text));
  const terminal =
    environment.terminal ??
    (!environment.stderr && process.stderr.isTTY
      ? {
          write: (text: string) => void process.stderr.write(text),
          color: !process.env.NO_COLOR,
        }
      : undefined);
  const tooOld = bunProblem(environment.bunVersion ?? Bun.version);
  if (tooOld) {
    stderr(`awf: ${tooOld}`);
    return 1;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    stdout(describeVersion());
    return 0;
  }
  let command: RunCommand;
  try {
    command = parseCommand(argv, environment.cwd ?? process.cwd(), environment.home ?? homedir());
  } catch (error) {
    stderr(`awf: ${message(error)}\n\n${usage}`);
    return 2;
  }

  const startedAt = (environment.now ?? Date.now)();
  const deadline = { unixMilliseconds: startedAt + command.timeoutMilliseconds };
  let loaded: Awaited<ReturnType<typeof loadWorkflowFile>>;
  try {
    loaded = await loadWorkflowFile(command.workflowFile, command.shellCwd);
  } catch (error) {
    stderr(`awf: load: ${message(error)}`);
    return 2;
  }

  let args: JsonValue;
  try {
    args = loaded.executable.prepare({
      argv: command.workflowArgs,
      cwd: command.cwd,
    });
    assertJsonValue(args, `${loaded.executable.definition.meta.name} arguments`);
  } catch (error) {
    stderr(`awf: prepare: ${message(error)}`);
    return 2;
  }

  // Loading the workflow imports operator-supplied code, and installing the runtime probes two
  // subscription logins. Both run before anything is listening to the signal, so a Ctrl-C in that
  // window would otherwise be swallowed and have to be pressed again.
  if (environment.signal?.aborted) return interrupted(environment.signal, stderr);

  let installed: OperatorRuntimeInstallation;
  try {
    installed = await (environment.installRuntime ?? installOperatorRuntime)(
      command.timeoutMilliseconds,
      { watchSandboxes: command.watch },
    );
  } catch (error) {
    stderr(`awf: runtime: ${message(error)}`);
    return 1;
  }
  if (environment.signal?.aborted) {
    await installed.cleanup().catch(() => undefined);
    return interrupted(environment.signal, stderr);
  }

  const invocationRoot = join(command.runRoot, `invocation-${randomUUID()}`);
  let invocationRootCreated = false;
  let output: string | undefined;
  let runError: unknown;
  let failedRecord: string | undefined;
  const recordOf = (run: SettledRun) => ({
    version: OUTPUT_RECORD_VERSION,
    runId: run.runId,
    workflow: {
      name: loaded.executable.definition.meta.name,
      file: loaded.file,
    },
    accounting: run.accounting,
    usage: run.usage,
    artifacts: join(invocationRoot, run.runId),
    ...(run.sandboxes ? { sandboxes: run.sandboxes } : {}),
    ...(run.skills ? { skills: run.skills } : {}),
    ...(run.decisions ? { decisions: run.decisions } : {}),
  });
  try {
    await mkdir(invocationRoot, { recursive: true });
    invocationRootCreated = true;
    const progress = watchProgress(loaded.executable.definition.meta.name, startedAt, {
      stderr,
      terminal,
      now: environment.now ?? Date.now,
    });
    let result: Awaited<WorkflowRunHandle<JsonValue>["result"]>;
    try {
      const handle = await startWorkflow(loaded.executable.definition, args, {
        runRoot: invocationRoot,
        runtime: installed.config,
        // Every run under the run root is out of each sandbox's reach, not only this one.
        sandboxes: {
          providers: installed.sandboxes ?? { installed: {} },
          runRoot: command.runRoot,
        },
        ...(installed.decisions ? { decisions: installed.decisions } : {}),
        deadline,
        cwd: command.cwd,
        ...(environment.signal ? { signal: environment.signal } : {}),
        onLog: (logMessage, fields?: JsonObject) =>
          progress.log(fields ? `${logMessage} ${JSON.stringify(fields)}` : logMessage),
      });
      progress.watch(handle);
      result = await handle.result;
    } finally {
      progress.stop();
    }
    const artifacts = join(invocationRoot, result.runId);
    const report = await writeReport(loaded.executable, result.value, artifacts, stderr);
    const record: OutputRecord = {
      ...recordOf(result),
      outcome: "succeeded",
      value: result.value,
      ...(report ? { report } : {}),
    };
    const json = JSON.stringify(record, null, 2);
    await writeFile(join(artifacts, "output.json"), `${json}\n`);
    // Beside the result rather than in it: stdout stays the workflow's report or the JSON.
    for (const line of describeAccounting(result.accounting)) stderr(line);
    output = command.json
      ? json
      : (present(loaded.executable, result.value, artifacts, report, stderr) ?? json);
  } catch (error) {
    runError = error;
    if (error instanceof WorkflowRunError) {
      const record: OutputRecord = {
        ...recordOf(error),
        outcome: runOutcome(error, deadline),
        error: errorDetail(error),
      };
      failedRecord = JSON.stringify(record, null, 2);
      try {
        await writeFile(join(record.artifacts, "output.json"), `${failedRecord}\n`);
      } catch (writeError) {
        stderr(`awf: output.json: ${message(writeError)}`);
      }
      for (const line of describeAccounting(error.accounting)) stderr(line);
    }
  }
  let cleanupError: unknown;
  try {
    await installed.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (runError !== undefined) {
    const cancellation = findCancellation(runError);
    const ended = {
      cancelled: "run cancelled",
      "timed-out": "run timed out",
      failed: "run failed",
    }[runOutcome(runError, deadline)];
    stderr(
      invocationRootCreated
        ? `awf: ${ended}; artifacts retained under ${invocationRoot}: ${errorDetail(runError)}`
        : `awf: ${ended}; artifacts were not created at ${invocationRoot}: ${errorDetail(runError)}`,
    );
    if (cleanupError !== undefined)
      stderr(`awf: runtime cleanup also failed: ${message(cleanupError)}`);
    // The record says the run did not succeed, so a caller that asked for it gets it either way.
    if (command.json && failedRecord !== undefined) stdout(failedRecord);
    if (cancellation) {
      return signalExitCode(cancellation.reason);
    }
    return 1;
  }
  if (cleanupError !== undefined) {
    // Stdout stays empty: it is the result of a run whose teardown did not finish, and a caller
    // reading it without checking the exit code would take that for a clean one. The artifacts
    // are named instead, so the work is still reachable.
    stderr(
      `awf: runtime cleanup failed; artifacts retained under ${invocationRoot}: ${message(cleanupError)}`,
    );
    return 1;
  }
  stdout(output as string);
  return 0;
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
  const tick = () => {
    if (!handle) return;
    const snapshot = handle.inspect();
    if (terminal) {
      const lines = renderProgress(snapshot, {
        name,
        startedAt,
        now: now(),
        paint: terminal.color ? ANSI : PLAIN,
      });
      clear();
      terminal.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    } else {
      for (const line of progressEvents(last, snapshot, { startedAt, now: now() })) stderr(line);
    }
    last = snapshot;
  };
  // Lines too long for the terminal are clipped rather than wrapped, so the redraw stays exact.
  terminal?.write("\x1b[?25l\x1b[?7l");
  const timer = setInterval(tick, terminal ? 100 : 1000);
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
      tick();
      terminal?.write("\x1b[?7h\x1b[?25h");
    },
  };
}

function interrupted(signal: AbortSignal, stderr: (line: string) => void): number {
  stderr("awf: run cancelled before it started");
  return signalExitCode(signal.reason);
}

/** A shell's code for a process ended by `reason`, as if the signal had killed it. */
function signalExitCode(reason: unknown): number {
  const number = constants.signals[reason as keyof typeof constants.signals];
  return 128 + (number ?? constants.signals.SIGINT);
}

type RunCommand = {
  /** Where paths typed on the command line resolve. */
  shellCwd: string;
  /** Where the workflow and its agents work. */
  cwd: string;
  workflowFile: string;
  workflowArgs: string[];
  timeoutMilliseconds: number;
  runRoot: string;
  json: boolean;
  /** Whether each sandbox with its own Herdr gets a tab attached to it in the run's workspace. */
  watch: boolean;
};

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

function parseCommand(argv: readonly string[], cwd: string, home: string): RunCommand {
  if (argv[0] !== "run") throw new Error("expected the run command");
  let timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS;
  // Not under the working directory: that is usually the repository the workflow is looking at.
  let runRoot = join(home, ".awf/runs");
  let json = false;
  let watch = true;
  let workCwd = cwd;
  let workflowFile: string | undefined;
  // awf's own options may come before or after the workflow file; only `--` ends them.
  let index = 1;
  for (; index < argv.length && argv[index] !== "--"; index += 1) {
    const option = argv[index]!;
    if (!option.startsWith("--")) {
      if (workflowFile !== undefined) throw new Error("put -- before workflow arguments");
      workflowFile = option;
      continue;
    }
    if (option === "--json") {
      json = true;
      continue;
    }
    if (option === "--no-watch") {
      watch = false;
      continue;
    }
    const value = argv[index + 1];
    if (option === "--timeout") {
      if (!value) throw new Error("--timeout needs a duration such as 30m");
      timeoutMilliseconds = parseDuration(value);
    } else if (option === "--run-root") {
      if (!value) throw new Error("--run-root needs a directory");
      runRoot = resolve(cwd, value);
    } else if (option === "--cwd") {
      if (!value) throw new Error("--cwd needs a directory");
      workCwd = resolve(cwd, value);
      if (!statSync(workCwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`--cwd: not a directory: ${workCwd}`);
      }
    } else {
      throw new Error(`unknown option: ${option}; put workflow arguments after --`);
    }
    index += 1;
  }
  if (!workflowFile) throw new Error("run needs one workflow file");
  const workflowArgs = argv.slice(index + 1);
  return {
    shellCwd: cwd,
    cwd: workCwd,
    workflowFile,
    workflowArgs,
    timeoutMilliseconds,
    runRoot,
    json,
    watch,
  };
}

function present(
  executable: ExecutableWorkflow<JsonValue, JsonValue>,
  value: JsonValue,
  artifacts: string,
  report: string | undefined,
  stderr: (text: string) => void,
): string | undefined {
  if (!executable.present) return undefined;
  try {
    return [
      executable.present(value).trimEnd(),
      "",
      ...(report ? [`Report: ${report}`] : []),
      `Full result and agent records: ${artifacts}`,
    ].join("\n");
  } catch (error) {
    stderr(`awf: present: ${message(error)}; printing the full result instead`);
    return undefined;
  }
}

async function writeReport(
  executable: ExecutableWorkflow<JsonValue, JsonValue>,
  value: JsonValue,
  artifacts: string,
  stderr: (text: string) => void,
): Promise<string | undefined> {
  if (!executable.report) return undefined;
  // The result is still in output.json; a report that cannot be rendered or saved should not fail
  // the run, nor cost it its record.
  try {
    const markdown = executable.report(value);
    const file = join(artifacts, "report.md");
    await writeFile(file, `${markdown.trimEnd()}\n`);
    return file;
  } catch (error) {
    stderr(`awf: report: ${message(error)}; see output.json instead`);
    return undefined;
  }
}

function parseDuration(value: string): number {
  const matched = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!matched) throw new Error(`invalid duration: ${value}`);
  const amount = Number(matched[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`invalid duration: ${value}`);
  const unit = matched[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`duration is too large: ${value}`);
  return milliseconds;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetail(error: unknown): string {
  if (error instanceof WorkflowRunError) return errorDetail(error.cause);
  return error instanceof AggregateError
    ? error.errors.map(errorDetail).join("; ")
    : message(error);
}

function findCancellation(error: unknown): WorkflowCancelledError | undefined {
  if (error instanceof WorkflowCancelledError) return error;
  if (error instanceof WorkflowRunError) return findCancellation(error.cause);
  if (!(error instanceof AggregateError)) return undefined;
  for (const nested of error.errors) {
    const cancellation = findCancellation(nested);
    if (cancellation) return cancellation;
  }
  return undefined;
}

/**
 * How a run that did not succeed ended. The operator cancelling wins. It timed out when its own
 * deadline ended it: the body's failure, or the first error of its aggregate, is a deadline error
 * carrying the run's deadline. A deadline the workflow set and let escape is its own failure.
 */
export function runOutcome(
  error: unknown,
  deadline: AbsoluteDeadline,
): Exclude<OutputRecord["outcome"], "succeeded"> {
  if (findCancellation(error)) return "cancelled";
  const cause = error instanceof WorkflowRunError ? error.cause : error;
  const failure = cause instanceof AggregateError ? cause.errors[0] : cause;
  return failure instanceof DeadlineExceededError &&
    failure.deadline.unixMilliseconds === deadline.unixMilliseconds
    ? "timed-out"
    : "failed";
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
