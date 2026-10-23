import { join } from "node:path";
import type { RunRecord } from "@agentswf/contract/records";

/**
 * What awf keeps per machine, under `~/.awf`, whatever a run's root: the marks of sessions runs
 * drive, each sandbox's homes, kept outside the project, whose run root a provider denies, and the
 * Herdr sessions it runs agents in: their config, and each run's mark on its workspace; and the
 * sockets holders reach live runs' coordinators through.
 */
export function machinePaths(home: string): {
  root: string;
  callers: string;
  sandboxes: string;
  herdr: string;
  coordinator: string;
} {
  const root = join(home, ".awf");
  return {
    root,
    callers: join(root, "callers"),
    sandboxes: join(root, "sandboxes"),
    herdr: join(root, "herdr"),
    coordinator: join(root, "coordinator"),
  };
}

/** Where a run's sandboxes keep their homes: found by the run, though outside it. */
export function sandboxesDirOf(home: string, run: Pick<RunRecord, "workflow" | "id">): string {
  return join(machinePaths(home).sandboxes, run.workflow, run.id);
}

/** Where live runs' coordinator sockets are: `AWF_COORDINATOR_DIR`, or `~/.awf/coordinator`. */
export function coordinatorDir(
  home: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return environment.AWF_COORDINATOR_DIR || machinePaths(home).coordinator;
}
