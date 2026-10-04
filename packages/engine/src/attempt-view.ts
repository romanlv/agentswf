import type { AttemptRecord, RunAccounting } from "@agentswf/contract/records";
import type { Ending, ExecutableWorkflow, JsonValue } from "@agentswf/contract/workflow";
import { describeAccounting, describeAttempts } from "./accounting/format";
import { sumAttempts } from "./accounting/summary";
import { type AttemptEnd, OUTCOMES } from "./attempt-ending";
import type { Kept } from "./attempt-output";
import { pathFrom } from "./display-path";
import { messageOf } from "./errors";
import { ANSI, type Paint, PLAIN } from "./progress-view";

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
    shellCwd: string;
    cleanupAlso?: string;
    /** Given when the stages and their cost were drawn on a terminal, not written as a log. */
    terminal?: { color: boolean };
    stdout: (text: string) => void;
    stderr: (text: string) => void;
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
  if (again) stderr(`awf: ${again}`);
  if (context.cleanupAlso) stderr(`awf: runtime cleanup also failed: ${context.cleanupAlso}`);
  // Beside the result rather than in it: stdout stays the workflow's report or the JSON.
  const lines = describeEnding(ending, {
    named: `${context.executable.definition.meta.name} ${context.run.id}`,
    n: context.n,
    ...(settled ? { accounting: settled.accounting } : {}),
    earlier: context.earlier,
    stages: context.terminal === undefined,
    records: pathFrom(shellCwd, context.run.dir, { home: true }),
    ...(kept.report ? { report: pathFrom(shellCwd, kept.report, { home: true }) } : {}),
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
 * attempt cost, and for a later attempt the whole run, naming attempts with no accounting, which an
 * interrupted one leaves; then the command that goes on, and where the records are. `stages` lists
 * what each stage cost, where no view beside them did.
 */
export function describeEnding(
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
  const head =
    ending.kind === "completed"
      ? [`${mark} ${word} · ${run}`]
      : [
          `${mark} ${word}${ending.stage === undefined ? "" : ` in ${ending.stage}`}: ${ending.reason}`,
          `  ${run}`,
        ];
  const rows: [string, string][] = [
    ...(ending.kind === "completed" ? [] : [["go on", ending.continue] as [string, string]]),
    ...(context.report ? [["report", context.report] as [string, string]] : []),
    ["records", context.records],
  ];
  return [...head, ...figures, ...rows.map(([key, value]) => `  ${key.padEnd(7)}  ${value}`)];
}

function runTotal(n: number, current: RunAccounting, earlier: readonly AttemptRecord[]): string {
  const recorded = [
    ...earlier.filter((record) => record.n < n).flatMap((record) => record.accounting ?? []),
    current,
  ];
  return describeAttempts(sumAttempts(recorded), n, n - recorded.length);
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
  return `the same stop as attempt ${before.n}; if a stage's value caused it, --from-stage ${reused}, and move the check into that stage`;
}
