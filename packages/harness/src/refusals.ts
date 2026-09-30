import type { HarnessActivation } from "./adapter";
import { sandboxable } from "./sandbox-needs";
import { harnessSpec, knownHarness } from "./spec";

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
