import { assertLiveOptIn, interruption, report } from "./live";
import { gather, problems } from "./run-sandbox";

/**
 * `awf run --sandbox`, live, under docker: `run-sandbox` with the workspace's and every run's
 * sandbox a container of the default image. docker's daemon must answer. 3 agents, ~1½ min, ~$0.15
 * at list prices.
 */
if (import.meta.main) {
  assertLiveOptIn();
  const { evidence, estimate, artifacts } = await gather("docker", interruption());
  report(problems(evidence), { estimateUsd: estimate, artifacts });
}
