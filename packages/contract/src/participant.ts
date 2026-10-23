import type { ParticipantKey, ParticipantRef } from "./workflow/participants";

/**
 * What makes a `ParticipantRef` one the engine issued. Exported only through
 * `@agentswf/contract/participant`, which a workflow cannot import, so a `{ key }` literal does not
 * type-check as a ref.
 */
export const PARTICIPANT: unique symbol = Symbol("agentswf.participant");

/**
 * Keys `connect`, `agents.open` and a call's `participants` map refuse: an agent could read a
 * message from one as authority. Engine-side, not the author surface; the docs name them.
 */
export const RESERVED_PARTICIPANT_KEYS = ["operator", "awf", "system", "user"] as const;

/** A ref for a participant the engine opened. */
export function participantRef<K extends ParticipantKey>(
  key: K,
): ParticipantRef & { readonly key: K } {
  return { key, [PARTICIPANT]: true };
}
