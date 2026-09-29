import type { ExecutionConfig } from "@wf/contract/workflow";

/**
 * A runtime as a command line names one, `harness/model`, run headless. Claude run headless is
 * billed per token, which `metered` consents to.
 */
export function runtimeOf(spec: string): ExecutionConfig {
  const slash = spec.indexOf("/");
  if (slash < 1) throw new Error(`expected harness/model, got ${spec}`);
  const harness = spec.slice(0, slash);
  return {
    harness,
    model: spec.slice(slash + 1),
    placement: "headless",
    ...(harness === "claude" ? { metered: true as const } : {}),
  };
}

export function runtimeName(runtime: { harness: string; model: string }): string {
  return `${runtime.harness}/${runtime.model}`;
}
