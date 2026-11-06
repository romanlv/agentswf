import type {
  ParticipantCode,
  ReplyCode,
  SendCode,
  ToolCode,
  ToolFailure,
} from "@agentswf/contract/wire";
import type {
  Duration,
  Effort,
  JsonObject,
  JsonValue,
  OperationCause,
  OutputSchema,
} from "@agentswf/contract/workflow";
import type Type from "typebox";
import { canonical } from "../canonical-json";
import type { Deprecated } from "../deprecations";
import { messageOf } from "../errors";

/** One turn of a scripted agent, as the workflow wrote it. */
export type Turn = {
  /** The agent's key. */
  agent: string;
  /** 1-based in the agent's session. A nudge, or a delivery continuing the turn, shares its number. */
  n: number;
  nudge: boolean;
  prompt: string;
  /** Absent for a turn that asks for text. */
  schema?: OutputSchema;
  label?: string;
  /** The workflow stage it runs in; absent between stages. */
  stage?: string;
  cwd: string;
  /** The model the agent ran this turn at: as opened, then as its last `set` left it. */
  model: string;
  /** Its effort, likewise; absent, the harness's default. */
  effort?: Effort;
  /** Who woke the operation: absent for the workflow's own `run`. */
  cause?: OperationCause;
  /**
   * The messages the agent was shown in this turn, in order; one delivered while the script awaits
   * a reply is added, the reply included.
   */
  readonly messages: readonly Message[];
  /**
   * `wfa send`: resolves once admitted, `sent`; or, with `awaitReply`, with the reply, which arrives
   * in a later turn of the same call. Returning a result without awaiting it drops the wait, and it
   * resolves `failed` with reason `dropped`. While a reply is awaited the script awaits only the
   * host's calls: once it is still, its turn ends.
   */
  send(peer: string, text: string, options?: SendOptions): Promise<MessageOutcome>;
  /** `wfa reply`: answers the question `peer` asked. A result is refused while one is owed. */
  reply(peer: string, text: string, options?: SendOptions): Promise<MessageOutcome>;
  /**
   * `wfa tool`: calls the agent's tool `name` with `input` as its JSON, or none, through the run's
   * real checks and handler; resolves with what the agent would read.
   */
  tool(name: string, input?: JsonObject): Promise<ToolOutcome>;
  /** Fires when the engine cancels the turn. */
  signal: AbortSignal;
};

/**
 * How a tool call ended, as `wfa tool` reports it; a failure or a refusal is a value to test. A
 * refusal carries what the agent is told, which for `invalid-input` is what it corrects from.
 */
export type ToolOutcome =
  | { kind: "result"; output?: string }
  | { kind: "failed"; outcome: ToolFailure; error: string }
  | { kind: "refused"; code: ToolCode; error: string };

/** A message as the agent was shown it. */
export type Message = {
  from: string;
  text: string;
  /** A question: the agent owes `from` a reply. */
  asks?: true;
  /** The reply to a question this agent asked. */
  answers?: true;
};

export type SendOptions = {
  awaitReply?: boolean;
  /** How long an awaited reply is waited for, as `wfa send --timeout` gives it. */
  timeout?: Duration;
  /** @deprecated Give `timeout`, a `Duration` such as `"30s"`. */
  timeoutMs?: number;
};

/** How a send or reply ended; a refusal is a value to test, not a throw. */
export type MessageOutcome =
  | { kind: "sent" }
  | { kind: "replied"; text: string }
  | { kind: "failed"; reason: string }
  | { kind: "refused"; code: SendCode | ReplyCode };

/**
 * A message that woke the agent, and what its script may do in that turn: `reply` and `send` as
 * the turn's own. Returning nothing ends the turn without a reply, and one owed is reminded once,
 * then fails; returning `noAnswer.failed(reason)` fails it as a failed harness does.
 */
export type ReceivedMessage = Message & {
  /** The turn it woke: whether it is a reminder (`nudge`), and every message shown in it. */
  turn: Turn;
  reply(text: string, options?: SendOptions): Promise<MessageOutcome>;
  send(peer: string, text: string, options?: SendOptions): Promise<MessageOutcome>;
  tool(name: string, input?: JsonObject): Promise<ToolOutcome>;
  /** @deprecated Return nothing, which ends the turn without a reply. */
  silent(): NoAnswer;
  /** @deprecated Return `noAnswer.failed(reason)`. */
  fail(reason?: string): NoAnswer;
};

