import type { AttemptRecord, RunAccounting, StageRecord } from "@agentswf/contract/records";
import type {
  Ending,
  ExecutableWorkflow,
  JsonValue,
  StageSummary,
} from "@agentswf/contract/workflow";
import { ago, describeAccounting, describeAttempts } from "./accounting/format";
import { sumAttempts } from "./accounting/summary";
import { type AttemptEnd, OUTCOMES } from "./attempt-ending";
import type { Kept } from "./attempt-output";
import { pathFrom } from "./display-path";
import { messageOf } from "./errors";
import { ANSI, type Paint, PLAIN } from "./progress-view";
import type { RunCommand } from "./run-command";
import type { AttemptRefusal } from "./runs";
import { FromStageUnreached, type WorkflowStopped } from "./stopped";

/**
 * Prints how the attempt ended, and returns its exit code. A completed one's result goes to stdout;
 * otherwise stdout stays empty but for the record `--json` asks for, since a caller reading it
 * without checking the exit code would take it for a result.
 */
export function printEnding(
  end: AttemptEnd,
  kept: Kept,
  context: {
    executable: ExecutableWorkflow<JsonValue, JsonValue>;
    /** The run's id and folder. */
    run: { id: string; dir: string };
    n: number;
    earlier: readonly AttemptRecord[];
    json: boolean;
    /** Whether the attempt redid from a stage, which no repeated stop then hints at. */
    fromStage: boolean;
    /** Given when the attempt never reached its `--from-stage`: the run's stages to choose from. */
    recorded?: readonly StageRecord[];
    now: number;
    shellCwd: string;
    home: string;
    cleanupAlso?: string;
    /** Given when the stages and their cost were drawn on a terminal, not written as a log. */
    terminal?: { color: boolean };
    stdout: (text: string) => void;
    stderr: (text: string) => void;
    /** For what is said beside a problem, not one. */
    notice: (text: string) => void;
  },
): number {
  const { stdout, stderr, shellCwd } = context;
  const { ending, settled } = end;
  const presented =
    ending.kind === "completed" && !context.json
      ? present(context.executable, ending, stderr)
      : undefined;
  if (end.alsoFailed) stderr(`awf: also failed: ${end.alsoFailed}`);
  const again =
    ending.kind !== "completed" && !context.fromStage
      ? sameStop(ending, context.earlier)
      : undefined;
  if (again) context.notice(again);
  if (context.cleanupAlso) stderr(`awf: runtime cleanup also failed: ${context.cleanupAlso}`);
  // Beside the result rather than in it: stdout stays the workflow's report or the JSON.
  const lines = describeEnding(ending, {
    named: `${context.executable.definition.meta.name} ${context.run.id}`,
    n: context.n,
    ...(settled ? { accounting: settled.accounting } : {}),
    earlier: context.earlier,
    stages: context.terminal === undefined,
    records: pathFrom(shellCwd, context.run.dir, { home: context.home }),
    ...(kept.report ? { report: pathFrom(shellCwd, kept.report, { home: context.home }) } : {}),
    ...(context.recorded?.length ? { choose: listRecorded(context.recorded, context.now) } : {}),
    paint: context.terminal?.color ? ANSI : PLAIN,
  });
  for (const line of ["", ...lines]) stderr(line);
  if (ending.kind === "completed") stdout(presented ?? kept.json ?? JSON.stringify(ending.value));
  else if (context.json && kept.json !== undefined) stdout(kept.json);
  return end.exitCode;
}

/** What the calling session is told of how the run ended, and where its record is. */
export function toldOf(end: AttemptEnd, kept: Kept): string {
  const { ending } = end;
  const told = `${OUTCOMES[ending.kind].told}${kept.output ? `; its record is ${kept.output}` : ""}`;
  return ending.kind === "completed" ? told : `${told}: ${ending.reason}`;
}

/**
 * How an attempt ended, once, after its stages: the outcome, where and why; the run and what the
 * attempt cost, and for a later attempt the whole run, naming the interrupted attempts, whose cost
 * is unknown; then the command that goes on, or the stages to choose from, and where the records
 * are. `stages` lists what each stage cost, where no view beside them did.
 */
function describeEnding(
  ending: Ending<JsonValue>,
  context: {
    /** The workflow's name and the run's id. */
    named: string;
    n: number;
    accounting?: RunAccounting;
    earlier: readonly AttemptRecord[];
    stages: boolean;
    records: string;
    report?: string;
    /** The recorded stages, a line each, one of which the go-on needs. */
    choose?: readonly string[];
    paint: Paint;
  },
): string[] {
  const { accounting, n } = context;
  const mark = OUTCOMES[ending.kind].mark(context.paint);
  const [totals, ...figures] = accounting
    ? describeAccounting(accounting, { stages: context.stages })
    : [];
  const run = [
    context.named,
    ...(n > 1 ? [`attempt ${n}`] : []),
    ...(totals === undefined ? [] : [totals]),
    ...(n > 1 && accounting ? [runTotal(n, accounting, context.earlier)] : []),
  ].join(" · ");
  const word = OUTCOMES[ending.kind].word;
  if (ending.kind === "completed") {
    return [`${mark} ${word} · ${run}`, ...figures, ...rows([], context)];
  }
  // A reason's later lines, such as a schema's problems, sit under it, apart from the rows.
  const [first, ...more] = ending.reason.split("\n");
  const goOn = context.choose
    ? [`${ending.continue} --from-stage one of:`, ...context.choose]
    : [ending.continue];
  return [
    `${mark} ${word}${ending.stage === undefined ? "" : ` in ${ending.stage}`}: ${first}`,
    ...more.map((line) => `    ${line.trim()}`),
    `  ${run}`,
    ...figures,
    ...rows(goOn, context),
  ];
}

