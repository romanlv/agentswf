import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type RunLine, type RunView, readRun } from "@agentswf/contract/records";
import { isCode, syncDir } from "./files";
import { unendedTurns } from "./run-policy/waits";
import { RunUnreachable } from "./run-unreachable";
import { crashedEnd } from "./turn-ends";

/** `run.jsonl`, what the run settled; resolved, as it keys the append queue. */
export function runLinesFile(runDir: string): string {
  return resolve(runDir, "run.jsonl");
}

/** Appends one attempt's lines to `run.jsonl`, in call order, each whole and synced. */
export type RunLines = {
  readonly attempt: number;
  append(line: RunLine): Promise<void>;
};

const queues = new Map<string, Promise<void>>();

/** Attempt `attempt`'s writer: made only by its claim, so nothing appends before the fence. */
function runLines(runDir: string, attempt: number): RunLines {
  const path = runLinesFile(runDir);
  return {
    attempt,
    append(line) {
      if (line.attempt !== attempt) {
        return Promise.reject(
          new Error(`attempt ${attempt} cannot append a line of attempt ${line.attempt}`),
        );
      }
      return queued(path, () => appendSynced(path, `${JSON.stringify(line)}\n`));
    },
  };
}

/**
 * The claim on `run.jsonl`: cuts a line a crash left torn, so it never merges with the next, then
 * appends `claimed`, the fence after which a line of an earlier attempt is ignored, then ends each
 * turn an earlier attempt began and never ended, failed, before any wait can look. Called once the
 * previous attempt's process is gone.
 */
export async function claimRunLines(
  runDir: string,
  attempt: number,
  at: string,
): Promise<RunLines> {
  const path = runLinesFile(runDir);
  await queued(path, () => cutTorn(path));
  // `run.jsonl` may be new here: its entry in the folder is made durable with the claim.
  await syncDir(runDir);
  const lines = runLines(runDir, attempt);
  await lines.append({ kind: "claimed", attempt, at });
  for (const turn of unendedTurns((await readRunLines(runDir)).lines))
    await lines.append(crashedEnd(turn, attempt, at));
  return lines;
}

/**
 * `run.jsonl`'s complete lines, checked, and their reading. Text after the last newline is a line
 * still being written or one a crash tore, which the next claim cuts: it is not read.
 */
export async function readRunLines(runDir: string): Promise<{ lines: RunLine[]; view: RunView }> {
  const path = runLinesFile(runDir);
  const text = await readFile(path, "utf8").catch((error) => {
    if (isCode(error, "ENOENT")) return "";
    throw error;
  });
  const complete = text.slice(0, text.lastIndexOf("\n") + 1).split("\n");
  complete.pop();
  const parsed = complete.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new RunUnreachable(`run.jsonl line ${index + 1}: not JSON`);
    }
  });
  let view: RunView;
  try {
    view = readRun(parsed);
  } catch (error) {
    // A line of no kind this awf knows: the run's record can't be read, as a line not JSON.
    throw new RunUnreachable(error instanceof Error ? error.message : String(error));
  }
  return { lines: parsed as RunLine[], view };
}

async function queued(path: string, work: () => Promise<void>): Promise<void> {
  const current = (queues.get(path) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(path, current);
  try {
    await current;
  } finally {
    if (queues.get(path) === current) queues.delete(path);
  }
}

/**
 * One `O_APPEND` write, then fsync; Bun's fsync on macOS is not `F_FULLFSYNC` (story 041, Q5). A
 * write that fails part way is cut, so the next line isn't glued to its half.
 */
async function appendSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    const { size } = await handle.stat();
    const bytes = new TextEncoder().encode(text);
    let written = 0;
    try {
      while (written < bytes.byteLength) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.byteLength - written);
        if (bytesWritten === 0) throw new Error("append made no progress");
        written += bytesWritten;
      }
    } catch (error) {
      // Only when the file ends with this write's bytes: a stale writer never cuts another's line.
      const now = await handle.stat().catch(() => undefined);
      if (written > 0 && now?.size === size + written) {
        await handle.truncate(size).catch(() => undefined);
      }
      throw error;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Truncates `path` to its last newline, creating it when absent. */
async function cutTorn(path: string): Promise<void> {
  const handle = await open(path, "a+", 0o600);
  try {
    const { size } = await handle.stat();
    const end = await afterLastNewline(handle, size);
    if (end < size) {
      await handle.truncate(end);
      await handle.sync();
    }
  } finally {
    await handle.close();
  }
}

type Reader = {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{
    bytesRead: number;
  }>;
};

/** The offset just past the last newline before `size`, read backwards; 0 when there is none. */
async function afterLastNewline(handle: Reader, size: number): Promise<number> {
  const chunk = new Uint8Array(64 * 1024);
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.byteLength);
    const length = end - start;
    const { bytesRead } = await handle.read(chunk, 0, length, start);
    if (bytesRead !== length) throw new Error("run.jsonl changed while it was claimed");
    const newline = chunk.subarray(0, length).lastIndexOf(10);
    if (newline !== -1) return start + newline + 1;
    end = start;
  }
  return 0;
}
