import type { JsonObject } from "./json";

export type ParticipantKey = string;

export interface ParticipantRef {
  /** Logical key in the workflow context that issued this reference. */
  readonly key: ParticipantKey;
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
