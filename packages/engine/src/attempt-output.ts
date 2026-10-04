import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import {
  type AttemptAccounting,
  type AttemptRecord,
  OUTPUT_RECORD_VERSION,
  type OutputRecord,
  type RunAccounting,
} from "@agentswf/contract/records";
import type { Ending, ExecutableWorkflow, JsonValue } from "@agentswf/contract/workflow";
import { describeAccounting } from "./accounting/format";
import { sumAttempts } from "./accounting/summary";
import type { AttemptEnd } from "./attempt-ending";
import { messageOf } from "./errors";
import { writeJson, writeWhole } from "./files";
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
 * What the attempt cost, and for a later attempt the whole run: its attempts summed, by stage,
 * naming those with no accounting, which an interrupted attempt leaves.
 */
export function accountingLines(
  id: string,
  n: number,
  current: RunAccounting,
  earlier: readonly AttemptRecord[],
): string[] {
  if (n <= 1) return describeAccounting(current);
  const before = earlier.filter((record) => record.n < n);
  const recorded = [...before.flatMap((record) => record.accounting ?? []), current];
  const [first, ...stages] = describeAccounting(sumAttempts(recorded));
  const missing = n - recorded.length;
  const gap = missing > 0 ? ` (${missing} with no accounting)` : "";
  return [...describeAccounting(current), `run ${id}, ${n} attempts${gap}: ${first}`, ...stages];
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
