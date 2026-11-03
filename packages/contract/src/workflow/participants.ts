import type { PARTICIPANT } from "../participant";
import type { ParticipantReply, ParticipantReplyOf } from "./events";
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

// First, so a `to: "code"` spec held in a variable, which no excess-property check sets apart,
// still gets the ref it got before.
export interface ParticipantDirectory {
  /**
   * @deprecated Declare `{key}:reply: ParticipantReply` in `events` and drop `to: "code"`; take
   * its messages as `e.name === "{key}:reply"`, or race `wf.signal("{key}:reply")`.
   */
  connect(spec: CodeParticipantSpec): Promise<CodeParticipantRef>;
}

/** @deprecated Declare `{key}:reply: ParticipantReply` in `events`, and connect it without `to`. */
export interface CodeParticipantSpec extends ParticipantSpec {
  /**
   * Its messages come to the run's code, each a `participant:reply` from its key taken at a wait,
   * not to an agent.
   *
   * @deprecated Declare `{key}:reply: ParticipantReply` in `events` instead.
   */
  to: "code";
}

/**
 * A participant routed to the code: a source of its replies, one per wait.
 *
 * @deprecated A `ParticipantRef`: race `wf.signal("{key}:reply")`, declared in `events`.
 */
export interface CodeParticipantRef extends ParticipantRef, Source<Taken<ParticipantReply>> {
  /**
   * True for a message on this participant.
   *
   * @deprecated Read `e.name === "{key}:reply"`, declared in `events`.
   */
  is<E extends EventLike = EventLike>(event: E): event is E & ParticipantReplyOf<E>;
}

/** @deprecated Use `ParticipantDirectory`: every participant is connected by it. */
export type CodeParticipantDirectory = ParticipantDirectory;
