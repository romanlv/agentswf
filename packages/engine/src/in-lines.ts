import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { EventLine } from "@agentswf/contract/records";
import { appendLine, endTornLine, readLines } from "./jsonl";

/** `in.jsonl`: the events senders gave the run, appended under the run's lock. */
export function inFile(runDir: string): string {
  return join(runDir, "in.jsonl");
}

/** The run's events in the order written, less a line a crash tore. */
export async function readIn(runDir: string): Promise<EventLine[]> {
  return readLines<EventLine>(inFile(runDir));
}

/** Appends an event; the caller holds the run's lock. */
export async function appendIn(runDir: string, line: EventLine): Promise<void> {
  await endTornLine(inFile(runDir));
  await appendLine(inFile(runDir), JSON.stringify(line));
}

/** `in.jsonl`'s size, which a waiting run polls: a sender's append changes it. */
export async function inSize(runDir: string): Promise<number> {
  return stat(inFile(runDir)).then(
    (stats) => stats.size,
    () => 0,
  );
}
