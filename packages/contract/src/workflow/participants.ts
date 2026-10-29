import type { PARTICIPANT } from "../participant";
import type { Matched, ParticipantReply, ParticipantReplyEvent } from "./events";
import type { JsonObject } from "./json";
import type { EventLike, Source, Taken } from "./waits";

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
  /**
   * Closes its routes and ends every question open to it, `released`. `false` when it was
   * released already.
   */
  release(reason?: string): Promise<boolean>;
}

export interface ParticipantDirectory {
  /**
   * Connects a participant outside the run, such as a coordinator, read with `awf inbox` and
   * answered with `awf reply` and `awf send`. It waits for no one. A reserved key, or one any agent or
   * participant holds anywhere in the run, rejects. It stays connected until released, or until the workflow has returned and no question
   * to it is open.
   */
  connect(spec: ParticipantSpec): Promise<ParticipantRef>;
  /** Finds an agent or connected participant visible in this workflow scope. */
  get(key: PeerKey): Promise<PeerRef | null>;
}

export interface CodeParticipantSpec extends ParticipantSpec {
  /**
   * Its messages come to the run's code, each a `participant:reply` from its key taken at a wait,
   * not to an agent: `awf send {ref} --as {key} --event-id {message id} {text}` delivers one, and continues
   * a parked run.
   */
  to: "code";
}

/** A participant routed to the code: a source of its replies, one per wait. */
export interface CodeParticipantRef extends ParticipantRef, Source<Taken<ParticipantReply>> {
  /** Writes to it without a turn: an item in `awf inbox` for whatever answers as it. */
  post(text: string): Promise<void>;
  /** True for a message on this participant. */
  is(event: EventLike): event is ParticipantReplyEvent & Matched;
}

/**
 * The directory of a run of a workflow with `events`, which also connects participants routed to
 * the code. A parked run keeps them connected.
 */
export interface CodeParticipantDirectory extends ParticipantDirectory {
  connect(spec: CodeParticipantSpec): Promise<CodeParticipantRef>;
  connect(spec: ParticipantSpec): Promise<ParticipantRef>;
}
