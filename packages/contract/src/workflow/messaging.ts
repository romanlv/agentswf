import type { ParticipantRef } from "./participants";

export type MessageAccess =
  | {
      from: ParticipantRef;
      to: ParticipantRef;
      between?: never;
      purpose: string;
    }
  | {
      between: readonly [ParticipantRef, ParticipantRef];
      from?: never;
      to?: never;
      purpose: string;
    };

export interface Messaging {
  /** Grants routes in the current workflow scope atomically; conflicting purposes reject. */
  allow(access: MessageAccess): Promise<void>;
}
