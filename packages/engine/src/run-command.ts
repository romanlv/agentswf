import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { RunPanes } from "@agentswf/contract/records";
import type { JsonValue, KeepPane } from "@agentswf/contract/workflow";
import { parseDuration } from "./duration";
import { messageOf } from "./errors";
import help from "./help/run.txt" with { type: "text" };
import { SESSION_CODE } from "./here";
import { KEEP_PANES, parseWorkspace } from "./pane-layout";
import { idProblem, RunRefused, runRootOf, stageNameProblem } from "./runs";

export const usage = help.trimEnd();

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
  /** As typed, for the attempt's record; absent, the run has no deadline. */
  timeout?: string;
  timeoutMilliseconds?: number;
  runRoot: string;
  /** A new run's id, as `--id` gave it. */
  id?: string;
  /** The run `--id` names, which `--continue` adds an attempt to. */
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
  /** `--workspace` and `--keep-panes`, which the run records; absent, neither was given. */
  panes?: RunPanes;
  /** Started from an agent's shell: start the run in a tab and take that session over. */
  here: boolean;
  /** The code the calling session replies with, which the run finds it by. */
  session?: string;
};

/** `awf run`'s options and workflow; `"help"` for a `-h` or `--help` anywhere before `--`. */
export function parseCommand(argv: readonly string[], cwd: string): RunCommand | "help" {
  const end = argv.indexOf("--");
  const own = end < 0 ? argv : argv.slice(0, end);
  if (own.includes("-h") || own.includes("--help")) return "help";
  let timeout: string | undefined;
  let timeoutMilliseconds: number | undefined;
  let runRoot: string | undefined;
  let named: string | undefined;
  let continuing = false;
  let fromStage: string | undefined;
  let values: RunCommand["values"];
  let cwdGiven = false;
  let json = false;
  let watch = true;
  let workCwd = cwd;
  let sandbox: unknown;
  let here = false;
  let session: string | undefined;
  const panes: RunPanes = {};
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
    if (option === "--continue") {
      continuing = true;
      continue;
    }
    const value = argv[index + 1];
    if (option === "--timeout") {
      if (!value) throw new Error("--timeout needs a duration such as 30m or 1d");
      timeoutMilliseconds = parseDuration(value, "--timeout");
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
    } else if (option === "--id") {
      if (!value) throw new Error("--id needs a run's id");
      const problem = idProblem(value);
      // Refused as any id the grammar refuses is, `id`, still a usage error's exit.
      if (problem) throw new RunRefused(`--id: ${problem}`, "id");
      named = value;
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
    } else if (option === "--workspace") {
      if (!value?.trim() || value.startsWith("-"))
        throw new Error("--workspace needs run, origin or a workspace's name");
      if (panes.workspace !== undefined) throw new Error("--workspace given twice");
      panes.workspace = parseWorkspace(value);
    } else if (option === "--keep-panes") {
      if (!KEEP_PANES.includes(value as KeepPane))
        throw new Error("--keep-panes needs never, on-failure or always");
      if (panes.keep !== undefined) throw new Error("--keep-panes given twice");
      panes.keep = value as KeepPane;
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
  if (here && json)
    throw new Error(
      "--here prints what the calling agent does next, no document: leave out --json",
    );
  if (continuing && named === undefined)
    throw new Error("--continue goes on with the run --id names");
  const id = continuing ? undefined : named;
  const continueId = continuing ? named : undefined;
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
    ...(timeout === undefined ? {} : { timeout }),
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
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
    ...(Object.keys(panes).length === 0 ? {} : { panes }),
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
