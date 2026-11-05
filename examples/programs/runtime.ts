import type { ExecutionConfig } from "agentswf/workflow";

/** One cheap headless model, so a run of the example costs a cent or two. */
export const RUNTIME = {
  harness: "codex",
  model: "gpt-6-luna",
  placement: "headless",
} as const satisfies ExecutionConfig;
