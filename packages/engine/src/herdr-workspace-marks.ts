import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { machinePaths } from "./machine";
import { type ProcessProbe, processStart, sameProcess } from "./runs";

export const WORKSPACE_MARK_VERSION = 2;

/**
 * A run's claim on its workspace in a shared Herdr session: the run's process, and when that
 * started, which tells a reused pid apart. Written before the workspace exists, so a session in
 * use is never taken for empty, and given the workspace's id once it does: only that id is ever
 * closed by it, as a label is unique only within its project's runs.
 */
export type WorkspaceMark = {
  /** 1 names only the workspace; an older awf reads only 1, and leaves a newer run's alone. */
  version: 1 | typeof WORKSPACE_MARK_VERSION;
  label: string;
  pid: number;
  processStart: string;
  workspaceId?: string;
  /**
   * Every pane the run made and has not closed, by the session it is in, its own workspace's
   * included: a pane closes by id and terminal id both, as Herdr's pane ids repeat.
   */
  panes?: Record<string, MarkedPane[]>;
  /** The run ended, leaving the panes it kept: this mark outlives it until they are gone. */
  ended?: true;
};

export type MarkedPane = { paneId: string; terminalId?: string; workspaceId: string; kept?: true };

export type Liveness = "live" | "dead" | "unknown";

export type HeldMark = {
  /** The workspace this run created. */
  bind(workspaceId: string): Promise<void>;
  /** Every pane the run has made in `session` and not closed. */
  panes(session: string, panes: readonly MarkedPane[]): Promise<void>;
  /** At the run's end: removed, or, where it kept panes, rewritten to name only those. */
  release(): Promise<void>;
};

export function marksDir(home: string, session: string): string {
  return join(machinePaths(home).herdr, "sessions", session, "workspaces");
}

/**
 * Marks the workspace labelled `label` as this process's, a file of its own. Best effort: a run
 * whose mark can't be written still runs, and its workspace reads as nobody's, which is kept.
 */
export async function markWorkspace(
  home: string,
  session: string,
  label: string,
  probe: ProcessProbe = processStart,
): Promise<HeldMark> {
  const unmarked: HeldMark = {
    bind: async () => undefined,
    panes: async () => undefined,
    release: async () => undefined,
  };
  const started = probe(process.pid);
  if (started === undefined) return unmarked;
  const dir = marksDir(home, session);
  const file = join(dir, `${process.pid}-${randomBytes(4).toString("hex")}.json`);
  const mark: WorkspaceMark = {
    version: WORKSPACE_MARK_VERSION,
    label,
    pid: process.pid,
    processStart: started,
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeWhole(file, mark);
  } catch {
    return unmarked;
  }
  let current = mark;
  // One write at a time, each of the mark as it is then: a later one never lands before an earlier.
  let writing = Promise.resolve();
  /** Once released, nothing writes it again: a late write would bring a removed mark back. */
  let released = false;
  const write = (next: WorkspaceMark) => {
    if (released) return writing;
    current = next;
    writing = writing.then(() => writeWhole(file, current).catch(() => undefined));
    return writing;
  };
  return {
    bind: (workspaceId) => write({ ...current, workspaceId }),
    panes: (session, panes) =>
      write({ ...current, panes: { ...current.panes, [session]: [...panes] } }),
    release: async () => {
      if (released) return writing;
      const kept = Object.fromEntries(
        Object.entries(current.panes ?? {})
          .map(([session, panes]) => [session, panes.filter((pane) => pane.kept)] as const)
          .filter(([, panes]) => panes.length > 0),
      );
      if (Object.keys(kept).length === 0) {
        released = true;
        await writing;
        return removeMark(file);
      }
      await write({ ...current, panes: kept, ended: true });
      released = true;
    },
  };
}

/** Renamed into place, so a reader never sees half a mark and skips a live run. */
async function writeWhole(file: string, mark: WorkspaceMark): Promise<void> {
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(mark));
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readMarks(
  home: string,
  session: string,
): Promise<(WorkspaceMark & { file: string })[]> {
  const dir = marksDir(home, session);
  const files = await readdir(dir).catch(() => [] as string[]);
  const marks: (WorkspaceMark & { file: string })[] = [];
  for (const name of files.filter((file) => file.endsWith(".json"))) {
    const file = join(dir, name);
    try {
      const mark = JSON.parse(await readFile(file, "utf8"));
      if (
        (mark?.version === 1 || mark?.version === WORKSPACE_MARK_VERSION) &&
        typeof mark.label === "string" &&
        typeof mark.pid === "number" &&
        typeof mark.processStart === "string" &&
        (mark.workspaceId === undefined || typeof mark.workspaceId === "string")
      ) {
        marks.push({ ...mark, file });
      }
    } catch {}
  }
  return marks;
}

/** Every session's marks, by the session whose directory holds them. */
export async function readAllMarks(
  home: string,
): Promise<(WorkspaceMark & { file: string; session: string })[]> {
  const sessions = await readdir(join(machinePaths(home).herdr, "sessions")).catch(
    () => [] as string[],
  );
  const all = await Promise.all(
    sessions.map(async (session) =>
      (await readMarks(home, session)).map((mark) => ({ ...mark, session })),
    ),
  );
  return all.flat();
}

/** Rewrites a mark read from `file`, as one sweep leaves it. */
export function rewriteMark(file: string, mark: WorkspaceMark): Promise<void> {
  return writeWhole(file, mark).catch(() => undefined);
}

export function removeMark(file: string): Promise<void> {
  return rm(file, { force: true }).catch(() => undefined);
}

/**
 * Dead only when its process is gone, or another holds its pid. One `ps` can't see, as from a
 * sandbox, is unknown: closing a live run's workspace loses its work.
 */
export function liveness(
  mark: Pick<WorkspaceMark, "pid" | "processStart">,
  probe: ProcessProbe = processStart,
  exists: (pid: number) => boolean = processExists,
): Liveness {
  if (!exists(mark.pid)) return "dead";
  if (probe(mark.pid) === undefined) return "unknown";
  return sameProcess(mark.pid, mark.processStart, probe) ? "live" : "dead";
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
