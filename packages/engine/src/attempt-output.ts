import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import {
  type AttemptAccounting,
  type AttemptRecord,
  OUTPUT_RECORD_VERSION,
  type OutputRecord,
  type RunAccounting,
} from "@agentswf/contract/records";
import type { Ending, ExecutableWorkflow, JsonValue } from "@agentswf/contract/workflow";
import {
  describeAttempts,
  describeDecisionLine,
  describeFigures,
  describeGroups,
  duration,
} from "./accounting/format";
import { sumAttempts } from "./accounting/summary";
import { type AttemptEnd, ENDINGS } from "./attempt-ending";
import { messageOf } from "./errors";
import { writeJson, writeWhole } from "./files";
import { endingMark, type Paint } from "./progress-view";
import { type Attempt, endAttempt, outputFile, reportFile } from "./runs";

/** Where an attempt's records went, and its output record as `--json` prints it. */
export type Kept = {
  /** Absent when the run never settled, so there is nothing to record but its ending. */
  json?: string;
  /** output.json, once written. */
  output?: string;
  report?: string;
};

/**
 * Writes an attempt's records, each from its one ending: report.md, output.json, then the ending in
 * its attempt file. The ending goes last: an ended attempt lets the next start, whose report and
 * output this one's must not overwrite. A record that fails to write is said, and costs no other.
 */
export async function keepRecords(
  end: AttemptEnd,
  context: {
    attempt: Attempt;
    executable: ExecutableWorkflow<JsonValue, JsonValue>;
    workflow: { name: string; file: string };
    stderr: (text: string) => void;
  },
): Promise<Kept> {
  const { attempt, stderr } = context;
  const { ending, settled } = end;
  const dir = attempt.run.dir;
  const report = await writeReport(context.executable, ending, dir, stderr);
  const stages = settled?.stages?.map(({ value: _value, ...stage }) => stage);
  const at =
    ending.kind !== "completed" && ending.stage !== undefined ? { stage: ending.stage } : {};
  const ended =
    ending.kind === "completed"
      ? { outcome: "completed" as const, value: ending.value }
      : { outcome: ending.kind, reason: ending.reason, ...at };
  const kept: Kept = report ? { report } : {};
  if (settled) {
    const record: OutputRecord = {
      version: OUTPUT_RECORD_VERSION,
      runId: settled.runId,
      attempt: attempt.record.n,
      workflow: context.workflow,
      accounting: settled.accounting,
      usage: settled.usage,
      artifacts: dir,
      ...(settled.sandboxes ? { sandboxes: settled.sandboxes } : {}),
      ...(settled.skills ? { skills: settled.skills } : {}),
      ...(settled.decisions ? { decisions: settled.decisions } : {}),
      ...(stages ? { stages } : {}),
      ...(report ? { report } : {}),
      ...ended,
    };
    kept.json = JSON.stringify(record, null, 2);
    const output = outputFile(dir);
    try {
      await writeJson(output, record);
      kept.output = output;
    } catch (error) {
      stderr(`awf: output.json: ${messageOf(error)}`);
    }
  }
  try {
    await endAttempt(attempt, {
      outcome: ending.kind,
      ...(ending.kind === "completed" ? {} : { reason: ending.reason }),
      ...at,
      ...(stages ? { stages } : {}),
      ...(settled ? { accounting: attemptAccounting(settled.accounting) } : {}),
    });
  } catch (error) {
    stderr(`awf: the attempt's ending was not written to ${attempt.file}: ${messageOf(error)}`);
  }
  return kept;
}

/** A completed attempt's value as the workflow presents it; undefined to print the JSON. */
export function present(
  executable: ExecutableWorkflow<JsonValue, JsonValue>,
  ending: Ending<JsonValue>,
  stderr: (text: string) => void,
): string | undefined {
  if (!executable.present || ending.kind !== "completed") return undefined;
  try {
    return executable.present(ending.value, ending)?.trimEnd();
  } catch (error) {
    stderr(`awf: present: ${messageOf(error)}; printing the full result instead`);
    return undefined;
  }
}

async function writeReport(
  executable: ExecutableWorkflow<JsonValue, JsonValue>,
  ending: Ending<JsonValue>,
  dir: string,
  stderr: (text: string) => void,
): Promise<string | undefined> {
  const file = reportFile(dir);
  // An earlier attempt's report is gone with it: report.md is the last ended attempt's.
  const none = () => rm(file, { force: true }).then(() => undefined);
  if (!executable.report) return none();
  // The result is still in output.json; a report that cannot be rendered or saved should not fail
  // the run, nor cost it its record.
  try {
    const markdown = executable.report(
      ending.kind === "completed" ? ending.value : undefined,
      ending,
    );
    if (markdown === undefined) return await none();
    await writeWhole(file, `${markdown.trimEnd()}\n`);
    return file;
  } catch (error) {
    stderr(`awf: report: ${messageOf(error)}; see output.json instead`);
    return undefined;
  }
}

/**
 * How an attempt ended, once, after its stages: the outcome, where and why; the run and what the
 * attempt cost, and for a later attempt the whole run, naming attempts with no accounting, which an
 * interrupted one leaves; then the command that goes on, and where the records are.
 */
export function describeEnding(
  ending: Ending<JsonValue>,
  context: {
    /** The workflow's name and the run's id. */
    named: string;
    n: number;
    accounting?: RunAccounting;
    earlier: readonly AttemptRecord[];
    records: string;
    report?: string;
    paint: Paint;
  },
): string[] {
  const { accounting, n } = context;
  const mark = endingMark(ending.kind, context.paint);
  const run = [
    context.named,
    ...(n > 1 ? [`attempt ${n}`] : []),
    ...(accounting ? [duration(accounting.wallMs), ...describeFigures(accounting)] : []),
    ...(n > 1 && accounting ? [runTotal(n, accounting, context.earlier)] : []),
  ].join(" · ");
  const head =
    ending.kind === "completed"
      ? [`${mark} completed · ${run}`]
      : [
          `${mark} ${ENDINGS[ending.kind].ended}${ending.stage === undefined ? "" : ` in ${ending.stage}`}: ${ending.reason}`,
          `  ${run}`,
        ];
  const rows: [string, string][] = [
    ...(ending.kind === "completed" ? [] : [["go on", ending.continue] as [string, string]]),
    ...(context.report ? [["report", context.report] as [string, string]] : []),
    ["records", context.records],
  ];
  return [
    ...head,
    ...(accounting ? [...describeDecisionLine(accounting), ...describeGroups(accounting)] : []),
    ...rows.map(([key, value]) => `  ${key.padEnd(7)}  ${value}`),
  ];
}

function runTotal(n: number, current: RunAccounting, earlier: readonly AttemptRecord[]): string {
  const recorded = [
    ...earlier.filter((record) => record.n < n).flatMap((record) => record.accounting ?? []),
    current,
  ];
  return describeAttempts(sumAttempts(recorded), n, n - recorded.length);
}

/** A path under `cwd` relative to it, one under home from `~`; any other in full. */
export function shown(path: string, cwd: string): string {
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : tilde(path);
}

export function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function attemptAccounting({
  basis,
  wallMs,
  grouping,
  billing,
  totals,
  byStage,
  unpriced,
}: RunAccounting): AttemptAccounting {
  return { basis, wallMs, grouping, billing, totals, byStage, unpriced };
}
