import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  OPERATION_LIVENESS_RECORD_VERSION,
  type OperationLivenessRecord,
} from "@agentswf/contract/records";

export type OperationEvent = Pick<
  OperationLivenessRecord,
  "kind" | "at" | "sequence" | "reason" | "until"
>;
type EventOptions = {
  write?(path: string, line: string): Promise<void>;
  schedule?(delayMs: number, callback: () => void): () => void;
  maxRecords?: number;
  maxBytes?: number;
  maxQueuedRecords?: number;
  maxQueuedBytes?: number;
  flushMs?: number;
};
const MAX_BYTES = 1024 * 1024;
const TERMINAL_RESERVE = 4096;

export function createOperationEvents(
  runDir: string,
  operationId: string,
  options: EventOptions = {},
): {
  record(event: OperationEvent): void;
  close(): Promise<void>;
} {
  const path = eventFile(runDir, operationId);
  const write = options.write ?? append;
  const schedule =
    options.schedule ??
    ((delay, callback) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
  const maxRecords = bound(options.maxRecords, 2048, 2);
  const maxBytes = bound(options.maxBytes, MAX_BYTES, TERMINAL_RESERVE * 2);
  const maxQueuedRecords = bound(options.maxQueuedRecords, 64, 2);
  const maxQueuedBytes = bound(options.maxQueuedBytes, 64 * 1024, TERMINAL_RESERVE * 2);
  const flushMs = bound(options.flushMs, 1000, 1);
  const queue: { value: OperationLivenessRecord; bytes: number }[] = [];
  let totalRecords = 0;
  let totalBytes = 0;
  let queuedBytes = 0;
  let dropped = 0;
  let running = false;
  let closed = false;
  let abandoned = false;
  let terminal = false;
  let closing: Promise<void> | undefined;
  let drained = Promise.withResolvers<void>();

  const pump = async () => {
    if (running || abandoned) return;
    running = true;
    try {
      while (queue.length && !abandoned) {
        const item = queue[0]!;
        const omitted = dropped;
        dropped = 0;
        try {
          await write(
            path,
            `${JSON.stringify({ ...item.value, ...(omitted ? { dropped: omitted } : {}) })}\n`,
          );
        } catch {
          dropped += omitted + 1;
        }
        if (abandoned) break;
        queue.shift();
        queuedBytes -= item.bytes;
      }
    } finally {
      running = false;
      if (!queue.length || abandoned) drained.resolve();
    }
  };

  return {
    record(event) {
      if (closed || terminal) return;
      if (!validEvent(event)) {
        dropped++;
        return;
      }
      const value: OperationLivenessRecord = {
        version: OPERATION_LIVENESS_RECORD_VERSION,
        operationId,
        ...event,
      };
      if (value.reason !== undefined && Buffer.byteLength(JSON.stringify(value.reason)) > 2050) {
        value.reason = truncate(value.reason, 2048);
        value.truncated = true;
      }
      const bytes =
        Buffer.byteLength(JSON.stringify({ ...value, dropped: Number.MAX_SAFE_INTEGER })) + 1;
      const isTerminal = event.kind === "terminal";
      const recordLimit = isTerminal ? maxRecords : maxRecords - 1;
      const byteLimit = isTerminal ? maxBytes : maxBytes - TERMINAL_RESERVE;
      const queueLimit = isTerminal ? maxQueuedRecords : maxQueuedRecords - 1;
      const queueByteLimit = isTerminal ? maxQueuedBytes : maxQueuedBytes - TERMINAL_RESERVE;
      if (
        totalRecords >= recordLimit ||
        totalBytes + bytes > byteLimit ||
        queue.length >= queueLimit ||
        queuedBytes + bytes > queueByteLimit
      ) {
        dropped++;
        return;
      }
      terminal = isTerminal;
      if (!queue.length && !running) drained = Promise.withResolvers<void>();
      queue.push({ value, bytes });
      totalRecords++;
      totalBytes += bytes;
      queuedBytes += bytes;
      void pump();
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        if (!queue.length && !running) return;
        let cancel = () => {};
        const expired = new Promise<void>((resolve) => {
          cancel = schedule(flushMs, resolve);
        });
        try {
          await Promise.race([drained.promise, expired]);
        } finally {
          cancel();
          abandoned = true;
          queue.length = 0;
          queuedBytes = 0;
        }
      })();
      return closing;
    },
  };
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
    value.kind.length > 0 &&
    Buffer.byteLength(value.kind) <= 64 &&
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
function truncate(text: string, bytes: number): string {
  let result = "";
  let used = 0;
  for (const character of text) {
    used += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (used > bytes) break;
    result += character;
  }
  return result;
}
function bound(value: number | undefined, fallback: number, minimum: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < minimum)
    throw new Error(`diagnostic bound must be an integer >= ${minimum}`);
  return actual;
}
function eventFile(runDir: string, operationId: string): string {
  return join(runDir, "calls", operationId, "liveness.jsonl");
}
async function append(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, { mode: 0o600 });
}
