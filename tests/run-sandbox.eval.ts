import { assertLiveOptIn, interruption } from "./live";
import { gather, problems } from "./run-sandbox";

/**
 * `awf run --sandbox`, live (story 010): awf-lab's probe trial on a synthetic case, and quick-check,
 * a workflow opening its own sandbox and a spec that can't open, each under a run sandbox. srt must
 * be installed. 3 agents, ~1 min, ~$0.05–0.17 at list prices; the prober runs on codex gpt-5.6-sol.
 */
if (import.meta.main) {
  assertLiveOptIn();
  const { evidence, estimate, artifacts } = await gather("srt", interruption());
  const failed = problems(evidence);
  console.log(
    JSON.stringify({ ok: failed.length === 0, failed, estimateUsd: estimate, artifacts }, null, 2),
  );
  if (failed.length > 0) process.exitCode = 1;
}
