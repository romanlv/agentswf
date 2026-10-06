import type {
  AgentPaneRecord,
  AttemptRecord,
  RunAccounting,
  StageNeed,
  StageRecord,
} from "@agentswf/contract/records";
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
import { schemaLines } from "./stage-schema";
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
    ...(end.choose?.length ? { choose: listRecorded(end.choose, context.now) } : {}),
    ...(end.needs ? { needs: end.needs } : {}),
    ...(settled?.panes ? { panes: settled.panes } : {}),
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
 * attempt cost, and for a later attempt the whole run, counting the attempts whose cost is
 * unknown; then the value it stopped for, the command that goes on, or the stages to choose from,
 * and where the records are. `stages` lists what each stage cost, where no view beside them did.
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
    /** The recorded stages, a line each, one of which the go-on's `{stage}` needs. */
    choose?: readonly string[];
    /** The stages whose values `--values` gives, and their schemas. */
    needs?: readonly StageNeed[];
    panes?: readonly AgentPaneRecord[];
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
    ? [ending.continue, `${STAGE} one of:`, ...context.choose]
    : [ending.continue];
  return [
    `${mark} ${word}${ending.stage === undefined ? "" : ` in ${ending.stage}`}: ${first}`,
    ...more.map((line) => `    ${line.trim()}`),
    `  ${run}`,
    ...figures,
    ...rows(goOn, context),
  ];
}

/**
 * The rows under an ending: the value it stopped for, the command that goes on, its lines given,
 * the report, the records.
 */
function rows(
  goOn: readonly string[],
  context: {
    records: string;
    report?: string;
    needs?: readonly StageNeed[];
    panes?: readonly AgentPaneRecord[];
  },
): string[] {
  const row = (key: string, value: string) => `  ${key.padEnd(7)}  ${value}`;
  const under = (line: string) => `${" ".repeat(11)}${line}`;
  const [command, ...choices] = goOn;
  // A stage a line, and a schema with branches a line per branch under it.
  const [first, ...needs] = (context.needs ?? []).flatMap(({ stage, schema }) => {
    const [only, ...more] = schemaLines(schema);
    return more.length === 0
      ? [`${stage}: ${only}`]
      : [`${stage}, one of:`, ...[only!, ...more].map((line) => `  ${line}`)];
  });
  return [
    ...(first === undefined ? [] : [row("needs", first), ...needs.map(under)]),
    ...(command === undefined ? [] : [row("go on", command)]),
    ...choices.map(under),
    ...paneRows(context.panes ?? []).map(([key, value]) => row(key, value)),
    ...(context.report ? [row("report", context.report)] : []),
    row("records", context.records),
  ];
}

/**
 * Each pane that fell back from its layout, and why, and each kept one, with where to find it:
 * once each, as nothing else says them.
 */
export function paneRows(panes: readonly AgentPaneRecord[]): [string, string][] {
  return panes.flatMap(({ agent, placed }): [string, string][] => [
    ...(placed.fallback === undefined
      ? []
      : [["pane", `${agent} in a tab of its own: ${placed.fallback}`] as [string, string]]),
    ...(placed.notKept === undefined
      ? []
      : [["pane", `${agent} closed, not kept: ${placed.notKept}`] as [string, string]]),
    ...(placed.kept ? [["kept", `${agent} · ${whereKept(placed)}`] as [string, string]] : []),
  ]);
}

function whereKept({ session, workspace, tab }: AgentPaneRecord["placed"]): string {
  const where =
    workspace === "origin"
      ? "where awf run was typed"
      : workspace === "run"
        ? `this run's workspace in herdr session ${session}`
        : `workspace "${workspace.name}" in herdr session ${session}`;
  return [
    tab === undefined ? where : `tab "${tab}", ${where}`,
    // awf starts its own sessions headless: attached to from a terminal outside Herdr.
    ...(workspace === "origin" ? [] : [`herdr session attach ${session}`]),
  ].join(" · ");
}

function runTotal(n: number, current: RunAccounting, earlier: readonly AttemptRecord[]): string {
  const before = earlier.filter((record) => record.attempt < n);
  const recorded = [...before.flatMap((record) => record.accounting ?? []), current];
  const unknown = before.filter((record) => record.accounting === undefined);
  const interrupted = unknown.filter((record) => record.ended === undefined).length;
  return describeAttempts(sumAttempts(recorded), n, {
    interrupted,
    ended: unknown.length - interrupted,
  });
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
 * has no one command: it names `{stage}`, for one of the run's stages, and isn't runnable as is.
 * Going on from that start point repeats `--values`, or names `{file}` for a value it stopped for.
 */
export function continueCommand(
  command: RunCommand,
  id: string,
  stop: WorkflowStopped | undefined,
  entered: readonly StageSummary[],
): string {
  const { fromStage } = command;
  const redo =
    stop instanceof FromStageUnreached
      ? STAGE
      : stop?.redo && stop.stage !== undefined
        ? stop.stage
        : fromStage !== undefined && !entered.some(({ stage }) => stage === fromStage)
          ? fromStage
          : undefined;
  const values =
    redo === undefined || redo !== fromStage
      ? undefined
      : command.values
        ? pathFrom(command.shellCwd, command.values.file)
        : stop?.needs
          ? FILE
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
    ...(values === undefined ? [] : ["--values", values]),
  ]
    .map((word) => (word === STAGE || word === FILE ? word : shellWord(word)))
    .join(" ");
}

/** The placeholder a go-on names when the operator chooses the stage. */
const STAGE = "{stage}";
/** The placeholder for the file of values a go-on needs and none was given. */
const FILE = "{file}";

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}
