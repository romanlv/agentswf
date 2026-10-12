import type { ParticipantRef } from "./participants";

/**
 * A route: `from` may message `to`, which answers over it when asked; `between` is both directions,
 * sharing one count. Its purpose is shown with every message on it.
 */
export type MessageAccess =
  | {
      from: ParticipantRef;
      to: ParticipantRef;
      between?: never;
      purpose: string;
      /** Lowers the engine's ceiling of messages on this route an attempt, answers included. */
      maxMessages?: number;
    }
  | {
      between: readonly [ParticipantRef, ParticipantRef];
      from?: never;
      to?: never;
      purpose: string;
      /** Lowers the engine's ceiling of messages on this route an attempt, answers included. */
      maxMessages?: number;
    };

export interface Messaging {
  /**
   * Grants routes in the current scope atomically: a stage's close when it ends, the rest with the
   * attempt. A pair has one open route at a time; granting it again must match, or it rejects.
   */
  allow(access: MessageAccess): Promise<void>;
}
