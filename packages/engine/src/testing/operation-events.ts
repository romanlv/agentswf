import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  OPERATION_LIVENESS_KINDS,
  OPERATION_LIVENESS_RECORD_VERSION,
  type OperationLivenessRecord,
} from "@agentswf/contract/records";

type OperationEvent = Pick<
  OperationLivenessRecord,
  "kind" | "at" | "sequence" | "reason" | "until"
>;
const MAX_BYTES = 1024 * 1024;
function eventFile(runDir: string, operationId: string): string {
  return join(runDir, "calls", operationId, "liveness.jsonl");
}

export async function readOperationEvents(
  runDir: string,
  operationId: string,
): Promise<{
  records: OperationLivenessRecord[];
  incomplete: boolean;
}> {
  let text: string;
  let clipped = false;
  try {
    const file = await open(eventFile(runDir, operationId), "r");
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      clipped = size > MAX_BYTES;
      text = buffer.subarray(0, Math.min(size, MAX_BYTES)).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return { records: [], incomplete: true };
  }
  let incomplete = clipped || !text.endsWith("\n");
  const records: OperationLivenessRecord[] = [];
  const rows = text.split("\n");
  rows.pop(); // An unterminated row is not a committed diagnostic frame.
  for (const row of rows) {
    try {
      const value: unknown = JSON.parse(row);
      if (!isRecord(value, operationId)) {
        incomplete = true;
        continue;
      }
      records.push(value);
      if (value.dropped || value.truncated) incomplete = true;
    } catch {
      incomplete = true;
    }
  }
  if (records.at(-1)?.kind !== "terminal") incomplete = true;
  return { records, incomplete };
}

function validEvent(value: OperationEvent): boolean {
  return (
    typeof value.kind === "string" &&
    (OPERATION_LIVENESS_KINDS as readonly string[]).includes(value.kind) &&
    Number.isSafeInteger(value.at) &&
    value.at >= 0 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.until === undefined || (Number.isSafeInteger(value.until) && value.until >= 0))
  );
}
function isRecord(value: unknown, operationId: string): value is OperationLivenessRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as OperationLivenessRecord;
  return (
    item.version === OPERATION_LIVENESS_RECORD_VERSION &&
    item.operationId === operationId &&
    validEvent(item) &&
    (item.dropped === undefined || (Number.isSafeInteger(item.dropped) && item.dropped >= 0)) &&
    (item.truncated === undefined || item.truncated === true)
  );
}
