#!/usr/bin/env -S bun --no-env-file
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants, homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  type AttemptOutcome,
  OUTPUT_RECORD_VERSION,
  type OutputRecord,
  type StageRecord,
} from "@agentswf/contract/records";
import {
  type AbsoluteDeadline,
  DeadlineExceededError,
  type ExecutableWorkflow,
  type JsonObject,
  type JsonValue,
} from "@agentswf/contract/workflow";
import {
  type CallerPane,
  focusTab,
  HARNESSES,
  handBack,
  herdrReachable,
  type RunProcess,
  runProcess,
  searchCaller,
  startInNewTab,
} from "@agentswf/harness";
import manifest from "../package.json" with { type: "json" };
import { describeAccounting } from "./accounting/format";
import { parseDuration } from "./duration";
import { messageOf } from "./errors";
import {
  herdrConfig,
  herdrSession,
  installOperatorRuntime,
  type OperatorRuntimeInstallation,
} from "./operator-runtime";
import { ANSI, PLAIN, progressEvents, renderProgress } from "./progress-view";
import {
  type Attempt,
  checkContinue,
  checkFree,
  claimAttempt,
  createRun,
  discardRun,
  endAttempt,
  idProblem,
  machinePaths,
  openRun,
  type Run,
  RunRefused,
  readAttempts,
  readStageRecords,
  runRootOf,
  runStatus,
  sandboxesOf,
  writeJson,
  writeWhole,
} from "./runs";
import { stageNameProblem } from "./stage-ledger";
import { parseTestCommand, runWorkflowTests, type TestCommand, testUsage } from "./test-command";
import { assertJsonValue, loadWorkflowFile } from "./workflow-loader";
import {
  type SettledRun,
  startWorkflow,
  WorkflowCancelledError,
  WorkflowRunError,
  type WorkflowRunHandle,
  type WorkflowRunSnapshot,
  WorkflowStopped,
} from "./workflow-runner";

const DEFAULT_TIMEOUT = "30m";

