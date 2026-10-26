import type { AttemptRecord } from "@agentswf/contract/records";
import { runProcess } from "@agentswf/harness";
import { ensureRunSession, runSessionName } from "./herdr-run-session";
import { readMarks } from "./herdr-workspace-marks";
import { probeProcess } from "./runs";

/**
 * Stops what a crashed attempt left working before a continue writes its turns' failed ends (Q17):
 * what is left of its process group, which a detached `awf run` leads, and its panes, by sweeping
 * its Herdr session, which closes the workspaces of runs whose process is gone. A run whose attempt
 * opened no pane starts no Herdr. A harness's own process runs in a session of its own, so one the
 * attempt orphaned isn't reached here; it is not stopped yet.
 */
export async function stopCrashed(
  previous: AttemptRecord,
  label: string,
  context: { home: string; environment: Readonly<Record<string, string | undefined>> },
): Promise<void> {
  // Only once its leader is gone for good: a live group's id is never handed out again, so a group
  // still there is the attempt's leftovers, never another process that took its pid since. One an
  // `awf run` typed in a terminal led is its pipeline's, which goes with it.
  if (probeProcess(previous.pid) === "gone") {
    try {
      process.kill(-previous.pid, "SIGTERM");
      await Bun.sleep(500);
      process.kill(-previous.pid, "SIGKILL");
    } catch {
      // No such group, or it ended at the first signal.
    }
  }
  const name = runSessionName(context.environment);
  const marks = await readMarks(context.home, name);
  if (!marks.some((mark) => mark.label === label)) return;
  await ensureRunSession(name, {
    run: runProcess,
    environment: context.environment,
    home: context.home,
  });
}
