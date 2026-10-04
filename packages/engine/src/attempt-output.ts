import { rm } from "node:fs/promises";
import {
  type AttemptStage,
  OUTPUT_RECORD_VERSION,
  type OutputRecord,
} from "@agentswf/contract/records";
import type {
  Ending,
  ExecutableWorkflow,
  JsonValue,
  StageSummary,
} from "@agentswf/contract/workflow";
import { attemptAccounting } from "./accounting/summary";
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
  const stages = settled?.stages && withoutValues(settled.stages);
  const at =
    ending.kind !== "completed" && ending.stage !== undefined ? { stage: ending.stage } : {};
  const ended =
    ending.kind === "completed"
      ? { outcome: "completed" as const, value: ending.value }
      : { outcome: ending.kind, reason: ending.reason, ...at };
  const kept: Kept = report ? { report } : {};
  const output = outputFile(dir);
  if (!settled) {
    // An earlier attempt's output is gone with it, as its report is.
    await rm(output, { force: true }).catch((error) =>
      stderr(`awf: output.json: ${messageOf(error)}`),
    );
  } else {
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

/** Stages without their values, which their stage records keep. */
export function withoutValues(stages: readonly StageSummary[]): AttemptStage[] {
  return stages.map(({ value: _value, ...stage }) => stage);
}
