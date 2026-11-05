// The Client API reference's samples: emit's and start's results, a run's waits, and ClientError.
import { type Client, ClientError } from "agentswf/client";
import review from "../guide/programs/pr-review";
import release from "../guide/programs/release";

// #region emit
export async function pushed(runs: Client, pr: number, sha: string) {
  const sent = await runs.emit(
    review,
    `pr-${pr}`,
    "pr.pushed",
    { sha, branch: "main" },
    { eventId: `push-${sha}`, source: "ci" },
  );
  if (!sent.ok) throw new Error(`${sent.ref}: ${sent.outcome}, ${sent.why ?? sent.did}`);
  return sent.did; // "started" | "nudged" | "continued" | "none"
}
// #endregion emit

// #region start
export async function notes(runs: Client, version: string) {
  const started = await runs.start(release, { version, dryRun: true }, { id: `v${version}` });
  if (!started.ok) throw new Error(`${started.did}: ${started.error ?? ""}`);
  const rest = await started.run.wait({
    final: true,
    signal: AbortSignal.timeout(30 * 60_000),
  });
  return rest.ending?.kind === "completed" ? rest.ending.value : undefined;
}
// #endregion start

// #region errors
export async function closeIfThere(runs: Client, pr: number) {
  try {
    return await runs.emit(review, `pr-${pr}`, "thread:reply", {
      text: "closing",
      author: "bot",
    });
  } catch (error) {
    if (error instanceof ClientError && error.code === "no-run") return undefined;
    throw error;
  }
}
// #endregion errors
