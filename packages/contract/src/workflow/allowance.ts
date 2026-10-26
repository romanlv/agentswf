import type { HarnessKind } from "./agents";

/**
 * One harness's plan, or why it has none to read: no reader, no login, a login that is billed per
 * token, or a read that failed. A `none` is unknown, not room to spare.
 */
export type HarnessAllowance =
  | {
      harness: HarnessKind;
      read: "plan";
      /** What was read: `claude /usage`, `codex account/rateLimits/read`, `cursor /usage`. */
      source: string;
      /** The plan's name, as the harness words it: `max`, `prolite`, `Team`. */
      plan?: string;
      /** Its tier within the plan, where the harness tells one apart: `default_claude_max_20x`. */
      tier?: string;
      windows: AllowanceWindow[];
    }
  | { harness: HarnessKind; read: "none"; reason: string };

/** A limit of the plan's, over a window that resets. Nothing the harness did not show is filled in. */
export type AllowanceWindow = {
  /** Named from the harness's wording, unique within it: `session`, `week`, `included`. */
  id: string;
  /** As the harness words it. */
  label: string;
  usedPercent: number;
  /** When it resets, ISO 8601 in UTC; as precise as the harness shows it. */
  resetsAt?: string;
  /** The models it alone limits, as the harness names them; absent, it limits every model. */
  models?: string[];
};
