import type { PARTICIPANT } from "../participant";
import type { JsonObject } from "./json";

export type ParticipantKey = string;

/**
 * A participant the engine issued: an agent this workflow opened, or later a connected outside
 * session. Only the engine makes one, so a workflow cannot name a participant it was not given.
 */
export interface ParticipantRef {
  /** Logical key in the workflow context that issued this reference. */
  readonly key: ParticipantKey;
  readonly [PARTICIPANT]: true;
}

export interface ExternalParticipantSpec {
  key: ParticipantKey;
  /** Defaults to the workflow's discoverable session binding. */
  bindingPath?: string;
  labels?: JsonObject;
}

export interface ExternalParticipantRef extends ParticipantRef {
  /** Stops routing and fails outstanding response obligations involving this participant. */
  release(reason?: string): Promise<boolean>;
}

export interface ParticipantDirectory {
  /** Connects a session the engine did not start; an occupied participant key rejects. */
  connect(spec: ExternalParticipantSpec): Promise<ExternalParticipantRef>;
  /** Finds an agent or connected participant visible in this workflow scope. */
  get(key: ParticipantKey): Promise<ParticipantRef | null>;
}
