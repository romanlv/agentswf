import type { AgentKey, TurnId, TurnOutcome } from "./agents";
import type { JsonObject, JsonValue, OutputSchema } from "./json";
import type { PeerKey } from "./participants";
import type { TimerDueEvent } from "./waits";

/**
 * Keys, event ids and stage names: lowercase, since each becomes a file name on a disk that may not
 * tell case apart, and one grammar, so a stage named by an event id is always valid.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._@-]*$/;
const NAME_MAX_LENGTH = 128;

/** Why an event id or stage name doesn't fit the grammar; absent when it does. */
export function nameProblem(name: string): string | undefined {
  if (!NAME_PATTERN.test(name))
    return "lowercase letters, digits, `.`, `_`, `@` and `-`, starting with a letter or digit";
  if (name.length > NAME_MAX_LENGTH) return `at most ${NAME_MAX_LENGTH} characters`;
  return undefined;
}

/** A workflow's own events, by name, each the schema of its `data`; a name has no colon. */
export type EventSchemas = Readonly<Record<string, OutputSchema<JsonValue>>>;

/**
 * `Events` as a workflow may declare them: its own names, without a colon, each with its schema;
 * and awf's, `{key}:reply` with `ParticipantReply` and `{key}:ended` with `AgentEnded`, the key
 * without a colon. Any other name with a colon, or an awf name with another schema, is `never`, so
 * `tsc` refuses it.
 */
export type DeclaredEvents<Events extends EventSchemas> = {
  [Name in keyof Events]: Name extends `${infer Key}:${infer Kind}`
    ? Key extends ""
      ? never
      : Kind extends "reply"
        ? ParticipantReplySchema
        : Kind extends "ended"
          ? AgentEndedSchema
          : never
    : Events[Name];
};

/** The names a workflow declares that are its own: without a colon. */
export type OwnNames<Events extends EventSchemas> = Exclude<
  keyof Events & string,
  `${string}:${string}`
>;

/** awf's name `name` is: `{key}:reply` or `{key}:ended`, split at its one colon. */
export function awfEventOf(name: string): { key: string; kind: "reply" | "ended" } | undefined {
  const colon = name.indexOf(":");
  if (colon <= 0 || name.includes(":", colon + 1)) return undefined;
  const kind = name.slice(colon + 1);
  if (kind !== "reply" && kind !== "ended") return undefined;
  return { key: name.slice(0, colon), kind };
}

/** The value a schema accepts; under awf's two, what awf sends. */
export type OutputOf<S> = S extends ParticipantReplySchema
  ? ParticipantReply
  : S extends AgentEndedSchema
    ? AgentEnded
    : S extends OutputSchema<infer T>
      ? T
      : JsonValue;

/**
 * Names one occurrence for good within its run, by the grammar of `nameProblem`. Ids starting
 * `awf.` are awf's own, for an end or an event sent without an id, and a sender's are refused.
 */
export type EventId = string;

/** The prefix of the ids awf makes, which no sender may use. */
export const AWF_ID_PREFIX = "awf.";

/** A workflow's declared `events`; `never` for a workflow without them. */
export type EventsOf<W> = W extends { readonly events: infer Events extends EventSchemas }
  ? Events
  : never;

/**
 * The data event `Name` of workflow `W` carries: a `{key}:reply`'s is `ParticipantReply`, whatever
 * schema copy the workflow declares it with; any other's is what its schema accepts.
 */
export type EventData<W, Name> = Name extends `${string}:reply`
  ? ParticipantReply
  : Name extends keyof EventsOf<W>
    ? OutputOf<EventsOf<W>[Name]>
    : never;

/** What a run's wait returns: one of the events it can take. */
export type WorkflowEvent<Name extends string = string, Data = JsonValue> = {
  readonly id: EventId;
  readonly name: Name;
  readonly data: Data;
  /**
   * Who it is from: the agent's or participant's key for awf's events, the timer's name for
   * `timer:due`, the sending run's ref (`{workflow}/{id}`) for `wf.emit`, `operator` for
   * `awf emit`.
   */
  readonly from: string;
  /**
   * The integration that sent it, as `awf emit --source` or a program's client named it, such as
   * `github`; absent for every other event.
   */
  readonly source?: string;
  /** When it was appended, an ISO time; for `timer:due`, when the timer was due. */
  readonly at: string;
};

/** A turn started with `agent.start()` ended: its outcome and the `meta` it was started with. */
export type AgentEnded<Meta extends JsonValue = JsonValue, T extends JsonValue = JsonValue> = {
  turn: TurnId;
  meta: Meta;
  outcome: TurnOutcome<T>;
};

/** A message on a participant, to the code; its event's id is the message's own id. */
export type ParticipantReply = {
  text: string;
  /** Who wrote it, as the participant's host names them; absent when it doesn't. */
  author?: string;
};

/**
 * awf's two schemas are known by their `$id`, which stays the same across versions, so a workflow
 * whose installed `agentswf` differs from the awf loading it still declares them. awf checks the
 * data against its own copy, never the workflow's.
 */
