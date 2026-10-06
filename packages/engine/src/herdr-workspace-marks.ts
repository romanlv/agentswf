import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { machinePaths } from "./machine";
import { type ProcessProbe, processStart, sameProcess } from "./runs";

export const WORKSPACE_MARK_VERSION = 1;

/**
 * A run's claim on its workspace in a shared Herdr session: the run's process, and when that
 * started, which tells a reused pid apart. Written before the workspace exists, so a session in
 * use is never taken for empty, and given the workspace's id once it does: only that id is ever
 * closed by it, as a label is unique only within its project's runs.
 */
export type WorkspaceMark = {
  version: typeof WORKSPACE_MARK_VERSION;
  label: string;
  pid: number;
  processStart: string;
  workspaceId?: string;
};

export type Liveness = "live" | "dead" | "unknown";

export type HeldMark = {
  /** The workspace this run created. */
  bind(workspaceId: string): Promise<void>;
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
  const unmarked: HeldMark = { bind: async () => undefined, release: async () => undefined };
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
  return {
    bind: (workspaceId) => writeWhole(file, { ...mark, workspaceId }).catch(() => undefined),
    release: () => removeMark(file),
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
        mark?.version === WORKSPACE_MARK_VERSION &&
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
