import type { PARTICIPANT } from "../participant";
import type { JsonObject } from "./json";

export type PeerKey = string;

/**
 * A peer the engine issued: an agent this workflow opened, or a participant outside the run it
 * connected. Only the engine makes one, so a workflow cannot name a peer it was not given.
 */
export interface PeerRef {
  /** Logical key in the workflow context that issued this reference. */
  readonly key: PeerKey;
  readonly [PARTICIPANT]: true;
}

export interface ParticipantSpec {
  key: PeerKey;
  /** For whatever answers as it: passed along in `awf inbox`'s `route` items, never read by awf. */
  labels?: JsonObject;
}

export interface ParticipantRef extends PeerRef {
  /** Writes to it without a turn: an item in `awf inbox` for whatever answers as it. */
  post(text: string): Promise<void>;
  /**
   * Closes its routes and ends every question open to it, `released`. `false` when it was
   * released already.
   */
  release(reason?: string): Promise<boolean>;
}

export interface ParticipantDirectory {
  /**
   * Connects a participant outside the run, such as a coordinator, read with `awf inbox` and
   * answered with `awf reply` and `awf send`. Its messages go to the agents it has routes with;
   * to the run's code only when the workflow declares `{key}:reply: ParticipantReply` in
   * `events`, each sent by `awf emit {ref} {key}:reply '{"text":…}' --event-id {message id}`. It
   * waits for no one. A reserved key, or one any agent or participant holds anywhere in the run,
   * rejects. It stays connected until released, or until the workflow has returned and no
   * question to it is open.
   */
  connect(spec: ParticipantSpec): Promise<ParticipantRef>;
}
