import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { parseRow, record, text } from "../json";
import { claudeProjectDirectory } from "../usage/claude";
import { abortableDelay } from "./herdr-protocol";

const MAX_FILES = 256;
const MAX_ROWS = 4096;
const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const POLL_MS = 100;

/** Only native prompt insertion and linked model output count; queued is not yet received. */
export function createClaudeReceiptReducer(marker: string) {
  const parents = new Map<string, string | undefined>();
  const inputs = new Set<string>();
  let accepted = false;
  let received = false;
  const matches = (value: unknown) => {
    if (typeof value !== "string") return false;
    if (value.startsWith(marker)) return true;
    // Claude wraps terminal bracketed pastes before persisting the human input.
    const paste = /^\n\n<pasted_content id="[A-Za-z0-9]+">\n/.exec(value);
    return paste !== null && value.slice(paste[0].length).startsWith(marker);
  };
  return {
    push(value: unknown): { accepted: boolean; received: boolean } {
      const row = record(value);
      if (!row || row.isSidechain === true) return { accepted, received };
      const attachment = record(row.attachment);
      const message = record(row.message);
      const input =
        (row.type === "user" && matches(message?.content)) ||
        (row.type === "attachment" &&
          attachment?.type === "queued_command" &&
          attachment.commandMode === "prompt" &&
          attachment.humanTurn === true &&
          record(attachment.origin)?.kind === "human" &&
          matches(attachment.prompt));
      if (
        input ||
        (row.type === "queue-operation" && row.operation === "enqueue" && matches(row.content))
      ) {
        accepted = true;
      }
      const uuid = text(row.uuid);
      if (uuid) {
        if (parents.has(uuid)) return { accepted, received };
        if (parents.size >= MAX_ROWS) throw new Error("Claude receipt ancestry exceeds its bound");
        parents.set(uuid, text(row.parentUuid));
        if (input) inputs.add(uuid);
        if (
          row.type === "assistant" &&
          message?.role === "assistant" &&
          typeof message.model === "string" &&
          message.model !== "<synthetic>"
        ) {
          let parent = text(row.parentUuid);
          const visited = new Set<string>();
          while (parent && !visited.has(parent)) {
            if (inputs.has(parent)) {
              received = true;
              accepted = true;
              break;
            }
            visited.add(parent);
            parent = parents.get(parent);
          }
        }
      }
      return { accepted, received };
    },
  };
}

type Cursor = {
  inode: number;
  offset: number;
  partial: Buffer;
  reducer: ReturnType<typeof createClaudeReceiptReducer>;
};

/** Baseline before dispatch; a new file is read from its start, existing history is never proof. */
export async function prepareClaudeReceipt(cwd: string, marker: string, home?: string) {
  const directory = await claudeProjectDirectory(cwd, home);
  const cursors = new Map<string, Cursor>();
  const files = async () => {
    const names: string[] = [];
    const entries = await opendir(directory).catch((error: unknown) => {
      if (record(error)?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entries) return names;
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (names.length >= MAX_FILES) throw new Error("Claude receipt directory exceeds its bound");
      names.push(entry.name);
    }
    return names;
  };
  for (const name of await files()) {
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      cursors.set(name, {
        inode: stat.ino,
        offset: stat.size,
        partial: Buffer.alloc(0),
        reducer: createClaudeReceiptReducer(marker),
      });
    } finally {
      await file.close();
    }
  }
  return {
    async watch(
      signal: AbortSignal,
      onAccepted: () => void,
      onReceived: () => void,
      pause: (signal: AbortSignal) => Promise<boolean> = (signal) =>
        abortableDelay(POLL_MS, signal),
      deadline: () => number = () => Number.POSITIVE_INFINITY,
    ) {
      let bytes = 0;
      let reportedAcceptance = false;
      while (!signal.aborted && Date.now() < deadline()) {
        for (const name of await files()) {
          if (signal.aborted) return;
          const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            let cursor = cursors.get(name);
            if (!cursor) {
              if (cursors.size >= MAX_FILES)
                throw new Error("Claude receipt file history exceeds its bound");
              cursor = {
                inode: stat.ino,
                offset: 0,
                partial: Buffer.alloc(0),
                reducer: createClaudeReceiptReducer(marker),
              };
              cursors.set(name, cursor);
            }
            if (cursor.inode !== stat.ino || stat.size < cursor.offset)
              throw new Error("Claude receipt transcript was replaced or truncated");
            const size = Math.min(CHUNK_BYTES, stat.size - cursor.offset);
            if (size === 0) continue;
            if (bytes + size > MAX_BYTES) throw new Error("Claude receipt read exceeds its bound");
            const buffer = Buffer.alloc(size);
            const { bytesRead } = await file.read(buffer, 0, size, cursor.offset);
            if (signal.aborted) return;
            bytes += bytesRead;
            cursor.offset += bytesRead;
            cursor.partial = Buffer.concat([cursor.partial, buffer.subarray(0, bytesRead)]);
            let newline = cursor.partial.indexOf(10);
            while (newline >= 0) {
              const line = cursor.partial.subarray(0, newline).toString("utf8");
              cursor.partial = cursor.partial.subarray(newline + 1);
              const receipt = cursor.reducer.push(parseRow(line));
              if (receipt.accepted && !reportedAcceptance) {
                reportedAcceptance = true;
                onAccepted();
              }
              if (receipt.received) {
                onReceived();
                return;
              }
              newline = cursor.partial.indexOf(10);
            }
          } finally {
            await file.close();
          }
        }
        if (!(await pause(signal))) return;
      }
    },
  };
}
