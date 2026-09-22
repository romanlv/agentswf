/**
 * Everything the archived experiments pull from the packages, in one place.
 *
 * The experiments are frozen: they are evidence, and rewriting their imports every time a
 * package moves would be editing evidence. This file absorbs that instead, and it is also the
 * boundary — it imports public package entrypoints only, so nothing here reaches into a
 * package's internals.
 */
export * from "@wf/contract";
export * from "@wf/harness";
export * from "@wf/harness/testing";
export * from "@wf/engine";
// Its own entrypoint, not the barrel: `acceptResult` writes `result.json` with no slot behind it,
// which is right for E2/E5 and wrong anywhere near a live run.
export * from "@wf/engine/archive-compat";
export { tempRunDir } from "@wf/engine/testing";
export { COUNT_SCHEMA } from "@wf/contract/testing";
export * from "./run-log";

/** The three ways E2 had a terminal agent hand a value back. Production settles through one. */
export type ReturnMethod = "cli-callback" | "write-a-file" | "delimited-line";

/** Compatibility names for frozen experiments; production uses the session-driver vocabulary. */
export type { AgentSessionDriver as AgentSessionBackend } from "@wf/harness";

import { harnessSpec as currentHarnessSpec, type Harness as HarnessName } from "@wf/harness";

const HERDR_KINDS: Record<HarnessName, string> = {
  claude: "claude",
  codex: "codex",
  pi: "pi",
  cursor: "cursor",
};

/** Preserve the Herdr-specific table shape that E3 was originally run against. */
export function harnessSpec(harness: HarnessName) {
  const spec = currentHarnessSpec(harness);
  return {
    ...spec,
    herdrKind: HERDR_KINDS[harness],
    paneArgs: (model?: string) => spec.interactive(model).argv.slice(1),
  };
}