const usage = [
  "usage: awf run [options] <workflow-file> [options] [-- workflow arguments...]",
  "       awf run [options] <workflow-file> --continue <id>",
  "       awf test [paths...] [-t <pattern>] [--watch] [--timeout <duration>]",
  "       awf --version",
  "run options: --id <id>, --continue <id>, --from-stage <stage>, --timeout <duration>,",
  "             --run-root <directory>, --cwd <directory>, --sandbox <file>, --json, --no-watch,",
  "             --here",
  "",
  "Each awf run is an attempt of a run: a new run, with --id's id or a generated one, or the run",
  "--continue names, with the arguments, --cwd and --sandbox it was started with. A continue reuses",
  "the stages that succeeded, up to the first with no record or to --from-stage, and runs the rest.",
  "A stop exits 3. A run is kept in .awf/runs/<workflow>/<id> under --cwd, unless --run-root names",
  "another folder for .awf/runs.",
  "The deadline defaults to 30m, per attempt.",
  "A workflow that knows how to present its result prints that; --json prints the full result instead.",
  "Either way the full result is kept as output.json in the run's folder, beside report.md",
  "when the workflow writes one. A run that fails or is cancelled once its agents have started keeps",
  "output.json too, with what it spent and why it ended; --json prints it. A second Ctrl-C stops",
  "awf at once, without it.",
  "--cwd sets the directory the workflow and its agents work in; it defaults to the current one.",
  "--sandbox puts every agent of the run in one sandbox, working in --cwd; the file is a JSON spec",
  'such as {"read": ["/data/request.md"], "srt": {}}, whose relative paths are from --cwd. A',
  "workflow that opens a sandbox of its own is refused.",
  "A sandbox with its own Herdr, as a docker box has, gets a tab in the run's workspace showing its",
  "panes; --no-watch leaves it out, and awf still prints the command that shows them.",
  "--here, run by an agent in a Herdr pane, starts the run in a new tab and has it take that agent's",
  "session over as one of its agents, from its next turn until the run ends. It prints a line for",
  "the agent to end its turn with, which is how the run finds the session.",
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
    options: { watchSandboxes: boolean; caller?: { pane: CallerPane; session: string } },
  ) => Promise<OperatorRuntimeInstallation>;
  signal?: AbortSignal;
  /** Given, progress is redrawn in place on it; otherwise each change is a line on stderr. */
  terminal?: { write(text: string): void; color: boolean };
  bunVersion?: string;
  /** Runs `herdr` for `--here` and `--session`. */
  herdr?: RunProcess;
  environment?: Readonly<Record<string, string | undefined>>;
  /** The command that runs this awf, which `--here` types into the run's tab. */
  self?: readonly string[];
  /** How long `--session` looks for the pane showing its code. */
  callerSearchMs?: number;
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
  const tooOld = bunProblem(environment.bunVersion ?? Bun.version);
  if (tooOld) {
    stderr(`awf: ${tooOld}`);
    return 1;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    stdout(describeVersion());
    return 0;
  }
  if (argv[0] === "test") {
    let tests: TestCommand | "help";
    try {
      tests = parseTestCommand(argv.slice(1), environment.cwd ?? process.cwd());
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
  let command: RunCommand;
  try {
    command = parseCommand(argv, environment.cwd ?? process.cwd());
  } catch (error) {
    stderr(`awf: ${messageOf(error)}\n\n${usage}`);
    return 2;
  }
  const home = environment.home ?? homedir();
  const { sandboxes } = machinePaths(home);
  if (!relative(command.runRoot, sandboxes).startsWith("..")) {
    stderr(
      `awf: --run-root ${command.runRoot} holds ${sandboxes}, which every sandbox must reach and none may reach the run root`,
    );
    return 2;
  }

  if (command.here) return startHere(argv, command, environment, stdout, stderr);

  let loaded: Awaited<ReturnType<typeof loadWorkflowFile>>;
  try {
    loaded = await loadWorkflowFile(command.workflowFile, command.shellCwd);
  } catch (error) {
    stderr(`awf: load: ${messageOf(error)}`);
    return 2;
  }
  const meta = loaded.executable.definition.meta;

  let prepared: Awaited<ReturnType<typeof prepareRun>>;
  try {
    prepared = await prepareRun(command, loaded);
  } catch (error) {
    stderr(`awf: ${error instanceof RunRefused ? "" : "prepare: "}${messageOf(error)}`);
    return 2;
  }
  const { args } = prepared;
  for (const line of prepared.recorded ?? []) stderr(line);

  // Loading the workflow imports operator-supplied code, and installing the runtime probes two
  // subscription logins. Both run before anything is listening to the signal, so a Ctrl-C in that
  // window would otherwise be swallowed and have to be pressed again.
  if (environment.signal?.aborted) return interrupted(environment.signal, stderr);

  let caller: { pane: CallerPane; session: string } | undefined;
  let releaseCaller: () => void = () => undefined;
  if (command.session !== undefined) {
    const found = await findCaller(command.session, environment);
    if (found.kind === "refused") {
      stderr(`awf: --session: ${found.reason}`);
      // The session that started this waits on a run that will not come, and this tab opened
      // unfocused: it is the one place that says why.
      await showOwnTab(environment);
      return 1;
    }
    const claim = claimCaller(machinePaths(home).callers, found.caller.pane.paneId);
    if (typeof claim === "string") {
      stderr(`awf: --session: ${claim}`);
      await showOwnTab(environment);
      return 1;
    }
    releaseCaller = claim;
    caller = found.caller;
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
      prepared.continued ??
      (await createRun(command.runRoot, {
        ...(command.id === undefined ? {} : { id: command.id }),
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
    attempt = claimed.attempt;
    for (const earlier of claimed.interrupted) {
      stderr(
        `awf: attempt ${earlier.n} of ${run.record.id} was interrupted; its panes may still be open in Herdr workspace "${workspaceLabel(meta.name, run.record.id, earlier.n)}"`,
      );
    }
  } catch (error) {
    // A run this call created and never ran is not left to hold its id.
    if (!prepared.continued) await discardRun(run).catch(() => undefined);
    return refuse(messageOf(error));
  }
  const { id } = run.record;
  const cwd = run.record.cwd;
  const sandbox = run.record.sandbox ?? undefined;
  const n = attempt.record.n;
  const named = `${meta.name} ${id}${n > 1 ? ` · attempt ${n}` : ""}`;
  // Every way out from here writes the attempt's ending; one that never does is interrupted.
  let ending: { outcome: AttemptOutcome; reason?: string; stage?: string } = {
    outcome: "failed",
    reason: "awf stopped before the run ended",
  };
  const writeEnding = async () => {
    try {
      await endAttempt(attempt, ending);
    } catch (error) {
      stderr(`awf: the attempt's ending was not written to ${attempt.file}: ${messageOf(error)}`);
    }
  };
  const end = async (code: number): Promise<number> => {
    await writeEnding();
    return code;
  };
  // Timed from here: finding the calling session can take minutes the run itself never had.
  const startedAt = (environment.now ?? Date.now)();
  const deadline = { unixMilliseconds: startedAt + command.timeoutMilliseconds };
  let installed: OperatorRuntimeInstallation;
  try {
    installed = await (environment.installRuntime ?? installOperatorRuntime)(
      command.timeoutMilliseconds,
      { watchSandboxes: command.watch, ...(caller ? { caller } : {}) },
    );
  } catch (error) {
    stderr(`awf: runtime: ${messageOf(error)}`);
    ending = { outcome: "failed", reason: `runtime: ${messageOf(error)}` };
    await handOver(`did not start: ${messageOf(error)}`);
    return end(1);
  }
  if (environment.signal?.aborted) {
    await installed.cleanup().catch(() => undefined);
    ending = { outcome: "cancelled", reason: "cancelled before it started" };
    await handOver("was cancelled before it started");
    return end(interrupted(environment.signal, stderr));
  }

  let output: string | undefined;
  let runError: unknown;
  let outcome: Exclude<OutputRecord["outcome"], "succeeded"> = "failed";
  let failedRecord: string | undefined;
  let footer: string[] = [];
  /** Where the run's record is, once this attempt wrote one. */
  let written = false;
  const recordOf = (settled: SettledRun) => ({
    version: OUTPUT_RECORD_VERSION,
    runId: settled.runId,
    attempt: n,
    workflow: {
      name: meta.name,
      file: loaded.file,
    },
    accounting: settled.accounting,
    usage: settled.usage,
    artifacts: run.dir,
    ...(settled.sandboxes ? { sandboxes: settled.sandboxes } : {}),
    ...(settled.skills ? { skills: settled.skills } : {}),
    ...(settled.decisions ? { decisions: settled.decisions } : {}),
  });
  try {
    const progress = watchProgress(named, startedAt, {
      stderr,
      terminal,
      now: environment.now ?? Date.now,
    });
    let result: Awaited<WorkflowRunHandle<JsonValue>["result"]>;
    try {
      const handle = await startWorkflow(loaded.executable.definition, args, {
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
      result = await handle.result;
    } finally {
      progress.stop();
    }
    const report = await writeReport(loaded.executable, result.value, run.dir, stderr);
    const record: OutputRecord = {
      ...recordOf(result),
      outcome: "succeeded",
      value: result.value,
      ...(report ? { report } : {}),
    };
    const json = JSON.stringify(record, null, 2);
    await writeJson(join(run.dir, "output.json"), record);
    written = true;
    // After the result and beside it rather than in it: stdout stays the workflow's report or the
    // JSON.
    footer = [
      "",
      ...describeAccounting(result.accounting),
      ...(report ? [`Report: ${tilde(report)}`] : []),
      `Records: ${tilde(run.dir)}`,
    ];
    output = command.json ? json : (present(loaded.executable, result.value, stderr) ?? json);
  } catch (error) {
    runError = error;
    outcome = runOutcome(error, deadline);
    if (error instanceof WorkflowRunError) {
      const record: OutputRecord = {
        ...recordOf(error),
        outcome,
        error: errorDetail(error),
        ...(stopAt(error) === undefined ? {} : { stage: stopAt(error) }),
      };
      failedRecord = JSON.stringify(record, null, 2);
      try {
        await writeJson(join(run.dir, "output.json"), record);
        written = true;
      } catch (writeError) {
        stderr(`awf: output.json: ${messageOf(writeError)}`);
      }
      for (const line of ["", ...describeAccounting(error.accounting)]) stderr(line);
    }
  }
  // Written before cleanup and the hand-back: a session told the run is over may continue it at
  // once, and a second Ctrl-C during cleanup leaves the ending already written.
  const stoppedAt = stopAt(runError);
  ending =
    runError === undefined
      ? { outcome: "completed" }
      : {
          outcome,
          reason: errorDetail(runError),
          ...(stoppedAt === undefined ? {} : { stage: stoppedAt }),
        };
  await writeEnding();
  let cleanupError: unknown;
  try {
    await installed.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError !== undefined && runError === undefined) {
    ending = { outcome: "failed", reason: `runtime cleanup failed: ${messageOf(cleanupError)}` };
    await writeEnding();
  }
  const recorded = written ? `; its record is ${join(run.dir, "output.json")}` : "";
  await handOver(
    runError === undefined
      ? `succeeded${recorded}`
      : `${ENDINGS[outcome].told}${recorded}: ${errorDetail(runError)}`,
  );
  if (runError !== undefined) {
    const cancellation = findCancellation(runError);
    const { ended } = ENDINGS[outcome];
    stderr(`awf: ${ended} (${named}); its records are in ${run.dir}: ${errorDetail(runError)}`);
    if (cleanupError !== undefined)
      stderr(`awf: runtime cleanup also failed: ${messageOf(cleanupError)}`);
    // The record says the run did not succeed, so a caller that asked for it gets it either way.
    if (command.json && failedRecord !== undefined) stdout(failedRecord);
    if (cancellation) {
      return signalExitCode(cancellation.reason);
    }
    return outcome === "stopped" ? STOPPED_EXIT_CODE : 1;
  }
  if (cleanupError !== undefined) {
    for (const line of footer) stderr(line);
    // Stdout stays empty: it is the result of a run whose teardown did not finish, and a caller
    // reading it without checking the exit code would take that for a clean one. The records are
    // named instead, so the work is still reachable.
    stderr(
      `awf: runtime cleanup failed (${named}); its records are in ${run.dir}: ${messageOf(cleanupError)}`,
    );
    return 1;
  }
  stdout(output as string);
  for (const line of footer) stderr(line);
  return 0;
}

/**
 * What a continue finds in `stages/`: each stage, the attempt that ran it, how long ago, and its
 * summary. A `--from-stage` with no record is warned about here, before anything runs.
 */
function describeRecorded(
  run: Run,
  recorded: ReadonlyMap<string, StageRecord>,
  fromStage?: string,
  now = Date.now(),
): string[] {
  const records = [...recorded.values()].sort((a, b) => a.started.localeCompare(b.started));
  const lines = records.map((record) => {
    const version = record.workflowVersion === undefined ? "" : ` · v${record.workflowVersion}`;
    const outcome = record.outcome === "succeeded" ? "" : ` · ${record.outcome}`;
    const summary = record.summary === undefined ? "" : ` · ${record.summary}`;
    return `  ${record.stage} · attempt ${record.attempt}${version} · ${ago(now - Date.parse(record.ended))}${outcome}${summary}`;
  });
  return [
    ...(lines.length > 0 ? [`awf: ${run.record.id} has these stages recorded:`, ...lines] : []),
    ...(fromStage !== undefined && !records.some((record) => record.stage === fromStage)
      ? [`awf: nothing is recorded for ${fromStage}; the attempt stops if it never reaches it`]
      : []),
  ];
}

function ago(ms: number): string {
  if (!Number.isFinite(ms)) return "at an unknown time";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** Why a completed run isn't continued, and how one of its stages is redone. */
export function completedMessage(id: string, stages: readonly string[]): string {
  return stages.length > 0
    ? `${id} completed; to redo from a stage, --from-stage one of: ${stages.join(", ")}`
    : `${id} completed; there is nothing to continue`;
}

/** A run's Herdr workspace, which names the attempt: a dead one's may still be open. */
function workspaceLabel(workflow: string, id: string, attempt: number): string {
  return `awf ${workflow} ${id} #${attempt}`;
}

/**
 * The workflow's arguments, and the run `--continue` names, whose recorded argv is prepared again
 * by the code as it is now. A new run is claimed after, by its caller.
 */
async function prepareRun(
  command: RunCommand,
  loaded: Awaited<ReturnType<typeof loadWorkflowFile>>,
): Promise<{ args: JsonValue; continued?: Run; recorded?: string[] }> {
  const { executable, file } = loaded;
  const { meta } = executable.definition;
  const prepare = (argv: readonly string[], cwd: string) => {
    const args = executable.prepare({ argv, cwd });
    assertJsonValue(args, `${meta.name} arguments`);
    return args;
  };
  if (command.continueId === undefined) {
    const args = prepare(command.workflowArgs, command.cwd);
    if (command.id !== undefined) await checkFree(command.runRoot, meta.name, command.id);
    return { args };
  }
  const run = await openRun(command.runRoot, meta.name, command.continueId);
  checkContinue(run, {
    argv: command.workflowArgs,
    ...(command.cwdGiven ? { cwd: command.cwd } : {}),
    ...(command.sandbox === undefined ? {} : { sandbox: command.sandbox }),
  });
  const { id, argv, cwd } = run.record;
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new RunRefused(`${id} works in ${cwd}, which is no longer a directory`);
  }
  let args: JsonValue;
  try {
    args = prepare(argv, cwd);
  } catch (error) {
    throw new RunRefused(
      `the recorded argv of ${id} no longer parses with ${file}: ${messageOf(error)}; start a new run`,
    );
  }
  const attempts = await readAttempts(run);
  const status = runStatus(attempts);
  const records = await readStageRecords(run.dir);
  if (status === "completed" && command.fromStage === undefined) {
    throw new RunRefused(completedMessage(id, [...records.keys()]));
  }
  // The claim refuses it too; this says so before `--here` opens a tab, or `--session` waits.
  const last = attempts.at(-1);
  if (status === "running" && last) {
    throw new RunRefused(`attempt ${last.n} of ${id} is still running, as process ${last.pid}`);
  }
  return { args, continued: run, recorded: describeRecorded(run, records, command.fromStage) };
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
  /** Whether `--cwd` gave it, which a continue checks against its run's. */
  cwdGiven: boolean;
  workflowFile: string;
  workflowArgs: string[];
  /** As typed, for the attempt's record. */
  timeout: string;
  timeoutMilliseconds: number;
  runRoot: string;
  /** A new run's id, as `--id` gave it. */
  id?: string;
  /** The run `--continue` adds an attempt to. */
  continueId?: string;
  /** The stage a continue starts at, reusing those before it. */
  fromStage?: string;
  json: boolean;
  /** Whether each sandbox with its own Herdr gets a tab attached to it in the run's workspace. */
  watch: boolean;
  /** The sandbox every agent runs in, as `--sandbox`'s file gave it. */
  sandbox?: unknown;
  /** Started from an agent's shell: start the run in a tab and take that session over. */
  here: boolean;
  /** The code the calling session replies with, which the run finds it by. */
  session?: string;
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

function parseCommand(argv: readonly string[], cwd: string): RunCommand {
  if (argv[0] !== "run") throw new Error("expected the run command");
  let timeout = DEFAULT_TIMEOUT;
  let timeoutMilliseconds = parseDuration(DEFAULT_TIMEOUT);
  let runRoot: string | undefined;
  let id: string | undefined;
  let continueId: string | undefined;
  let fromStage: string | undefined;
  let cwdGiven = false;
  let json = false;
  let watch = true;
  let workCwd = cwd;
  let sandbox: unknown;
  let here = false;
  let session: string | undefined;
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
    if (option === "--here") {
      here = true;
      continue;
    }
    const value = argv[index + 1];
    if (option === "--timeout") {
      if (!value) throw new Error("--timeout needs a duration such as 30m");
      timeoutMilliseconds = parseDuration(value);
      timeout = value;
    } else if (option === "--run-root") {
      if (!value) throw new Error("--run-root needs a directory");
      runRoot = resolve(cwd, value);
    } else if (option === "--cwd") {
      if (!value) throw new Error("--cwd needs a directory");
      workCwd = resolve(cwd, value);
      cwdGiven = true;
      if (!statSync(workCwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`--cwd: not a directory: ${workCwd}`);
      }
    } else if (option === "--id" || option === "--continue") {
      if (!value) throw new Error(`${option} needs a run's id`);
      const problem = idProblem(value);
      if (problem) throw new Error(`${option}: ${problem}`);
      if (option === "--id") id = value;
      else continueId = value;
    } else if (option === "--from-stage") {
      if (!value) throw new Error("--from-stage needs a stage's name");
      const problem = stageNameProblem(value);
      if (problem) throw new Error(`--from-stage: ${problem}`);
      fromStage = value;
    } else if (option === "--session") {
      if (!value || !SESSION_CODE.test(value))
        throw new Error("--session needs the code --here printed");
      session = value;
    } else if (option === "--sandbox") {
      if (!value) throw new Error("--sandbox needs a JSON file");
      if (sandbox !== undefined) throw new Error("--sandbox given twice");
      sandbox = readSandboxSpec(resolve(cwd, value));
    } else {
      throw new Error(`unknown option: ${option}; put workflow arguments after --`);
    }
    index += 1;
  }
  if (!workflowFile) throw new Error("run needs one workflow file");
  if (here && session !== undefined) throw new Error("--here and --session do not go together");
  if (id !== undefined && continueId !== undefined) {
    throw new Error("--id names a new run and --continue an existing one; give one");
  }
  if (fromStage !== undefined && continueId === undefined) {
    throw new Error("--from-stage goes with --continue: a new run has nothing to reuse");
  }
  const workflowArgs = argv.slice(index + 1);
  return {
    shellCwd: cwd,
    cwd: workCwd,
    cwdGiven,
    workflowFile,
    workflowArgs,
    timeout,
    timeoutMilliseconds,
    runRoot: runRoot ?? runRootOf(workCwd),
    ...(id === undefined ? {} : { id }),
    ...(continueId === undefined ? {} : { continueId }),
    ...(fromStage === undefined ? {} : { fromStage }),
    json,
    watch,
    here,
    ...(session === undefined ? {} : { session }),
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

const SESSION_CODE = /^awf-here-[0-9a-f]{8}$/;
const CALLER_SEARCH_MS = 120_000;

/**
 * `awf run --here`, in an agent's shell: checks the session can be driven, then has Herdr start the
 * run in a new tab, outside this shell and any sandbox it is in, and prints the code the agent ends
 * its turn with (ADR 0010). Nothing is started when a check fails.
 */
async function startHere(
  argv: readonly string[],
  command: RunCommand,
  environment: OperatorEnvironment,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): Promise<number> {
  const env = environment.environment ?? process.env;
  const run = environment.herdr ?? runProcess;
  const refuse = (why: string, instead: string) => {
    stderr(`awf: --here: ${why}. ${instead}`);
    return 1;
  };
  const workspace = env.HERDR_WORKSPACE_ID;
  if (env.HERDR_ENV !== "1" || !workspace) {
    return refuse(
      "this session is not in a Herdr pane, so a run cannot drive it",
      "Start the agent in a Herdr pane, or run the workflow from a shell with awf run and no --here.",
    );
  }
  const file = resolve(command.shellCwd, command.workflowFile);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return refuse(`no workflow file at ${file}`, "Name it by a path from this directory.");
  }
  let session: string;
  try {
    session = await herdrSession(run, env);
  } catch (error) {
    return refuse(`Herdr did not answer: ${messageOf(error)}`, sandboxFix(env));
  }
  const unreachable = await herdrReachable(herdrConfig(session), run);
  if (unreachable) {
    return refuse(`this session cannot reach Herdr: ${unreachable.trim()}`, sandboxFix(env));
  }
  // In this shell, before any tab opens: a workflow that will not load fails here, where the agent
  // reads it, and not in a tab nobody is looking at.
  try {
    await prepareRun(command, await loadWorkflowFile(command.workflowFile, command.shellCwd));
  } catch (error) {
    return refuse(`the workflow cannot start: ${messageOf(error)}`, "Fix it, then run this again.");
  }
  const code = `awf-here-${randomBytes(4).toString("hex")}`;
  const end = argv.indexOf("--");
  const options = (end === -1 ? argv.slice(1) : argv.slice(1, end)).filter(
    (arg) => arg !== "--here",
  );
  const rest = end === -1 ? [] : argv.slice(end);
  const self = environment.self ?? [process.execPath, "--no-env-file", process.argv[1]!];
  const started = await startInNewTab(
    herdrConfig(session),
    {
      // Under codex this can be another pane's workspace (E8); the run's tab still works from it.
      workspace,
      cwd: command.shellCwd,
      label: `awf ${basename(file)}${command.continueId === undefined ? "" : ` ${command.continueId}`}`,
      argv: [...self, "run", "--session", code, ...options, ...rest],
    },
    run,
  );
  if (!started.ok) {
    return refuse(
      `Herdr did not open the run's tab: ${started.error}`,
      "Run the workflow from a shell with awf run instead.",
    );
  }
  stdout(
    [
      `awf: ${basename(file)} is starting in Herdr tab ${started.tabId}. Once this turn ends it takes this session over: each of its steps arrives here as a prompt, and a last message hands the session back.`,
      "",
      "End your turn now by replying with only this line, exactly:",
      code,
    ].join("\n"),
  );
  return 0;
}

/**
 * What lets a sandboxed session reach Herdr's socket, which `--here` and every `wf` call need: its
 * harness's own advice, for the harness whose session variable this shell has.
 */
function sandboxFix(env: Readonly<Record<string, string | undefined>>): string {
  const harness = Object.values(HARNESSES).find(
    (spec) => spec.sessionEnv && env[spec.sessionEnv] && spec.localSockets,
  );
  return harness?.localSockets
    ? `${harness.localSockets}.`
    : "If this session runs in a sandbox, let it reach Herdr's socket and local sockets, or run the workflow from a shell with awf run.";
}

/**
 * Marks `paneId` as driven by this process until the returned release, under `~/.awf`, which every
 * run on this machine shares whatever its run root: a second run started from a driven session is
 * refused, as ADR 0010 allows one at a time. A mark whose process is gone is taken over. The
 * reason when refused.
 */
function claimCaller(marks: string, paneId: string): (() => void) | string {
  const mark = join(marks, `${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}.pid`);
  mkdirSync(marks, { recursive: true });
  // Linked into place whole, so a run reading the mark never sees it without its pid.
  const pending = `${mark}.${process.pid}`;
  try {
    writeFileSync(pending, String(process.pid));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(pending, mark);
        return () => rmSync(mark, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return messageOf(error);
        const holder = Number(readFileSync(mark, "utf8"));
        if (alive(holder)) {
          return `another run (process ${holder}) is already driving the session in ${paneId}; one run drives a session at a time`;
        }
        rmSync(mark, { force: true });
      }
    }
    return `could not mark the session in ${paneId} as driven`;
  } catch (error) {
    return messageOf(error);
  } finally {
    rmSync(pending, { force: true });
  }
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Brings the tab this process runs in forward, where Herdr says which one that is. */
async function showOwnTab(environment: OperatorEnvironment): Promise<void> {
  const env = environment.environment ?? process.env;
  if (!env.HERDR_TAB_ID) return;
  const session = await herdrSession(environment.herdr ?? runProcess, env).catch(() => undefined);
  if (session) await focusTab(herdrConfig(session), env.HERDR_TAB_ID, environment.herdr);
}

/** The pane showing `code`, in the Herdr session awf runs in, for `--session`. */
async function findCaller(
  code: string,
  environment: OperatorEnvironment,
): Promise<
  | { kind: "found"; caller: { pane: CallerPane; session: string } }
  | { kind: "refused"; reason: string }
> {
  const run = environment.herdr ?? runProcess;
  let session: string;
  try {
    session = await herdrSession(run, environment.environment ?? process.env);
  } catch (error) {
    return { kind: "refused", reason: messageOf(error) };
  }
  const found = await searchCaller(
    herdrConfig(session),
    code,
    {
      by: Date.now() + (environment.callerSearchMs ?? CALLER_SEARCH_MS),
      ...(environment.signal ? { signal: environment.signal } : {}),
    },
    run,
  );
  return found.kind === "found" ? { kind: "found", caller: { pane: found.pane, session } } : found;
}

/** `--sandbox`'s file: an inline sandbox spec, whose working directory is the run's. */
function readSandboxSpec(file: string): object {
  let spec: unknown;
  try {
    spec = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`--sandbox: ${messageOf(error)}`);
  }
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error(`--sandbox: ${file} must hold a JSON object, a sandbox spec`);
  }
  for (const [field, why] of Object.entries(NOT_IN_A_RUN_SANDBOX)) {
    if (field in spec) throw new Error(`--sandbox: the run's sandbox names no ${field}; ${why}`);
  }
  return spec;
}

const NOT_IN_A_RUN_SANDBOX = {
  cwd: "it works in --cwd",
  key: "the run's record keys it run",
  provider: 'its provider is its setting, such as "srt": {}',
};

function present(
  executable: ExecutableWorkflow<JsonValue, JsonValue>,
  value: JsonValue,
  stderr: (text: string) => void,
): string | undefined {
  if (!executable.present) return undefined;
  try {
    return executable.present(value).trimEnd();
  } catch (error) {
    stderr(`awf: present: ${messageOf(error)}; printing the full result instead`);
    return undefined;
  }
}

function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
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
    await writeWhole(file, `${markdown.trimEnd()}\n`);
    return file;
  } catch (error) {
    stderr(`awf: report: ${messageOf(error)}; see output.json instead`);
    return undefined;
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof WorkflowRunError) return errorDetail(error.cause);
  return error instanceof AggregateError
    ? error.errors.map(errorDetail).join("; ")
    : messageOf(error);
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

/** Each outcome in words: as the calling session is told it, and as awf reports it. */
const ENDINGS = {
  stopped: { told: "stopped", ended: "run stopped" },
  cancelled: { told: "was cancelled", ended: "run cancelled" },
  "timed-out": { told: "timed out", ended: "run timed out" },
  failed: { told: "failed", ended: "run failed" },
} as const satisfies Record<
  Exclude<OutputRecord["outcome"], "succeeded">,
  { told: string; ended: string }
>;

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
  if (failure instanceof WorkflowStopped) return "stopped";
  return failure instanceof DeadlineExceededError &&
    failure.deadline.unixMilliseconds === deadline.unixMilliseconds
    ? "timed-out"
    : "failed";
}

/** The stage a stop that ended a run stopped in, as `runOutcome` found the stop. */
function stopAt(error: unknown): string | undefined {
  const cause = error instanceof WorkflowRunError ? error.cause : error;
  const failure = cause instanceof AggregateError ? cause.errors[0] : cause;
  return failure instanceof WorkflowStopped ? failure.stage : undefined;
}

/** A stop's exit code, apart from a failure's: the run can go on with `--continue`. */
const STOPPED_EXIT_CODE = 3;

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