/**
 * A message operation's script: called with the message that woke the agent, and again with the
 * next one when held messages continue the operation, or with the same one, `turn.nudge` set, when
 * it is reminded of a reply it owes. A `noAnswer` it returns ends the turn as that says; nothing,
 * or what a `reply` or `send` resolved to, ends it without a reply. A throw fails the test.
 */
export type MessageScript = (
  message: ReceivedMessage,
  // biome-ignore lint/suspicious/noConfusingVoidType: an async script that returns nothing is Promise<void>.
) => void | NoAnswer | MessageOutcome | Promise<void | NoAnswer | MessageOutcome>;

/**
 * How a participant's script's `reply` or `send` ended: delivered, a reply's `id` the question's
 * and a send's the new message's, or refused with the `code` `awf reply --json` would print.
 */
export type ParticipantOutcome = { code: "delivered"; id: string } | { code: ParticipantCode };

/**
 * A message an agent sent a participant, and what the participant's script may do about it, as
 * whoever answers for it would with `awf reply` and `awf send`. An answer is recorded as coming through `test`.
 */
export type ParticipantMessage = {
  kind: "message";
  /** `{attempt}.{n}`, as `awf inbox` prints it. */
  id: string;
  /** The agent's peer address. */
  from: string;
  text: string;
  /** A question: it stays open until the script answers it, or it expires. */
  asks?: true;
  /** Answers this question, as `awf reply --to` does. */
  reply(text: string): Promise<ParticipantOutcome>;
  /** Messages an agent over a route the workflow allowed, as `awf send` does. */
  send(agent: string, text: string): Promise<ParticipantOutcome>;
};

/** A route to or from a participant, as it opens: where a script that speaks first starts. */
export type ParticipantRoute = {
  kind: "route";
  /** The agent's peer address. */
  agent: string;
  direction: "both" | "to-participant" | "from-participant";
  purpose: string;
  /** Messages the agent, as `awf send` does. */
  send(text: string): Promise<ParticipantOutcome>;
};

/**
 * A participant's script: called with each route to it as it opens, and each message an agent sends
 * it, once recorded; the `awf inbox` items whoever answers for it would act on. What it returns is awaited and
 * otherwise ignored: a question it does not answer stays open, and a throw fails the test.
 */
export type ParticipantScript = (event: ParticipantRoute | ParticipantMessage) => unknown;

const ENTRY: unique symbol = Symbol("agentswf.script-entry");

type Respond = (turn: Turn) => JsonValue | NoAnswer | Promise<JsonValue | NoAnswer>;

/** An answer to a turn that asks for its schema, or for text. Made by `answer`. */
export type Answer = {
  readonly [ENTRY]: { kind: "answer"; schema: OutputSchema | undefined; respond: Respond };
};

type Ending =
  | { kind: "waiting"; reason: string; timeoutMs?: number }
  | { kind: "silent" }
  | { kind: "blocked" | "failed" | "timed-out"; reason: string }
  | { kind: "needs-login"; provider?: string }
  | { kind: "hang" }
  | { kind: "interrupted" };

/** A turn ended without an answer. Made by `noAnswer`. */
export type NoAnswer = {
  readonly [ENTRY]: { kind: "no-answer"; ending: Ending; deprecated?: Deprecated };
};

/** Every turn the agent is asked, alike; or a list, one entry per turn in order. */
export type Script = Answer | NoAnswer | readonly (Answer | NoAnswer)[];

/** What a schema's answer is: the carrier the author surface types with, else TypeBox's `Static`. */
export type AnswerOf<S> = S extends { readonly "~output"?: infer O }
  ? unknown extends O
    ? StaticOf<S>
    : Exclude<O, undefined>
  : StaticOf<S>;
type StaticOf<S> = S extends Type.TSchema ? Type.Static<S> : JsonValue;

type Answering<A> = A | ((turn: Turn) => A | NoAnswer | Promise<A | NoAnswer>);

/**
 * An answer to a turn that asks for `schema`: a value of its type, or a function of the turn that
 * returns one or a `noAnswer`. A function that returns no answer is asked again for the nudge, with
 * `turn.nudge` set.
 */
