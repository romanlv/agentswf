import { join } from "node:path";
import type { RunRecord } from "@agentswf/contract/records";

/**
 * What awf keeps per machine, under `~/.awf`, whatever a run's root: the marks of sessions runs
 * drive, each sandbox's homes, kept outside the project, whose run root a provider denies, and the
 * Herdr sessions it runs agents in: their config, and each run's mark on its workspace.
 */
export function machinePaths(home: string): {
  root: string;
  callers: string;
  sandboxes: string;
  herdr: string;
} {
  const root = join(home, ".awf");
  return {
    root,
    callers: join(root, "callers"),
    sandboxes: join(root, "sandboxes"),
    herdr: join(root, "herdr"),
  };
}

/** Where a run's sandboxes keep their homes: found by the run, though outside it. */
export function sandboxesDirOf(home: string, run: Pick<RunRecord, "workflow" | "id">): string {
  return join(machinePaths(home).sandboxes, run.workflow, run.id);
}
