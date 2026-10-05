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
const SCAN_BATCH = 64;

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
      if (!accepted) return { accepted, received };
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

class ReceiptCapacityError extends Error {}

type Cursor = {
  inode: number;
  offset: number;
  rowStart: number;
  tail: Buffer;
  matched: boolean;
  bytes: number;
  protected: boolean;
  partial: Buffer;
  reducer?: ReturnType<typeof createClaudeReceiptReducer>;
};

function* markerRows(cursor: Cursor, data: Buffer, start: number, marker: Buffer) {
  let position = 0;
  while (position < data.length) {
    const newline = data.indexOf(10, position);
    const end = newline < 0 ? data.length : newline;
    if (!cursor.matched) {
      const search = Buffer.concat([cursor.tail, data.subarray(position, end)]);
      cursor.matched = search.includes(marker);
      cursor.tail = Buffer.from(search.subarray(Math.max(0, search.length - marker.length + 1)));
    }
    if (newline < 0) return;
    const rowEnd = start + newline;
    if (cursor.matched && rowEnd - cursor.rowStart <= MAX_BYTES)
      yield { offset: cursor.rowStart, length: rowEnd - cursor.rowStart };
    cursor.rowStart = rowEnd + 1;
    cursor.tail = Buffer.alloc(0);
    cursor.matched = false;
    position = newline + 1;
  }
}

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
  const markerBytes = Buffer.from(marker);
  const cursors = new Map<string, Cursor>();
  const progress = new Map<string, Cursor>();
  const baseline = new Map<string, { inode: number; offset: number } | undefined>();
  let discoveryNameBytes = 0;
  let newNames = 0;
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
    if (!baseline.has(name) && !progress.has(name)) {
      discoveryNameBytes += Buffer.byteLength(name);
      if (
        baseline.size + ++newNames > MAX_BASELINE_FILES ||
        discoveryNameBytes > MAX_BASELINE_NAME_BYTES
      )
        throw new ReceiptCapacityError("Claude receipt discovery history exceeds its bound");
    }
    const cursor: Cursor = {
      inode,
      offset,
      rowStart: offset,
      tail: Buffer.alloc(0),
      matched: false,
      bytes: 0,
      protected: name === known,
      partial: Buffer.alloc(0),
      ...(name === known ? { reducer: createClaudeReceiptReducer(marker) } : {}),
    };
    progress.set(name, cursor);
    return cursor;
  };
  for await (const name of fileNames()) {
    options.signal?.throwIfAborted();
    discoveryNameBytes += Buffer.byteLength(name);
    if (baseline.size >= MAX_BASELINE_FILES || discoveryNameBytes > MAX_BASELINE_NAME_BYTES)
      throw new Error("Claude receipt discovery baseline exceeds its bound");
    baseline.set(name, undefined);
    if (known && name !== known) continue;
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
      (error: unknown) => {
        if (name !== known || record(error)?.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!file) continue;
    try {
      const stat = await file.stat();
      baseline.set(name, { inode: stat.ino, offset: stat.size });
      if (name === known) cursors.set(name, cursorFor(name, stat.ino, stat.size));
    } catch (error) {
      if (name === known) throw error;
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
      let reportedAcceptance = false;
      let workBytes = 0;
      let watcher: FSWatcher | undefined;
      let watcherFailure: Error | undefined;
      let rescanRequested = false;
      let scan: AsyncGenerator<string> | undefined;
      const protectedFile = (name: string) =>
        name === known || progress.get(name)?.protected === true;
      const dirty = new Set(cursors.keys());
      const enqueue = (name: string) => {
        if (!name.endsWith(".jsonl") || !relevant(name) || dirty.has(name)) return;
        if (dirty.size >= MAX_FILES) {
          rescanRequested = true;
          const discard = [...dirty].find((candidate) => !protectedFile(candidate));
          if (discard === undefined) return;
          dirty.delete(discard);
        }
        dirty.add(name);
      };
      const track = (name: string, cursor: Cursor) => {
        if (!cursors.has(name) && cursors.size >= MAX_FILES) {
          const discard = [...cursors].find(([, entry]) => !entry.protected)?.[0];
          if (discard === undefined)
            throw new ReceiptCapacityError("Claude protected receipt files exceed their bound");
          cursors.delete(discard);
          rescanRequested = true;
        }
        cursors.set(name, cursor);
      };
      const protectedRows = (cursor: Cursor, data: Buffer): boolean => {
        if (cursor.bytes + data.length > MAX_BYTES)
          throw new Error("Claude receipt read exceeds its bound");
        cursor.bytes += data.length;
        cursor.partial = Buffer.concat([cursor.partial, data]);
        let newline = cursor.partial.indexOf(10);
        while (newline >= 0) {
          const line = cursor.partial.subarray(0, newline).toString("utf8");
          cursor.partial = cursor.partial.subarray(newline + 1);
          const receipt = cursor.reducer!.push(parseRow(line));
          if (receipt.accepted && !reportedAcceptance) {
            reportedAcceptance = true;
            onAccepted();
          }
          if (receipt.received) {
            onReceived();
            return true;
          }
          newline = cursor.partial.indexOf(10);
        }
        cursor.partial = Buffer.from(cursor.partial);
        if ([...cursors.values()].reduce((sum, entry) => sum + entry.partial.length, 0) > MAX_BYTES)
          throw new Error("Claude receipt buffered data exceeds its bound");
        return false;
      };
      try {
        while (!signal.aborted && Date.now() < deadline()) {
          if (!watcher) {
            try {
              watcher = watchDirectory(directory, { persistent: false }, (_event, name) => {
                if (name) enqueue(String(name));
                else rescanRequested = true;
              });
              watcher.on("error", (error) => {
                watcherFailure = error;
              });
              rescanRequested = true;
            } catch (error) {
              if (record(error)?.code !== "ENOENT") throw error;
            }
          }
          if (watcherFailure) throw watcherFailure;
          if (!scan && rescanRequested && dirty.size < SCAN_BATCH) {
            scan = fileNames();
            rescanRequested = false;
          }
          if (scan && dirty.size < SCAN_BATCH) {
            for (let count = 0; count < SCAN_BATCH; count++) {
              if (signal.aborted || Date.now() >= deadline()) return;
              const next = await scan.next();
              if (next.done) {
                scan = undefined;
                break;
              }
              const name = next.value;
              if (!relevant(name)) continue;
              const before = progress.get(name) ?? baseline.get(name);
              if (!before || name === known) {
                enqueue(name);
                continue;
              }
              const file = await open(
                join(directory, name),
                constants.O_RDONLY | constants.O_NOFOLLOW,
              ).catch((error: unknown) => {
                if (protectedFile(name)) throw error;
                return undefined;
              });
              if (!file) continue;
              try {
                const stat = await file.stat();
                if (stat.ino !== before.inode || stat.size !== before.offset) enqueue(name);
              } catch (error) {
                if (protectedFile(name)) throw error;
              } finally {
                await file.close();
              }
            }
          }
          for (const [name, cursor] of cursors)
            if (cursor.protected || (!scan && dirty.size < MAX_FILES)) enqueue(name);
          const pending = [...dirty].sort(
            (a, b) => Number(protectedFile(b)) - Number(protectedFile(a)),
          );
          dirty.clear();
          const again: string[] = [];
          for (const name of pending) {
            if (signal.aborted || Date.now() >= deadline()) return;
            if (workBytes >= MAX_BYTES) {
              enqueue(name);
              continue;
            }
            const file = await open(
              join(directory, name),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            ).catch((error: unknown) => {
              if (protectedFile(name)) throw error;
              cursors.delete(name);
              return undefined;
            });
            if (!file) continue;
            try {
              const stat = await file.stat();
              const before = baseline.get(name);
              let cursor =
                progress.get(name) ??
                cursorFor(name, before?.inode ?? stat.ino, before?.offset ?? 0);
              if (cursor.inode !== stat.ino || stat.size < cursor.offset) {
                if (cursor.protected)
                  throw new Error("Claude receipt transcript was replaced or truncated");
                cursor = cursorFor(name, stat.ino, 0);
              }
              track(name, cursor);
              const size = Math.min(CHUNK_BYTES, stat.size - cursor.offset);
              if (size === 0) continue;
              const buffer = Buffer.alloc(size);
              const start = cursor.offset;
              const { bytesRead } = await file.read(buffer, 0, size, start);
              if (signal.aborted) return;
              workBytes += bytesRead;
              cursor.offset += bytesRead;
              if (cursor.offset < stat.size) again.push(name);
              const data = buffer.subarray(0, bytesRead);
              if (cursor.protected) {
                if (protectedRows(cursor, data)) return;
              } else {
                for (const candidate of markerRows(cursor, data, start, markerBytes)) {
                  const row = Buffer.alloc(candidate.length);
                  const read = await file.read(row, 0, candidate.length, candidate.offset);
                  workBytes += read.bytesRead;
                  if (signal.aborted) return;
                  if (read.bytesRead !== candidate.length) continue;
                  const reducer = createClaudeReceiptReducer(marker);
                  const receipt = reducer.push(parseRow(row.toString("utf8")));
                  if (!receipt.accepted) continue;
                  cursor.protected = true;
                  cursor.reducer = reducer;
                  cursor.bytes = candidate.length;
                  cursor.tail = Buffer.alloc(0);
                  if (!reportedAcceptance) {
                    reportedAcceptance = true;
                    onAccepted();
                  }
                  const after = candidate.offset + candidate.length + 1 - start;
                  if (protectedRows(cursor, data.subarray(after))) return;
                  break;
                }
              }
            } catch (error) {
              if (protectedFile(name) || error instanceof ReceiptCapacityError) throw error;
              cursors.delete(name);
            } finally {
              await file.close();
            }
          }
          for (const name of again) enqueue(name);
          if (workBytes < MAX_BYTES && (scan || dirty.size > 0)) continue;
          workBytes = 0;
          if (!(await pause(signal))) return;
        }
      } finally {
        watcher?.close();
        await scan?.return(undefined);
      }
    },
  };
}