export const PARTICIPANT_REPLY_ID = "agentswf:ParticipantReply";
export const AGENT_ENDED_ID = "agentswf:AgentEnded";
export type ParticipantReplySchema = JsonObject & { readonly $id: typeof PARTICIPANT_REPLY_ID };
export type AgentEndedSchema = JsonObject & { readonly $id: typeof AGENT_ENDED_ID };

/**
 * The schema of `{key}:reply`, a message on participant `key` to the code, which a workflow
 * declares to have its messages: `events: { "thread:reply": ParticipantReply }`.
 */
export const ParticipantReply = {
  $id: PARTICIPANT_REPLY_ID,
  type: "object",
  properties: { text: { type: "string" }, author: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
} as unknown as ParticipantReplySchema;

/**
 * The schema of `{key}:ended`, the end of a turn agent `key` began with `start()`, which a workflow
 * declares to start one: `events: { "investigator:ended": AgentEnded }`. Only awf sends one.
 */
export const AgentEnded = {
  $id: AGENT_ENDED_ID,
  type: "object",
  properties: {
    turn: { type: "string" },
    outcome: {
      type: "object",
      properties: { kind: { type: "string" }, answered: { type: "boolean" } },
      required: ["kind", "answered"],
    },
  },
  required: ["turn", "meta", "outcome"],
} as unknown as AgentEndedSchema;

/**
 * Type-only: marks an event as the one agent or participant whose guard matched it. Without it, a
 * guard's false branch would rule out every agent's end or every participant's reply, so a second
 * agent's `ended(e)` after the first's could never be true.
 */
declare const MATCHED: unique symbol;
export type Matched = { readonly [MATCHED]: true };

/**
 * An agent's turn's end where the workflow doesn't declare its `{key}:ended`, the agent's key in
 * `from`. A declared end is one of the workflow's own events.
 *
 * @deprecated Declare `{key}:ended: AgentEnded` in `events`, and read `e.name === "{key}:ended"`.
 */
export type AgentEndedEvent<
  Meta extends JsonValue = JsonValue,
  T extends JsonValue = JsonValue,
> = WorkflowEvent<"agent:ended", AgentEnded<Meta, T>> & { readonly from: AgentKey };

/** Whether an event of type `E` may be any name: one read loosely, not one of a run's events. */
type Loose<E> = string extends (E extends { readonly name: infer N } ? N : string) ? true : false;

/**
 * What `agent.is(e)` narrows `e` to, intersected with its type. One of a run's events narrows to
 * the agent's end under either name, a declared `{key}:ended` or `agent:ended`; one typed loosely,
 * or given explicit type arguments, to `AgentEndedEvent` as before.
 */
export type AgentEndOf<E, Meta extends JsonValue, T extends JsonValue> = (Loose<E> extends true
  ? AgentEndedEvent<Meta, T>
  : {
      readonly name: "agent:ended" | `${string}:ended`;
      readonly data: AgentEnded<Meta, T>;
      readonly from: AgentKey;
    }) &
  Matched;

/** As `AgentEndOf`, for a participant's message: a declared `{key}:reply` or `participant:reply`. */
export type ParticipantReplyOf<E> = (Loose<E> extends true
  ? ParticipantReplyEvent
  : {
      readonly name: "participant:reply" | `${string}:reply`;
      readonly data: ParticipantReply;
      readonly from: PeerKey;
    }) &
  Matched;
/**
 * A message on a participant connected with the deprecated `to: "code"` and no `{key}:reply`
 * declared, its key in `from`.
 *
 * @deprecated Declare `{key}:reply: ParticipantReply` in `events`, and read `e.name === "{key}:reply"`.
 */
export type ParticipantReplyEvent = WorkflowEvent<"participant:reply", ParticipantReply> & {
  readonly from: PeerKey;
};

/**
 * A workflow without events, `{}`: it declares no name, so `signal` takes none. Not `never`, under
 * which every name would count as declared.
 */
export type NoEvents = Record<never, never>;

/** One of a workflow's own events, narrowed by `name`. */
export type OwnEvent<Events extends EventSchemas> = {
  [Name in keyof Events & string]: WorkflowEvent<Name, OutputOf<Events[Name]>>;
}[keyof Events & string];

/** One of a workflow's own events of one name. */
export type OwnEventOf<
  Events extends EventSchemas,
  Name extends keyof Events & string,
> = WorkflowEvent<Name, OutputOf<Events[Name]>>;

/** Any event a run's wait takes: its own, an agent's end, a participant's reply, a timer's. */
export type ReceivedEvent<Events extends EventSchemas> =
  | OwnEvent<Events>
  | AgentEndedEvent
  | ParticipantReplyEvent
  | TimerDueEvent;

export type EmitOptions = {
  /**
   * The event's id, as `awf emit --event-id` gives it: a repeat is a duplicate. Absent, awf makes
   * one, and nothing deduplicates it.
   */
  eventId?: EventId;
};

/**
 * What became of an event: `accepted`, appended to its run's `in.jsonl`; `duplicate`, its id is there
 * already; `refused`, its run has returned, or it has none and the event doesn't start one. What
 * awf then did to the run is its own concern.
 */
export type EmitOutcome = "accepted" | "duplicate" | "refused";
