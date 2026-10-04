export type Harness = "claude" | "codex" | "pi" | "cursor";

/**
 * A per-harness table's entry for a harness that lacks what the table holds, with why: every
 * harness takes a position in every such table, as in `HarnessSpec.absent`.
 */
export type Absent = { readonly absent: string };

export function isAbsent(entry: unknown): entry is Absent {
  return typeof entry === "object" && entry !== null && "absent" in entry && !Array.isArray(entry);
}

/**
 * What a wait reports. `unknown` is kept distinct rather than folded into `done`: a reading
 * that proves nothing must not read as a turn that completed.
 */
export type SettledState = "idle" | "done" | "blocked" | "unknown";
