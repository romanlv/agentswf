import type { PeerRef } from "./participants";
import type { Duration } from "./waits";

/** A route's limits, either shape. */
interface RouteLimits {
  /** Lowers the engine's ceiling of messages on this route an attempt, answers included. */
  maxMessages?: number;
  /**
   * A question on it closes unanswered after this long, to an agent or an outside participant.
   * Absent, it waits until answered, or its asker's turn ends; an agent's `--timeout` can only
   * shorten it.
   */
  timeout?: Duration;
}

/**
 * A route: `from` may message `to`, which answers over it when asked; `between` is both directions,
 * sharing one count. Its purpose is shown with every message on it.
 */
export type MessageAccess =
  | (RouteLimits & {
      from: PeerRef;
      to: PeerRef;
      between?: never;
      purpose: string;
    })
  | (RouteLimits & {
      between: readonly [PeerRef, PeerRef];
      from?: never;
      to?: never;
      purpose: string;
    });

export interface Messaging {
  /**
   * Grants routes in the current scope atomically: a stage's close when it ends, the rest with the
   * attempt. A pair has one open route at a time; granting it again must match, or it rejects.
   */
  allow(access: MessageAccess): Promise<void>;
}
