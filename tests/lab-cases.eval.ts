import { gather, problems } from "./lab-cases";
import { assertLiveOptIn, loadFromDotEnv, report } from "./live";

/**
 * A tool handler calling a mocked module, live (story 044): awf-lab runs one case whose agent
 * calls a workflow tool; the handler must get the case's fake, never the real module. One claude
 * haiku agent in srt, headless and metered, from `CLAUDE_CODE_OAUTH_TOKEN` in `.env`; srt must be
 * installed. ~10 s, ~$0.002.
 */
if (import.meta.main) {
  assertLiveOptIn();
  await loadFromDotEnv("CLAUDE_CODE_OAUTH_TOKEN");
  const evidence = await gather();
  report(problems(evidence), {
    facts: evidence.trial?.facts,
    estimateUsd: evidence.trial?.estimate,
    store: evidence.store,
    ...(problems(evidence).length > 0 ? { labOutput: evidence.out } : {}),
  });
}
