import type { AttemptRecord } from "@agentswf/contract/records";

/**
 * Why a run takes no attempt now: one of its attempts is still live, or it completed and no stage
 * of it is being redone. Undefined when it takes one. `stages` are those it has records of.
 */
export function refusal(
  id: string,
  attempts: readonly AttemptRecord[],
  options: {
    /** `--from-stage`, which a completed run takes. */
    fromStage: boolean;
    stages: readonly string[];
    live: (attempt: AttemptRecord) => boolean;
  },
): string | undefined {
  const live = attempts.find((attempt) => options.live(attempt));
  if (live) return `attempt ${live.n} of ${id} is still running, as process ${live.pid}`;
  if (attempts.at(-1)?.outcome !== "completed" || options.fromStage) return undefined;
  return options.stages.length > 0
    ? `${id} completed; to redo from a stage, --from-stage one of: ${options.stages.join(", ")}`
    : `${id} completed; there is nothing to continue`;
}
