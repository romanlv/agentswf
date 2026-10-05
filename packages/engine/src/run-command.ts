import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonValue } from "@agentswf/contract/workflow";
import { parseDuration } from "./duration";
import { messageOf } from "./errors";
import { SESSION_CODE } from "./here";
import { idProblem, runRootOf, stageNameProblem } from "./runs";

const DEFAULT_TIMEOUT = "30m";

export const usage = [
  "usage: awf run [options] <workflow-file> [options] [-- workflow arguments...]",
  "       awf run [options] <workflow-file> --continue <id>",
  "       awf test [paths...] [-t <pattern>] [--watch] [--timeout <duration>]",
  "       awf allowance [harness...] [--json]",
  "       awf --version",
  "run options: --id <id>, --continue <id>, --from-stage <stage>, --values <file>,",
  "             --timeout <duration>, --run-root <directory>, --cwd <directory>, --sandbox <file>,",
  "             --json, --no-watch, --here",
  "",
  "Each awf run is an attempt of a run: a new run, with --id's id or a generated one, or the run",
  "--continue names, with the arguments, --cwd and --sandbox it was started with. A continue reuses",
  "the stages that succeeded, up to the first with no record or to --from-stage, and runs the rest.",
  "A new run with --from-stage starts there. A stage before it with no record to reuse takes its",
  "value from --values, a JSON object by stage name, checked by its result; one that returns",
  "nothing is passed. Without one the attempt stops, naming the stage and its schema.",
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

export type RunCommand = {
  /** Where paths typed on the command line resolve. */
  shellCwd: string;
  /** Where the workflow and its agents work. */
  cwd: string;
  /** Whether `--cwd` gave it, which a continue checks against its run's. */
  cwdGiven: boolean;
  /** Whether `--run-root` gave the run root, which the command that goes on repeats. */
  runRootGiven: boolean;
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
  /** The stage the attempt starts at, reusing those before it. */
  fromStage?: string;
  /** `--values`: its file, and each stage's value in it. */
  values?: { file: string; stages: ReadonlyMap<string, JsonValue> };
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

export function parseCommand(argv: readonly string[], cwd: string): RunCommand {
  if (argv[0] !== "run") throw new Error("expected the run command");
  let timeout = DEFAULT_TIMEOUT;
  let timeoutMilliseconds = parseDuration(DEFAULT_TIMEOUT);
  let runRoot: string | undefined;
  let id: string | undefined;
  let continueId: string | undefined;
  let fromStage: string | undefined;
  let values: RunCommand["values"];
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
    } else if (option === "--values") {
      if (!value) throw new Error("--values needs a JSON file");
      if (values !== undefined) throw new Error("--values given twice");
      values = readValues(resolve(cwd, value));
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
  if (values !== undefined && fromStage === undefined) {
    throw new Error("--values goes with --from-stage: it gives the stages before it");
  }
  const workflowArgs = argv.slice(index + 1);
  return {
    shellCwd: cwd,
    cwd: workCwd,
    cwdGiven,
    runRootGiven: runRoot !== undefined,
    workflowFile,
    workflowArgs,
    timeout,
    timeoutMilliseconds,
    runRoot: runRoot ?? runRootOf(workCwd),
    ...(id === undefined ? {} : { id }),
    ...(continueId === undefined ? {} : { continueId }),
    ...(fromStage === undefined ? {} : { fromStage }),
    ...(values === undefined ? {} : { values }),
    json,
    watch,
    here,
    ...(session === undefined ? {} : { session }),
    ...(sandbox === undefined ? {} : { sandbox }),
  };
}

/** `--values`'s file: a JSON object of stage values, by stage name. */
function readValues(file: string): NonNullable<RunCommand["values"]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`--values: ${messageOf(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--values: ${file} must hold a JSON object, each stage's value by its name`);
  }
  for (const stage of Object.keys(parsed)) {
    const problem = stageNameProblem(stage);
    if (problem) throw new Error(`--values: ${problem}`);
  }
  return { file, stages: new Map(Object.entries(parsed as Record<string, JsonValue>)) };
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
  key: 'awf keys it "run"',
  provider: 'its provider is its setting, such as "srt": {}',
};
