import type { AgentKey, TurnId, TurnOutcome } from "./agents";
import type { JsonValue, OutputSchema } from "./json";
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

/** `Events` with every name holding a colon made `never`: those are awf's, so `tsc` refuses them. */
export type NoColonNames<Events extends EventSchemas> = {
  [Name in keyof Events]: Name extends `${string}:${string}` ? never : Events[Name];
};

/** The value a schema accepts. */
export type OutputOf<S> = S extends OutputSchema<infer T> ? T : JsonValue;

/**
 * Names one occurrence for good within its run, by the grammar of `nameProblem`. Ids starting
 * `awf.` are awf's own, for an end or an event sent without an id, and a sender's are refused.
 */
export type EventId = string;

/** The prefix of the ids awf makes, which no sender may use. */
export const AWF_ID_PREFIX = "awf.";

/** What a run's wait returns: one event from its mailbox. */
export type WorkflowEvent<Name extends string = string, Data = JsonValue> = {
  readonly id: EventId;
  readonly name: Name;
  readonly data: Data;
  /**
   * Who it is from: the agent's or participant's key for awf's events, the timer's name for
   * `timer:due`, the sending run's ref (`{workflow}/{id}`) for `workflow.emit`, `operator` for
   * `awf emit`.
   */
  readonly from: string;
  /** When it was appended, an ISO time; for `timer:due`, when the timer was due. */
  readonly at: string;
};

/** A turn started with `agent.start()` ended: its outcome and the `meta` it was started with. */
export type AgentEnded<Meta extends JsonValue = JsonValue, T extends JsonValue = JsonValue> = {
  turn: TurnId;
  meta: Meta;
  outcome: TurnOutcome<T>;
};

/** A message on a participant routed to the code; its event's id is the message's own id. */
export type ParticipantReply = {
  text: string;
  /** Who wrote it, as the participant's host names them; absent when it doesn't. */
  author?: string;
};

/**
 * Type-only: marks an event as the one agent or participant whose guard matched it. Without it, a
 * guard's false branch would rule out every agent's end or every participant's reply, so a second
 * agent's `ended(e)` after the first's could never be true.
 */
declare const MATCHED: unique symbol;
export type Matched = { readonly [MATCHED]: true };

/** awf's own events, a closed set: the key of the agent or participant is in `from`. */
export type AgentEndedEvent<
  Meta extends JsonValue = JsonValue,
  T extends JsonValue = JsonValue,
> = WorkflowEvent<"agent:ended", AgentEnded<Meta, T>> & { readonly from: AgentKey };
export type ParticipantReplyEvent = WorkflowEvent<"participant:reply", ParticipantReply> & {
  readonly from: PeerKey;
};

/** One of a workflow's own events, narrowed by `name`. */
export type OwnEvent<Events extends EventSchemas> = {
  [Name in keyof Events & string]: WorkflowEvent<Name, OutputOf<Events[Name]>>;
}[keyof Events & string];

/** One of a workflow's own events of one name. */
export type OwnEventOf<Events extends EventSchemas, Name extends keyof Events & string> = WorkflowEvent<
  Name,
  OutputOf<Events[Name]>
>;

/** Any event a run of a workflow with `events` takes at its wait. */
export type ReceivedEvent<Events extends EventSchemas> =
  | OwnEvent<Events>
  | AgentEndedEvent
  | ParticipantReplyEvent
  | TimerDueEvent;

export type ReceiveOptions = {
  /** What `awf runs` shows while the run waits here or is parked at this wait. */
  label?: string;
  /** `all`, the default: every event not yet acknowledged; `oldest`: the first of them alone. */
  take?: "all" | "oldest";
};

export type EmitOptions = {
  /**
   * The event's id, as `awf emit --event-id` gives it: a repeat is a duplicate. Absent, awf makes
   * one, and nothing deduplicates it.
   */
  eventId?: EventId;
};

/**
 * What became of an event: `accepted`, appended to its run's mailbox; `duplicate`, its id is there
 * already; `refused`, its run has returned, or it has none and the event doesn't start one. What
 * awf then did to the run is its own concern.
 */
export type EmitOutcome = "accepted" | "duplicate" | "refused";
