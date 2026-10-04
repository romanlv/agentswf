import type { ExecutionConfig } from "@agentswf/contract/workflow";

/**
 * Every harness's level names, as each harness definition's `effort` lists them: the lab may not
 * import the harness package. awf refuses a level the harness lacks before anything runs.
 */
export const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/**
 * A runtime as a command line names one, `harness/model` or `harness/model:{effort}`, run
 * headless. The part after the last `:` is an effort only when it names a level: a pi model may end
 * in `:free`. Claude run headless is billed per token, which `metered` consents to.
 */
export function runtimeOf(spec: string): ExecutionConfig {
  const slash = spec.indexOf("/");
  if (slash < 1) throw new Error(`expected harness/model, got ${spec}`);
  const harness = spec.slice(0, slash);
  const target = spec.slice(slash + 1);
  const colon = target.lastIndexOf(":");
  const level = colon < 0 ? undefined : target.slice(colon + 1);
  const effort = level !== undefined && LEVELS.has(level) ? level : undefined;
  const model = effort === undefined ? target : target.slice(0, colon);
  if (!model) throw new Error(`expected harness/model, got ${spec}`);
  return {
    harness,
    model,
    ...(effort === undefined ? {} : { effort }),
    placement: "headless",
    ...(harness === "claude" ? { metered: true as const } : {}),
  };
}

/** As `runtimeOf` reads it: a runtime with no effort is named as it always was. */
export function runtimeName(runtime: { harness: string; model: string; effort?: string }): string {
  return `${runtime.harness}/${runtime.model}${runtime.effort ? `:${runtime.effort}` : ""}`;
}
