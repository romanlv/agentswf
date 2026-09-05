#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonObject } from "@wf/contract/workflow";
import { runWorkflow, WorkflowCancelledError } from "./workflow-runner";
import { assertJsonValue, loadWorkflowFile } from "./workflow-loader";
import { installOperatorRuntime, type OperatorRuntimeInstallation } from "./operator-runtime";

const DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60_000;

const usage = [
  "usage: awf run [--timeout <duration>] [--run-root <directory>] <workflow-file> [--] [workflow arguments...]",
  "",
  "Examples:",
  "  awf run examples/review-loop.ts",
  "  awf run --timeout 20m examples/review-loop.ts",
  "  awf run examples/review-loop.ts -- packages/engine/src",
  "",
  "Workflow files are trusted code and run with your filesystem and process authority.",
].join("\n");

type OperatorEnvironment = {
  cwd?: string;
  now?: () => number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  installRuntime?: (timeoutMilliseconds: number) => Promise<OperatorRuntimeInstallation>;
  signal?: AbortSignal;
};

export async function runOperatorCli(
  argv: readonly string[],
  environment: OperatorEnvironment = {},
): Promise<number> {
  const stdout = environment.stdout ?? ((text) => console.log(text));
  const stderr = environment.stderr ?? ((text) => console.error(text));
  let command: RunCommand;
  try {
    command = parseCommand(argv, environment.cwd ?? process.cwd());
  } catch (error) {
    stderr(`awf: ${message(error)}\n\n${usage}`);
    return 2;
  }

  const startedAt = (environment.now ?? Date.now)();
  const deadline = { unixMilliseconds: startedAt + command.timeoutMilliseconds };
  let loaded;
  try {
    loaded = await loadWorkflowFile(command.workflowFile, command.cwd);
  } catch (error) {
    stderr(`awf: load: ${message(error)}`);
    return 2;
  }

  let args;
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

  let installed: OperatorRuntimeInstallation;
  try {
    installed = await (environment.installRuntime ?? installOperatorRuntime)(
      command.timeoutMilliseconds,
    );
  } catch (error) {
    stderr(`awf: runtime: ${message(error)}`);
    return 1;
  }

  const invocationRoot = join(command.runRoot, `invocation-${randomUUID()}`);
  let invocationRootCreated = false;
  let output: string | undefined;
  let runError: unknown;
  try {
    await mkdir(invocationRoot, { recursive: true });
    invocationRootCreated = true;
    const result = await runWorkflow(loaded.executable.definition, args, {
      runRoot: invocationRoot,
      runtime: installed.config,
      deadline,
      cwd: command.cwd,
      ...(environment.signal ? { signal: environment.signal } : {}),
      onLog: (logMessage, fields?: JsonObject) =>
        stderr(fields ? `${logMessage} ${JSON.stringify(fields)}` : logMessage),
    });
    output = JSON.stringify(
      {
        runId: result.runId,
        workflow: {
          name: loaded.executable.definition.meta.name,
          file: loaded.file,
        },
        value: result.value,
        usage: result.usage,
        artifacts: join(invocationRoot, result.runId),
      },
      null,
      2,
    );
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
    if (cleanupError !== undefined) stderr(`awf: runtime cleanup also failed: ${message(cleanupError)}`);
    if (cancellation) {
      return cancellation.reason === "SIGTERM" ? 143 : 130;
    }
    return 1;
  }
  if (cleanupError !== undefined) {
    stderr(`awf: runtime cleanup failed: ${message(cleanupError)}`);
    return 1;
  }
  stdout(output as string);
  return 0;
}

type RunCommand = {
  cwd: string;
  workflowFile: string;
  workflowArgs: string[];
  timeoutMilliseconds: number;
  runRoot: string;
};

function parseCommand(argv: readonly string[], cwd: string): RunCommand {
  if (argv[0] !== "run") throw new Error("expected the run command");
  let timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS;
  let runRoot = resolve(cwd, ".awf/runs");
  let index = 1;
  while (argv[index]?.startsWith("--") && argv[index] !== "--") {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--timeout") {
      if (!value) throw new Error("--timeout needs a duration such as 10m");
      timeoutMilliseconds = parseDuration(value);
    } else if (option === "--run-root") {
      if (!value) throw new Error("--run-root needs a directory");
      runRoot = resolve(cwd, value);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
    index += 2;
  }
  const workflowFile = argv[index];
  if (!workflowFile || workflowFile === "--") throw new Error("run needs one workflow file");
  index += 1;
  if (argv[index] !== undefined && argv[index] !== "--") {
    throw new Error("put -- before workflow arguments");
  }
  const workflowArgs = argv[index] === "--" ? argv.slice(index + 1) : [];
  return { cwd, workflowFile, workflowArgs, timeoutMilliseconds, runRoot };
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
