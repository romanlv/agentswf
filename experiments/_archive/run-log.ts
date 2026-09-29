import { join } from "node:path";
import { appendLine, readLines } from "@agentswf/engine";

/**
 * Two aggregate logs the experiments write beside a run: the per-trial record E2/E3/E5 report
 * from, and the journal E6 replays from. Neither is production vocabulary, which is why the
 * engine's run directory does not know about them.
 */

export async function appendTrial(runDir: string, record: unknown): Promise<void> {
  await appendLine(join(runDir, "trials.jsonl"), JSON.stringify(record));
}

export async function readTrials<T>(runDir: string): Promise<T[]> {
  return readLines<T>(join(runDir, "trials.jsonl"));
}

/**
 * One replayable call. The key chains: it covers this call's shape, its position, and every
 * call before it, so the first edit invalidates everything downstream of itself.
 */
export type JournalEntry = {
  key: string;
  index: number;
  callId: string;
  value: unknown;
  at: string;
};

/** The journal shares the run directory: a resume is the same run, pointed at the same place. */
export async function appendJournal(runDir: string, entry: JournalEntry): Promise<void> {
  await appendLine(join(runDir, "journal.jsonl"), JSON.stringify(entry));
}

export async function readJournal(runDir: string): Promise<JournalEntry[]> {
  return readLines<JournalEntry>(join(runDir, "journal.jsonl"));
}
