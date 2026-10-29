import { rm } from "node:fs/promises";
import {
  OUTPUT_RECORD_VERSION,
  type OutputRecord,
  RUN_EVENT_VERSIONS,
} from "@agentswf/contract/records";
import type { Ending, JsonValue } from "@agentswf/contract/workflow";
import { attemptAccounting } from "./accounting/summary";
import type { AttemptEnd } from "./attempt-ending";
import { messageOf } from "./errors";
import { writeJson, writeWhole } from "./files";
import { foldMailbox, readMailbox } from "./mailbox";
import { type Attempt, appendEvent, endAttempt, outputFile, reportFile } from "./runs";
import { withoutValue } from "./stage-ledger";
import type { AnyWorkflow, LoadedWorkflow } from "./workflow-loader";

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
    loaded: LoadedWorkflow;
    stderr: (text: string) => void;
    /** An event run's: runs `work` holding its run's lock. */
    locked?: (work: () => Promise<void>) => Promise<void>;
  },
): Promise<Kept> {
  const { attempt, stderr } = context;
  const { ending, settled } = end;
  const dir = attempt.run.dir;
  const report = await writeReport(context.loaded.workflow, ending, dir, stderr);
  const stages = settled?.stages?.map(withoutValue);
  const unfinished = ending.kind !== "completed" && ending.kind !== "parked" ? ending : undefined;
  const at = unfinished?.stage !== undefined ? { stage: unfinished.stage } : {};
  const ended =
    ending.kind === "completed"
      ? { outcome: "completed" as const, value: ending.value }
      : ending.kind === "parked"
        ? {
            outcome: "parked" as const,
            ...(ending.label === undefined ? {} : { label: ending.label }),
            ...(ending.until === undefined ? {} : { until: ending.until }),
          }
        : {
            outcome: ending.kind,
            reason: ending.reason,
            ...at,
            ...(end.needs ? { needs: [...end.needs] } : {}),
          };
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
      attempt: attempt.record.attempt,
      workflow: { name: context.loaded.workflow.meta.name, file: context.loaded.file },
      accounting: settled.accounting,
      usage: settled.usage,
      artifacts: dir,
      ...(settled.sandboxes ? { sandboxes: settled.sandboxes } : {}),
      ...(settled.skills ? { skills: settled.skills } : {}),
      ...(settled.panes ? { panes: settled.panes } : {}),
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
  // Before the ending: once the attempt has ended, the next may start appending.
  await appendEvent(dir, {
    version: RUN_EVENT_VERSIONS["attempt-ended"],
    attempt: attempt.record.attempt,
    at: new Date().toISOString(),
    kind: "attempt-ended",
    outcome: ending.kind,
  }).catch((error) => stderr(`awf: the run's event log was not written: ${messageOf(error)}`));
  // An event run's ending is written holding its run's lock, as parking's is: a sender after it sees
  // the run returned and is refused, so what no wait took is counted whole. Its last batch was
  // handled, as the code returned after it.
  const writeEnding = async () => {
    const unacknowledged =
      ending.kind === "completed" && attempt.run.record.events
        ? await readMailbox(dir).then(
            // The event that started the run is `workflow.started`'s, taken or not.
            (records) => {
              const state = foldMailbox(records);
              return state.unacknowledged.filter((id) => id !== state.started?.id).length;
            },
            (error: unknown) => {
              stderr(`awf: what no wait took was not counted: ${messageOf(error)}`);
              return undefined;
            },
          )
        : undefined;
    await endAttempt(attempt, {
      outcome: ending.kind,
      ...(unacknowledged === undefined ? {} : { unacknowledged }),
      ...(unfinished ? { reason: unfinished.reason } : {}),
      ...at,
      ...(stages ? { stages } : {}),
      ...(settled ? { accounting: attemptAccounting(settled.accounting) } : {}),
    });
  };
  try {
    await (context.locked ?? ((work: () => Promise<void>) => work()))(writeEnding);
  } catch (error) {
    stderr(`awf: the attempt's ending was not written to ${attempt.file}: ${messageOf(error)}`);
  }
  return kept;
}

async function writeReport(
  workflow: AnyWorkflow,
  ending: Ending<JsonValue>,
  dir: string,
  stderr: (text: string) => void,
): Promise<string | undefined> {
  const file = reportFile(dir);
  // An earlier attempt's report is gone with it: report.md is the last ended attempt's.
  const none = () => rm(file, { force: true }).then(() => undefined);
  if (!workflow.report) return none();
  // The result is still in output.json; a report that cannot be rendered or saved should not fail
  // the run, nor cost it its record.
  try {
    const markdown = workflow.report(
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
