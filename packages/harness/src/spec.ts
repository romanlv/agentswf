import type { AgentPlacement } from "@agentswf/contract/workflow";
import { STARTUP_BLOCKS } from "./adapters/herdr-startup";
import { claude } from "./harnesses/claude";
import { codex } from "./harnesses/codex";
import { cursor } from "./harnesses/cursor";
import type { Capability, DefinedHarness, HarnessSpec } from "./harnesses/define";
import { pi } from "./harnesses/pi";
import { type Harness, isAbsent } from "./types";

export type {
  Absences,
  BillingContext,
  Capability,
  CompactionPlan,
  DefinedHarness,
  ForkPlan,
  HarnessSpec,
  TurnContext,
  TurnPlan,
} from "./harnesses/define";
export { defineHarness } from "./harnesses/define";

/**
 * Every harness, one file each under `harnesses/`; what else a harness needs, and the compiler
 * cannot see, is in `docs/adding-a-harness.md`. The flags are the ones E1 drove and E2 re-drove
 * live.
 */
export const HARNESSES: Record<Harness, DefinedHarness> = { claude, codex, pi, cursor };

export function harnessSpec(harness: Harness): HarnessSpec {
  return HARNESSES[harness];
}

/** For a caller holding only a harness name, which may be one this table does not know. */
export function findHarness(harness: string): HarnessSpec | undefined {
  return Object.hasOwn(HARNESSES, harness) ? HARNESSES[harness as Harness] : undefined;
}

export const HARNESS_NAMES = Object.keys(HARNESSES) as [Harness, ...Harness[]];

/**
 * The harnesses each placement's run host runs: a pane, those whose startup screens are driven; a
 * headless turn, any harness in the table.
 */
export const PLACEMENT_HARNESSES = {
  pane: HARNESS_NAMES.filter((harness) => !isAbsent(STARTUP_BLOCKS[harness])) as [
    Harness,
    ...Harness[],
  ],
  headless: HARNESS_NAMES,
} satisfies Record<AgentPlacement, readonly [Harness, ...Harness[]]>;

/** Why `harness` lacks `capability`, for a refusal to say. */
export function absence(harness: Harness, capability: Capability): string {
  return HARNESSES[harness].absent[capability] ?? `${harness} has no ${capability}`;
}

export function knownHarness(value: string): Harness {
  if (findHarness(value)) return value as Harness;
  throw new Error(`unsupported harness: ${value}`);
}
