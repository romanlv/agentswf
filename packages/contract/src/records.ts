import type { JsonSchema } from "./schema";

/** Bumped when a recorded shape changes in a way a reader cannot infer. */
export const RECORD_VERSION = 1;

/**
 * What the run directory records about one call. The agent is told none of this beyond its
 * call id, which arrives in its prompt; the CLI reads the rest from here, so a prompt
 * never carries a schema the agent could paraphrase back at us.
 *
 * This is the format only. The code that reads and writes it lives in the engine.
 */
export type CallSpec = {
  callId: string;
  question: string;
  schema?: JsonSchema;
};

/**
 * Which channel carried a candidate value. Production accepts one, `cli-callback`; E2's other
 * two are experiment vocabulary and widen this at their own boundary.
 */
export type AttemptSource = string;

/** Every candidate value, accepted or not. A rejection is evidence, so it is never dropped. */
export type Attempt = {
  at: string;
  source: AttemptSource;
  accepted: boolean;
  raw: string;
  error?: string;
};