/** The rows under an ending: the command that goes on, its lines given, the report, the records. */
function rows(goOn: readonly string[], context: { records: string; report?: string }): string[] {
  const row = (key: string, value: string) => `  ${key.padEnd(7)}  ${value}`;
  const [command, ...choices] = goOn;
  return [
    ...(command === undefined ? [] : [row("go on", command)]),
    ...choices.map((line) => `${" ".repeat(11)}${line}`),
    ...(context.report ? [row("report", context.report)] : []),
    row("records", context.records),
  ];
}

function runTotal(n: number, current: RunAccounting, earlier: readonly AttemptRecord[]): string {
  const before = earlier.filter((record) => record.attempt < n);
  const recorded = [...before.flatMap((record) => record.accounting ?? []), current];
  return describeAttempts(
    sumAttempts(recorded),
    n,
    before.filter((record) => record.ended === undefined).length,
  );
}

/** A completed attempt's value as the workflow presents it; undefined to print the JSON. */
function present(
  executable: ExecutableWorkflow<JsonValue, JsonValue>,
  ending: Extract<Ending<JsonValue>, { kind: "completed" }>,
  stderr: (text: string) => void,
): string | undefined {
  if (!executable.present) return undefined;
  try {
    return executable.present(ending.value, ending)?.trimEnd();
  } catch (error) {
    stderr(`awf: present: ${messageOf(error)}; printing the full result instead`);
    return undefined;
  }
}

/**
 * A plain continue that ran no stage and stopped between stages as the attempt before did: the
 * check on a reused stage's value belongs inside that stage, which a continue would redo.
 */
function sameStop(
  ending: Ending<JsonValue>,
  earlier: readonly AttemptRecord[],
): string | undefined {
  if (ending.kind !== "stopped" || ending.stage !== undefined) return undefined;
  const reused = ending.stages.at(-1)?.stage;
  // No stage ran, and one was reused: its value is what the check between stages saw.
  if (reused === undefined || ending.stages.some((entered) => entered.source === "ran")) {
    return undefined;
  }
  const before = earlier.at(-1);
  if (
    before?.outcome !== "stopped" ||
    before.stage !== undefined ||
    before.reason !== ending.reason
  ) {
    return undefined;
  }
  return `awf: the same stop as attempt ${before.attempt}; if a stage's value caused it, --from-stage ${reused}, and move the check into that stage`;
}

/** Why a run takes no attempt now, as awf says it, at time `now`. */
export function refusalMessage(id: string, refusal: AttemptRefusal, now: number): string {
  if (refusal.kind === "running") {
    return `attempt ${refusal.attempt.attempt} of ${id} is still running, as process ${refusal.attempt.pid}`;
  }
  if (refusal.stages.length === 0) return `${id} completed; there is nothing to continue`;
  return `${id} completed; to redo from a stage, --from-stage one of:\n${listRecorded(refusal.stages, now).join("\n")}`;
}

/** Stage records, a line each, in the order given: summary, attempt, and how long ago. */
function listRecorded(records: readonly StageRecord[], now: number): string[] {
  const name = Math.max(0, ...records.map((record) => record.stage.length));
  const summary = Math.max(0, ...records.map((record) => record.summary?.length ?? 0));
  return records.map((record) =>
    [
      `  ${record.stage.padEnd(name)}`,
      ...(summary > 0 ? [(record.summary ?? "").padEnd(summary)] : []),
      [
        ...(record.outcome === "succeeded" ? [] : [record.outcome]),
        `attempt ${record.attempt}`,
        ago(now - Date.parse(record.ended)),
      ].join(" · "),
    ].join("   "),
  );
}

/**
 * The command that goes on from an attempt that didn't complete: the same file and run root, and
 * `--from-stage` when a plain continue would stop at the same record again, or would drop the redo
 * this attempt asked for and never reached. A `--from-stage` the body returned without reaching
 * has no one command: its stages are listed to choose from.
 */
export function continueCommand(
  command: RunCommand,
  id: string,
  stop: WorkflowStopped | undefined,
  entered: readonly StageSummary[],
): string {
  const { fromStage } = command;
  const redo =
    stop?.redo && stop.stage !== undefined
      ? stop.stage
      : fromStage !== undefined &&
          !(stop instanceof FromStageUnreached) &&
          !entered.some(({ stage }) => stage === fromStage)
        ? fromStage
        : undefined;
  return [
    "awf",
    "run",
    ...(command.runRootGiven ? ["--run-root", command.runRoot] : []),
    ...(command.cwdGiven ? ["--cwd", command.cwd] : []),
    pathFrom(command.shellCwd, command.workflowFile),
    "--continue",
    id,
    ...(redo === undefined ? [] : ["--from-stage", redo]),
  ]
    .map(shellWord)
    .join(" ");
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
