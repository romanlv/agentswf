import type { JsonSchema } from "@wf/contract/schema";
import type { TurnUsage } from "./spec";

export type Harness = "claude" | "codex" | "pi" | "cursor";

export type BackendKind = "pane" | "headless";

export type Step = {
  prompt: string;
  harness: Harness;
  model?: string;
  backend?: BackendKind;
  schema?: JsonSchema;
  cwd?: string;
};

/**
 * What a wait reports. `unknown` is kept distinct rather than folded into `done`, for the
 * reason `review-loop/liveness.ts` gives: a reading that proves nothing must not read as
 * a turn that completed.
 */
export type SettledState = "idle" | "done" | "blocked" | "unknown";

/**
 * Which call a session is serving. These are identifiers, not credentials — anything holding
 * them can name the call, which is why the engine must not treat them as proof of the right
 * to settle it. Production uses `HarnessOperationBinding`; this remains for frozen experiments.
 */
export type CallIdentity = { runDir: string; callId: string };

/**
 * One agent, alive across more than one turn. The nudge needs that: the whole point is that
 * the agent still holds the task in context when the follow-up arrives.
 */
export type TurnOutcome = {
  state: SettledState;
  /** Why the state is what it is, when the backend knows. Diagnostic only. */
  detail?: string;
  /** What the turn cost, where the harness says. Absent is not zero. */
  usage?: TurnUsage;
  /** The harness's own id for the conversation, for finding a transcript afterwards. */
  sessionRef?: string;
};

export type AgentSession = {
  prompt(text: string): Promise<TurnOutcome>;
  /** Null when nothing could be read. A pane read is best-effort: E2 recovered short values
   * from the live screen, but output that scrolled off the alternate screen is gone. */
  transcript(): Promise<string | null>;
  close(): Promise<void>;
};

/** Legacy seam retained for frozen experiments. Production uses `AgentSessionAdapter`. */
export type AgentSessionDriver = {
  /** The mode callers request. The concrete provider remains an implementation detail. */
  kind: BackendKind;
  open(step: Step, call: CallIdentity): Promise<AgentSession>;
};
