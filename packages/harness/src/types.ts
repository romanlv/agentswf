export type Harness = "claude" | "codex" | "pi" | "cursor";

/**
 * What a wait reports. `unknown` is kept distinct rather than folded into `done`: a reading
 * that proves nothing must not read as a turn that completed.
 */
export type SettledState = "idle" | "done" | "blocked" | "unknown";
