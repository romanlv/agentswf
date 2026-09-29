import { assertLiveOptIn, interruption } from "./live";
import { gather, problems } from "./run-sandbox";

/**
 * `awf run --sandbox`, live, under docker: `run-sandbox` with the workspace's and every run's
 * sandbox a container of the default image. docker's daemon must answer. 3 agents, ~1½ min, ~$0.15
 * at list prices.
 */
if (import.meta.main) {
  assertLiveOptIn();
  const { evidence, estimate, artifacts } = await gather("docker", interruption());
  const failed = problems(evidence);
  console.log(
    JSON.stringify({ ok: failed.length === 0, failed, estimateUsd: estimate, artifacts }, null, 2),
  );
  if (failed.length > 0) process.exitCode = 1;
}
