import { constants, type FSWatcher, watch as watchDirectory } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { parseRow, record, text } from "../json";
import { claudeProjectDirectory } from "../usage/claude";
import { abortableDelay } from "./herdr-protocol";

const MAX_FILES = 256;
const MAX_BASELINE_FILES = 100_000;
const MAX_BASELINE_NAME_BYTES = 16 * 1024 * 1024;
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

/** Historical names are discovery metadata, not live receipt cursors. */
export async function prepareClaudeReceipt(
  cwd: string,
  marker: string,
  home?: string,
  options: { sessionRef?: string; signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const directory = await claudeProjectDirectory(cwd, home);
  const known = options.sessionRef ? `${options.sessionRef}.jsonl` : undefined;
  const cursors = new Map<string, Cursor>();
  const baseline = new Map<string, { inode: number; offset: number } | undefined>();
  const relevant = (name: string) => !known || name === known || !baseline.has(name);
  const fileNames = async function* () {
    const entries = await opendir(directory).catch((error: unknown) => {
      if (record(error)?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entries) return;
    for await (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) yield entry.name;
    }
  };
  const cursorFor = (name: string, inode: number, offset: number) => {
    if (cursors.size >= MAX_FILES) throw new Error("Claude receipt file history exceeds its bound");
    const cursor = {
      inode,
      offset,
      partial: Buffer.alloc(0),
      reducer: createClaudeReceiptReducer(marker),
    };
    cursors.set(name, cursor);
    return cursor;
  };
  let baselineNameBytes = 0;
  for await (const name of fileNames()) {
    options.signal?.throwIfAborted();
    baselineNameBytes += Buffer.byteLength(name);
    if (baseline.size >= MAX_BASELINE_FILES || baselineNameBytes > MAX_BASELINE_NAME_BYTES)
      throw new Error("Claude receipt discovery baseline exceeds its bound");
    baseline.set(name, undefined);
    if (known && name !== known) continue;
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        if (record(error)?.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!file) continue;
    try {
      const stat = await file.stat();
      baseline.set(name, { inode: stat.ino, offset: stat.size });
      if (name === known) cursorFor(name, stat.ino, stat.size);
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
      let watcher: FSWatcher | undefined;
      let watcherFailure: Error | undefined;
      const dirty = new Set(cursors.keys());
      const enqueue = (name: string) => {
        if (!name.endsWith(".jsonl") || !relevant(name)) return;
        if (!dirty.has(name) && dirty.size >= MAX_FILES) {
          watcherFailure = new Error("Claude receipt change queue exceeds its bound");
          return;
        }
        dirty.add(name);
      };
      try {
        while (!signal.aborted && Date.now() < deadline()) {
          if (!watcher) {
            try {
              watcher = watchDirectory(directory, { persistent: false }, (_event, name) => {
                if (name) enqueue(String(name));
                else watcherFailure = new Error("Claude receipt directory change has no filename");
              });
              watcher.on("error", (error) => {
                watcherFailure = error;
              });
              // Covers creation/appends between the baseline and subscribing to directory changes.
              for await (const name of fileNames()) {
                if (signal.aborted || Date.now() >= deadline()) return;
                if (!relevant(name)) continue;
                const before = baseline.get(name);
                if (!before || name === known) {
                  enqueue(name);
                  continue;
                }
                const file = await open(
                  join(directory, name),
                  constants.O_RDONLY | constants.O_NOFOLLOW,
                ).catch((error: unknown) => {
                  if (record(error)?.code === "ENOENT") return undefined;
                  throw error;
                });
                if (!file) continue;
                try {
                  const stat = await file.stat();
                  if (stat.ino !== before.inode || stat.size !== before.offset) enqueue(name);
                } finally {
                  await file.close();
                }
              }
            } catch (error) {
              if (record(error)?.code !== "ENOENT") throw error;
            }
          }
          if (watcherFailure) throw watcherFailure;
          for (const name of cursors.keys()) enqueue(name);
          const pending = [...dirty];
          dirty.clear();
          for (const name of pending) {
            if (signal.aborted) return;
            const file = await open(
              join(directory, name),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            ).catch((error: unknown) => {
              if (record(error)?.code === "ENOENT" && !cursors.has(name)) return undefined;
              throw error;
            });
            if (!file) continue;
            try {
              const stat = await file.stat();
              let cursor = cursors.get(name);
              if (!cursor && !relevant(name)) continue;
              const before = baseline.get(name);
              cursor ??= cursorFor(name, before?.inode ?? stat.ino, before?.offset ?? 0);
              if (cursor.inode !== stat.ino || stat.size < cursor.offset)
                throw new Error("Claude receipt transcript was replaced or truncated");
              const size = Math.min(CHUNK_BYTES, stat.size - cursor.offset);
              if (size === 0) continue;
              if (bytes + size > MAX_BYTES)
                throw new Error("Claude receipt read exceeds its bound");
              const buffer = Buffer.alloc(size);
              const { bytesRead } = await file.read(buffer, 0, size, cursor.offset);
              if (signal.aborted) return;
              bytes += bytesRead;
              cursor.offset += bytesRead;
              if (cursor.offset < stat.size) enqueue(name);
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
      } finally {
        watcher?.close();
      }
    },
  };
}