export function answer<const S extends OutputSchema>(
  schema: S,
  value: NoInfer<Answering<AnswerOf<S>>>,
): Answer;
/** An answer to a turn that asks for no schema: text, or a function of the turn. */
export function answer(text: Answering<string>): Answer;
export function answer(...args: [unknown] | [unknown, unknown]): Answer {
  const [schema, given] = args.length === 1 ? [undefined, args[0]] : args;
  const respond: Respond =
    typeof given === "function" ? (given as Respond) : () => given as JsonValue;
  return { [ENTRY]: { kind: "answer", schema: schema as OutputSchema | undefined, respond } };
}

const ending = (value: Ending, deprecated?: Deprecated): NoAnswer => ({
  [ENTRY]: {
    kind: "no-answer",
    ending: value,
    ...(deprecated === undefined ? {} : { deprecated }),
  },
});

/** Ends a turn without an answer, so it takes no schema. */
export const noAnswer = {
  /** Ends without a result; recovery follows the placement's production support. */
  silent: (): NoAnswer => ending({ kind: "silent" }),
  /** The agent is stuck, as on a permission prompt. */
  blocked: (reason = "waiting on a permission prompt"): NoAnswer =>
    ending({ kind: "blocked", reason }),
  /** The harness failed. */
  failed: (reason = "harness crashed"): NoAnswer => ending({ kind: "failed", reason }),
  /**
   * The agent's harness cannot sign in, as with an expired login: the turn fails with `login` set,
   * naming the agent's harness, `provider` where it logs in to several, and what to run.
   */
  needsLogin: (provider?: string): NoAnswer =>
    ending({ kind: "needs-login", ...(provider === undefined ? {} : { provider }) }),
  /** The harness reported the turn timed out; it ends at once. */
  timedOut: (reason = "turn timed out"): NoAnswer => ending({ kind: "timed-out", reason }),
  /** Holds the turn until the engine cancels it. */
  hang: (): NoAnswer => ending({ kind: "hang" }),
  /**
   * The operator stopped the turn in their pane, as only the calling session's can be: it settles
   * `cancelled`, is never nudged, and the session takes the next turn.
   */
  interrupted: (): NoAnswer => ending({ kind: "interrupted" }),
};

/** What `make` ends a turn with, marked as made through a deprecated name for the run to log. */
export function deprecatedAs<A extends unknown[]>(
  name: Deprecated,
  make: (...args: A) => NoAnswer,
): (...args: A) => NoAnswer {
  return (...args) => ending(make(...args)[ENTRY].ending, name);
}

/** @deprecated Use `noAnswer`, the same calls: a reply answers, these end a turn without one. */
export const reply: typeof noAnswer = {
  silent: deprecatedAs("test-reply", noAnswer.silent),
  blocked: deprecatedAs("test-reply", noAnswer.blocked),
  failed: deprecatedAs("test-reply", noAnswer.failed),
  needsLogin: deprecatedAs("test-reply", noAnswer.needsLogin),
  timedOut: deprecatedAs("test-reply", noAnswer.timedOut),
  hang: deprecatedAs("test-reply", noAnswer.hang),
  interrupted: deprecatedAs("test-reply", noAnswer.interrupted),
};

/**
 * Reports a cooperative wait, `wfa waiting`; later check-ins invoke the same answer function again.
 * Only the engine's own tests use it: whether an agent may wait is its harness's, not a workflow's.
 */
