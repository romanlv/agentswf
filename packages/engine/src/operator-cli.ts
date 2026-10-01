#!/usr/bin/env -S bun --no-env-file
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { OUTPUT_RECORD_VERSION, type OutputRecord } from "@agentswf/contract/records";
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
  type HerdrConfig,
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
  herdrSession,
  installOperatorRuntime,
  type OperatorRuntimeInstallation,
} from "./operator-runtime";
import { ANSI, PLAIN, progressEvents, renderProgress } from "./progress-view";
import { parseTestCommand, runWorkflowTests, type TestCommand, testUsage } from "./test-command";
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
  "       awf test [paths...] [-t <pattern>] [--watch] [--timeout <duration>]",
  "       awf --version",
  "run options: --timeout <duration>, --run-root <directory>, --cwd <directory>, --sandbox <file>,",
  "             --json, --no-watch, --here",
  "",
  "The deadline defaults to 30m. Run artifacts go to ~/.awf/runs unless --run-root says otherwise.",
  "A workflow that knows how to present its result prints that; --json prints the full result instead.",
  "Either way the full result is kept as output.json among the run's artifacts, beside report.md",
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
    command = parseCommand(argv, environment.cwd ?? process.cwd(), environment.home ?? homedir());
  } catch (error) {
    stderr(`awf: ${messageOf(error)}\n\n${usage}`);
    return 2;
  }

  if (command.here) return startHere(argv, command, environment, stdout, stderr);

  const startedAt = (environment.now ?? Date.now)();
  const deadline = { unixMilliseconds: startedAt + command.timeoutMilliseconds };
  let loaded: Awaited<ReturnType<typeof loadWorkflowFile>>;
  try {
    loaded = await loadWorkflowFile(command.workflowFile, command.shellCwd);
  } catch (error) {
    stderr(`awf: load: ${messageOf(error)}`);
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
    stderr(`awf: prepare: ${messageOf(error)}`);
    return 2;
  }

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
    const claim = claimCaller(command.runRoot, found.caller.pane.paneId);
    if (typeof claim === "string") {
      stderr(`awf: --session: ${claim}`);
      return 1;
    }
    releaseCaller = claim;
    caller = found.caller;
    if (environment.signal?.aborted) {
      releaseCaller();
      return interrupted(environment.signal, stderr);
    }
  }
  // Once the run has taken the session over, however it ends, the session gets it back.
  const handOver = async (ended: string) => {
    if (!caller) return;
    releaseCaller();
    const name = loaded.executable.definition.meta.name;
    const failed = await handBack(
      herdrConfig(caller.session),
      caller.pane.paneId,
      `[awf] The workflow ${name} ${ended}. The run is over and this session is yours; nothing here needs an answer.`,
      environment.herdr,
    );
    if (failed) stderr(`awf: the calling session was not told the run ended: ${failed}`);
  };

  let installed: OperatorRuntimeInstallation;
  try {
    installed = await (environment.installRuntime ?? installOperatorRuntime)(
      command.timeoutMilliseconds,
      { watchSandboxes: command.watch, ...(caller ? { caller } : {}) },
    );
  } catch (error) {
    stderr(`awf: runtime: ${messageOf(error)}`);
    await handOver(`did not start: ${messageOf(error)}`);
    return 1;
  }
  if (environment.signal?.aborted) {
    await installed.cleanup().catch(() => undefined);
    await handOver("was cancelled before it started");
    return interrupted(environment.signal, stderr);
  }

  const invocationRoot = join(command.runRoot, `invocation-${randomUUID()}`);
  let invocationRootCreated = false;
  let output: string | undefined;
  let runError: unknown;
  let failedRecord: string | undefined;
  /** Where the run's record is, once it has one. */
  let artifactsOf: string | undefined;
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
          ...(command.sandbox === undefined ? {} : { run: command.sandbox }),
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
    artifactsOf = artifacts;
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
        artifactsOf = record.artifacts;
      } catch (writeError) {
        stderr(`awf: output.json: ${messageOf(writeError)}`);
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
  const record = artifactsOf ? `; its record is ${join(artifactsOf, "output.json")}` : "";
  await handOver(
    runError === undefined
      ? `succeeded${record}`
      : `${{ cancelled: "was cancelled", "timed-out": "timed out", failed: "failed" }[runOutcome(runError, deadline)]}${record}: ${errorDetail(runError)}`,
  );
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
      stderr(`awf: runtime cleanup also failed: ${messageOf(cleanupError)}`);
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
      `awf: runtime cleanup failed; artifacts retained under ${invocationRoot}: ${messageOf(cleanupError)}`,
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

function parseCommand(argv: readonly string[], cwd: string, home: string): RunCommand {
  if (argv[0] !== "run") throw new Error("expected the run command");
  let timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS;
  // Not under the working directory: that is usually the repository the workflow is looking at.
  let runRoot = join(home, ".awf/runs");
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
    } else if (option === "--run-root") {
      if (!value) throw new Error("--run-root needs a directory");
      runRoot = resolve(cwd, value);
    } else if (option === "--cwd") {
      if (!value) throw new Error("--cwd needs a directory");
      workCwd = resolve(cwd, value);
      if (!statSync(workCwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`--cwd: not a directory: ${workCwd}`);
      }
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
    here,
    ...(session === undefined ? {} : { session }),
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

const SESSION_CODE = /^awf-here-[0-9a-f]{8}$/;
const CALLER_SEARCH_MS = 120_000;

function herdrConfig(session: string): HerdrConfig {
  return { session, workspaceLabel: "awf run", commandTimeoutMs: 10_000 };
}

/**
 * `awf run --here`, in an agent's shell: checks the session can be driven, then has Herdr start the
 * run in a new tab, outside this shell and any sandbox it is in, and prints the code the agent ends
 * its turn with (ADR 0009). Nothing is started when a check fails.
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
    const loaded = await loadWorkflowFile(command.workflowFile, command.shellCwd);
    assertJsonValue(
      loaded.executable.prepare({ argv: command.workflowArgs, cwd: command.cwd }),
      `${loaded.executable.definition.meta.name} arguments`,
    );
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
      label: `awf ${basename(file)}`,
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
 * Marks `paneId` as driven by this process until the returned release, under the run root every
 * run of this operator shares: a second run started from a driven session is refused, as ADR 0009
 * allows one at a time. A mark whose process is gone is taken over. The reason when refused.
 */
function claimCaller(runRoot: string, paneId: string): (() => void) | string {
  const marks = join(runRoot, "callers");
  const mark = join(marks, `${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}.pid`);
  mkdirSync(marks, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(mark, String(process.pid), { flag: "wx" });
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
    stderr(`awf: present: ${messageOf(error)}; printing the full result instead`);
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
