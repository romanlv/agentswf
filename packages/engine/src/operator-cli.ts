#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { OUTPUT_RECORD_VERSION, type OutputRecord } from "@wf/contract/records";
import type { ExecutableWorkflow, JsonObject, JsonValue } from "@wf/contract/workflow";
import { describeAccounting } from "./accounting/format";
import { installOperatorRuntime, type OperatorRuntimeInstallation } from "./operator-runtime";
import { ANSI, PLAIN, progressEvents, renderProgress } from "./progress-view";
import { assertJsonValue, loadWorkflowFile } from "./workflow-loader";
import {
  startWorkflow,
  WorkflowCancelledError,
  type WorkflowRunHandle,
  type WorkflowRunSnapshot,
} from "./workflow-runner";

const DEFAULT_TIMEOUT_MILLISECONDS = 30 * 60_000;

const usage = [
  "usage: awf run [options] <workflow-file> [options] [-- workflow arguments...]",
  "options: --timeout <duration>, --run-root <directory>, --cwd <directory>, --json",
  "",
  "The deadline defaults to 30m. Run artifacts go to ~/.awf/runs unless --run-root says otherwise.",
  "A workflow that knows how to present its result prints that; --json prints the full result instead.",
  "Either way the full result is kept as output.json among the run's artifacts, beside report.md",
  "when the workflow writes one.",
  "--cwd sets the directory the workflow and its agents work in; it defaults to the current one.",
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
  installRuntime?: (timeoutMilliseconds: number) => Promise<OperatorRuntimeInstallation>;
  signal?: AbortSignal;
  /** Given, progress is redrawn in place on it; otherwise each change is a line on stderr. */
  terminal?: { write(text: string): void; color: boolean };
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
      version: OUTPUT_RECORD_VERSION,
      runId: result.runId,
      workflow: {
        name: loaded.executable.definition.meta.name,
        file: loaded.file,
      },
      value: result.value,
      accounting: result.accounting,
      usage: result.usage,
      artifacts,
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
  }
  let cleanupError: unknown;
  try {
    await installed.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (runError !== undefined) {
    const cancellation = findCancellation(runError);
    stderr(
      invocationRootCreated
        ? `awf: ${cancellation ? "run cancelled" : "run failed"}; artifacts retained under ${invocationRoot}: ${errorDetail(runError)}`
        : `awf: ${cancellation ? "run cancelled" : "run failed"}; artifacts were not created at ${invocationRoot}: ${errorDetail(runError)}`,
    );
    if (cleanupError !== undefined)
      stderr(`awf: runtime cleanup also failed: ${message(cleanupError)}`);
    if (cancellation) {
      return cancellation.reason === "SIGTERM" ? 143 : 130;
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
  return signal.reason === "SIGTERM" ? 143 : 130;
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
};

function parseCommand(argv: readonly string[], cwd: string, home: string): RunCommand {
  if (argv[0] !== "run") throw new Error("expected the run command");
  let timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS;
  // Not under the working directory: that is usually the repository the workflow is looking at.
  let runRoot = join(home, ".awf/runs");
  let json = false;
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
  let markdown: string;
  try {
    markdown = executable.report(value);
  } catch (error) {
    // The result is still in output.json; a report that cannot render should not fail the run.
    stderr(`awf: report: ${message(error)}; see output.json instead`);
    return undefined;
  }
  const file = join(artifacts, "report.md");
  await writeFile(file, `${markdown.trimEnd()}\n`);
  return file;
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
  return error instanceof AggregateError
    ? error.errors.map(errorDetail).join("; ")
    : message(error);
}

function findCancellation(error: unknown): WorkflowCancelledError | undefined {
  if (error instanceof WorkflowCancelledError) return error;
  if (!(error instanceof AggregateError)) return undefined;
  for (const nested of error.errors) {
    const cancellation = findCancellation(nested);
    if (cancellation) return cancellation;
  }
  return undefined;
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    process.exitCode = await runOperatorCli(process.argv.slice(2), { signal: controller.signal });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