export const waiting = (reason: string, timeoutMs?: number): NoAnswer =>
  ending({ kind: "waiting", reason, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

/**
 * How a turn ended, as `run.turns` keeps it: the engine's word, but for `waiting`, a check-in, and
 * `awaiting-reply`, a script awaiting a reply, which a later turn of the same call resumes it with.
 */
export type TestTurnOutcome =
  | "answered"
  | "unanswered"
  | "blocked"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "waiting"
  | "awaiting-reply";

/**
 * A turn's outcome until the engine's record replaces it: what a turn before its operation's last,
 * a nudged one, keeps.
 */
export function outcomeOf(kind: Exclude<Ending["kind"], "waiting">): TestTurnOutcome {
  if (kind === "silent") return "unanswered";
  if (kind === "needs-login") return "failed";
  if (kind === "hang" || kind === "interrupted") return "cancelled";
  return kind;
}

export type Step =
  | { kind: "answer"; value: JsonValue }
  | { kind: "no-answer"; ending: Ending; deprecated?: Deprecated }
  /** The script cannot meet this turn: the test's mistake, not the workflow's. */
  | { kind: "script-error"; message: string };

/**
 * Each agent's entries by key or pattern: one for every use, or a list walked in order, one per
 * use, that ends the test if run past. An exact key wins over a pattern; two patterns matching one
 * key is the test's mistake.
 */
class Lists<E> {
  readonly #lists: Readonly<Record<string, E | readonly E[]>>;
  /** The furthest use each agent reached, by the key or pattern that met it. */
  readonly #reached = new Map<string, { pattern: string; n: number }>();
  readonly #of: Of;

  constructor(
    lists: Readonly<Record<string, E | readonly E[]>>,
    of: Of,
    valid: (entry: unknown) => boolean,
  ) {
    this.#of = of;
    for (const [key, list] of Object.entries(lists)) {
      if (Array.isArray(list) && list.length === 0) {
        throw new TypeError(
          `${of.option}["${key}"] is an empty list; a list has an entry per ${of.noun}`,
        );
      }
      for (const entry of Array.isArray(list) ? list : [list]) {
        if (!valid(entry)) {
          throw new TypeError(
            `${of.option}["${key}"] must be ${of.expected} or a list of them, not ${describe(entry)}`,
          );
        }
      }
    }
    this.#lists = lists;
  }

  /** Whether any entry, by key or pattern, is for this agent. */
  has(agent: string): boolean {
    return !("why" in findByKey(this.#lists, agent, "agent"));
  }

  /** The agent's entry for its `n`th use, or why there is none. */
  protected entry(agent: string, n: number): { entry: E } | { why: string } {
    const found = findByKey(this.#lists, agent, "agent");
    if ("why" in found) return found;
    const { pattern, value: list } = found;
    const entry = isList(list) ? list[n - 1] : list;
    if (entry === undefined) {
      return {
        why: `its ${this.#of.whose}${named(pattern, agent)} has ${count(list, this.#of.noun)}`,
      };
    }
    const reached = this.#reached.get(agent);
    this.#reached.set(agent, { pattern, n: Math.max(reached?.n ?? 0, n) });
    return { entry };
  }

  /** What a list scripted and no use reached. */
  leftovers(): string[] {
    const { noun, whose } = this.#of;
    const problems: string[] = [];
    for (const [key, { pattern, n }] of this.#reached) {
      const list = this.#lists[pattern]!;
      if (isList(list) && n < list.length) {
        problems.push(
          `agent "${key}" was asked ${count(n, noun)}; its ${whose}${named(pattern, key)} has ${list.length}`,
        );
      }
    }
    const met = new Set([...this.#reached.values()].map(({ pattern }) => pattern));
    for (const [pattern, list] of Object.entries(this.#lists)) {
      if (isList(list) && !met.has(pattern)) {
        const who = pattern.includes("*")
          ? `no agent matching "${pattern}" was asked`
          : `agent "${pattern}" was never asked`;
        problems.push(`${who}; its ${whose} has ${count(list, noun)}`);
      }
    }
    return problems;
  }
}

/** What a list's entries are for, as its messages name them. */
type Of = { noun: string; option: string; whose: string; expected: string };

/** Each agent's turn scripts, or its compactions'. */
export class Scripts extends Lists<Answer | NoAnswer> {
  readonly #noun: string;

  constructor(
    scripts: Readonly<Record<string, Script>> = {},
    of: { noun: "turn" | "compaction"; option: string } = { noun: "turn", option: "agents" },
  ) {
    super(
      scripts,
      {
        ...of,
        whose: of.noun === "turn" ? "script" : `${of.noun} script`,
        expected: "answer(…), noAnswer.…()",
      },
      isEntry,
    );
    this.#noun = of.noun;
  }

  /** `index` is the turn's place among the workflow's turns of this agent, not the session's. */
  async step(turn: Turn, index = turn.n): Promise<Step> {
    const found = this.entry(turn.agent, index);
    if ("why" in found) return this.error(turn, found.why);
    const meant = found.entry[ENTRY];
    if (meant.kind === "no-answer") return { ...meant };
    if (!sameSchema(meant.schema, turn.schema)) {
      return this.error(
        turn,
        `it asks for ${describeSchema(turn.schema)}; its script answers ${describeSchema(meant.schema)}`,
      );
    }
    let out: JsonValue | NoAnswer | undefined;
    try {
      out = await meant.respond(turn);
    } catch (error) {
      return this.error(turn, `its script threw: ${messageOf(error)}`);
    }
    if (out === undefined) return this.error(turn, "its script returned nothing");
    if (isEntry(out)) {
      const given = out[ENTRY];
      if (given.kind === "no-answer") return { ...given };
      return this.error(turn, "its script returned answer(…); a function returns the value itself");
    }
    return { kind: "answer", value: out };
  }

  private error(turn: Turn, why: string): Step {
    return {
      kind: "script-error",
      message: `agent "${turn.agent}" ${this.#noun} ${turn.n}${turn.nudge ? " (nudge)" : ""}: ${why}. It was asked: ${firstLine(turn.prompt)}`,
    };
  }
}

/** Each agent's message scripts: one for all its message operations, or a list, one per operation. */
export class MessageScripts extends Lists<MessageScript> {
  constructor(scripts: Readonly<Record<string, MessageScript | readonly MessageScript[]>> = {}) {
    super(
      scripts,
      {
        noun: "message operation",
        option: "messages",
        whose: "message script",
        expected: "a function of the message",
      },
      (entry) => typeof entry === "function",
    );
  }

  /**
   * Runs the script for the agent's `index`th message operation with `message`: what it returns
   * ends the turn silent unless it is a `noAnswer`.
   */
  async step(message: ReceivedMessage, index: number): Promise<Step> {
    const { turn } = message;
    const where = `agent "${turn.agent}" turn ${turn.n}${turn.nudge ? " (reminder)" : ""}, woken by ${message.from}`;
    const found = this.entry(turn.agent, index);
    if ("why" in found) {
      return {
        kind: "script-error",
        message: `${where}: ${found.why === "no agent is scripted" ? "no agent has a message script" : found.why}`,
      };
    }
    let out: unknown;
    try {
      out = await found.entry(message);
    } catch (error) {
      return {
        kind: "script-error",
        message: `${where}: its message script threw: ${messageOf(error)}`,
      };
    }
    if (isEntry(out)) {
      const given = out[ENTRY];
      if (given.kind === "no-answer") return { ...given };
      return {
        kind: "script-error",
        message: `${where}: a message script ends a turn, it answers no call`,
      };
    }
    return { kind: "no-answer", ending: { kind: "silent" } };
  }
}

/** A script by key: the exact key, else the one pattern that matches it. */
export function findByKey<T>(
  scripts: Readonly<Record<string, T>>,
  key: string,
  what: "agent" | "decision",
): { pattern: string; value: T } | { why: string } {
  if (Object.hasOwn(scripts, key)) return { pattern: key, value: scripts[key]! };
  const matching = Object.keys(scripts).filter(
    (pattern) => pattern.includes("*") && globMatches(pattern, key),
  );
  if (matching.length === 1) return { pattern: matching[0]!, value: scripts[matching[0]!]! };
  const scripted = Object.keys(scripts);
  return {
    why:
      matching.length > 1
        ? `it matches ${matching.map(quote).join(" and ")}; give it a script of its own`
        : scripted.length === 0
          ? `no ${what} is scripted`
          : `no script for it; scripted: ${scripted.map(quote).join(", ")}`,
  };
}

function isEntry(value: unknown): value is Answer | NoAnswer {
  return typeof value === "object" && value !== null && ENTRY in value;
}

function isList<E>(list: E | readonly E[]): list is readonly E[] {
  return Array.isArray(list);
}

function named(pattern: string, key: string): string {
  return pattern === key ? "" : ` (${quote(pattern)})`;
}

function describe(entry: unknown): string {
  return typeof entry === "function" ? "a function" : JSON.stringify(entry);
}

function quote(key: string): string {
  return `"${key}"`;
}

function count(of: number | unknown, noun: string): string {
  const n = typeof of === "number" ? of : Array.isArray(of) ? of.length : 1;
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function globMatches(pattern: string, key: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(key);
}

export function firstLine(text: string): string {
  const line = text.split("\n", 1)[0]!;
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/**
 * Equal as JSON Schema: object keys and `required` in any order, so a schema built by another
 * call, with its properties in another order, matches.
 */
function sameSchema(a: OutputSchema | undefined, b: OutputSchema | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalSchema(a) === canonicalSchema(b);
}

function canonicalSchema(schema: OutputSchema): string {
  const sortedRequired = JSON.stringify(schema, (key, value: unknown) =>
    key === "required" && Array.isArray(value) ? [...value].sort() : value,
  );
  return JSON.stringify(canonical(JSON.parse(sortedRequired)));
}

function describeSchema(schema: OutputSchema | undefined): string {
  if (schema === undefined) return "text";
  const text = canonicalSchema(schema);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
