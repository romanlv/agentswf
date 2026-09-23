import type { JsonSchema } from "./schema";

/** What the run directory records about one call. The format only; the engine does the I/O. */
export type CallSpec = {
  callId: string;
  question: string;
  schema?: JsonSchema;
};

/**
 * Which channel carried a candidate value — `control-plane` in production. A string, because the
 * archived experiments name channels of their own and the format should not enumerate them.
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
