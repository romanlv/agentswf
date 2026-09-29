import { realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Where a variant or scorer came from: its file's repository at HEAD, or null outside git.
 * Provenance only: the version the file declares is its identity.
 */
export async function provenanceOf(file: string): Promise<{ commit: string | null }> {
  const run = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: dirname(realpathSync(file)),
    stdout: "pipe",
    stderr: "ignore",
  });
  const commit = run.exitCode === 0 ? run.stdout.toString().trim() : "";
  return { commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null };
}
