import type { PARTICIPANT } from "../participant";
import type { JsonObject } from "./json";

export type ParticipantKey = string;

/**
 * A participant the engine issued: an agent this workflow opened, or an outside participant it
 * connected. Only the engine makes one, so a workflow cannot name a participant it was not given.
 */
export interface ParticipantRef {
  /** Logical key in the workflow context that issued this reference. */
  readonly key: ParticipantKey;
  readonly [PARTICIPANT]: true;
}

export interface ExternalParticipantSpec {
  key: ParticipantKey;
  /** For whatever answers as it: passed along in `awf inbox`'s `route` items, never read by awf. */
  labels?: JsonObject;
}

export interface ExternalParticipantRef extends ParticipantRef {
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
  connect(spec: ExternalParticipantSpec): Promise<ExternalParticipantRef>;
  /** Finds an agent or connected participant visible in this workflow scope. */
  get(key: ParticipantKey): Promise<ParticipantRef | null>;
}
