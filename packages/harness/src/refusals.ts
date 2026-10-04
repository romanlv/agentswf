import { type AgentExecution, placementOf } from "@agentswf/contract/workflow";
import type { HarnessActivation } from "./adapter";
import { sandboxable } from "./sandbox-needs";
import { absence, findHarness, harnessSpec, knownHarness } from "./spec";
import type { Harness } from "./types";

/**
 * Why a headless host refuses this agent, or undefined. The headless adapter and the scripted host
 * a workflow's test runs on both ask here, so a test refuses what a run would.
 */
export function headlessRefusal(request: HarnessActivation): string | undefined {
  const harness = knownHarness(request.execution.harness);
  if (harnessSpec(harness).meteredHeadless && request.execution.metered !== true) {
    return `headless ${harness} is billed per token even on a subscription login; set metered: true to run it`;
  }
  if (request.occupant && !sandboxable(harness)) return `${harness} cannot run in a sandbox`;
  return undefined;
}

/**
 * Why `harness` refuses `effort`, or undefined: one its definition does not list, quoting those it
 * does. A harness this table does not know is its host's to refuse.
 */
export function effortRefusal(harness: string, effort: unknown): string | undefined {
  const spec = findHarness(harness);
  if (!spec) return undefined;
  if (!spec.effort) return `${harness} takes no effort: ${absence(harness as Harness, "effort")}`;
  if (typeof effort === "string" && spec.effort.includes(effort)) return undefined;
  return `${harness} has no effort ${JSON.stringify(effort)}; its levels are ${spec.effort.join(", ")}`;
}

/**
 * Why this agent cannot switch its model or effort mid-session, or undefined. Every host and the
 * scripted host a workflow's test runs on ask here, so a test refuses what a run would.
 */
export function settingsRefusal(execution: AgentExecution): string | undefined {
  const spec = findHarness(execution.harness);
  if (!spec) return undefined;
  const placement = placementOf(execution);
  const capability = placement === "pane" ? "setPane" : "setHeadless";
  if (spec[capability]) return undefined;
  return `${execution.harness} ${placement} agents cannot switch model or effort: ${absence(execution.harness as Harness, capability)}`;
}
