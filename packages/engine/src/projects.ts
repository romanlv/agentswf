import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appendLine } from "./jsonl";
import { withKeyLock } from "./key-lock";

/**
 * The project a workflow with `events` runs in: the nearest directory at or above its file that
 * holds `.awf/`, or else the file's own directory. Every sender names the file, so every sender,
 * wherever it runs, finds the same runs (Q15). `{home}/.awf` is awf's own, not a project's.
 */
export async function projectOf(file: string, home: string): Promise<string> {
  // The real path, so a sender naming the file through a link finds the same runs.
  const start = real(dirname(resolve(file)));
  const ownHome = real(home);
  if (start === ownHome)
    throw new Error(
      `${file} is directly in home, where awf keeps its own .awf: move it into a directory`,
    );
  for (let dir = start; ; dir = dirname(dir)) {
    if (dir === ownHome) return start;
    const found = await stat(join(dir, ".awf")).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (found) return dir;
    if (dirname(dir) === dir) return start;
  }
}

function real(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** Where a project's runs are kept. */
export function projectRunRoot(project: string): string {
  return join(project, ".awf", "runs");
}

/** `~/.awf/projects`: each project awf has started a keyed run in, one absolute path a line. */
export function projectsFile(home: string): string {
  return join(home, ".awf", "projects");
}

/** The projects awf has started a keyed run in, each once, in the order first started. */
export async function listProjects(home: string): Promise<string[]> {
  const text = await Bun.file(projectsFile(home))
    .text()
    .catch(() => "");
  return [...new Set(text.split("\n").filter((line) => line.startsWith("/")))];
}

/** Adds `project` to `~/.awf/projects`, once. */
export async function recordProject(home: string, project: string): Promise<void> {
  const file = projectsFile(home);
  if ((await listProjects(home)).includes(project)) return;
  await withKeyLock(`${file}.lock`, async () => {
    if ((await listProjects(home)).includes(project)) return;
    await appendLine(file, project);
  });
}
