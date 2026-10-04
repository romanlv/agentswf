import type { Effort, JsonValue, OutputSchema } from "@agentswf/contract/workflow";
import type Type from "typebox";
import { canonical } from "../canonical-json";
import { messageOf } from "../errors";

/** One turn of a scripted agent, as the workflow wrote it. */
export type Turn = {
  /** The agent's key. */
  agent: string;
  /** 1-based in the agent's session. A nudge shares its turn's number. */
  n: number;
  nudge: boolean;
  prompt: string;
  /** Absent for a turn that asks for text. */
  schema?: OutputSchema;
  label?: string;
  cwd: string;
  /** The model the agent ran this turn at: as opened, then as its last `set` left it. */
  model: string;
  /** Its effort, likewise; absent, the harness's default. */
  effort?: Effort;
  /** Fires when the engine cancels the turn. */
  signal: AbortSignal;
};

const ENTRY: unique symbol = Symbol("agentswf.script-entry");

type Respond = (turn: Turn) => JsonValue | Reply | Promise<JsonValue | Reply>;

/** An answer to a turn that asks for its schema, or for text. Made by `answer`. */
export type Answer = {
  readonly [ENTRY]: { kind: "answer"; schema: OutputSchema | undefined; respond: Respond };
};

type Ending =
  | { kind: "silent" }
  | { kind: "blocked" | "failed" | "timed-out"; reason: string }
  | { kind: "hang" }
  | { kind: "interrupted" };

/** A turn ended without an answer. Made by `reply`. */
export type Reply = { readonly [ENTRY]: { kind: "reply"; ending: Ending } };

/** Every turn the agent is asked, alike; or a list, one entry per turn in order. */
export type Script = Answer | Reply | readonly (Answer | Reply)[];

/** What a schema's answer is: the carrier the author surface types with, else TypeBox's `Static`. */
export type AnswerOf<S> = S extends { readonly "~output"?: infer O }
  ? unknown extends O
    ? StaticOf<S>
    : Exclude<O, undefined>
  : StaticOf<S>;
type StaticOf<S> = S extends Type.TSchema ? Type.Static<S> : JsonValue;

type Answering<A> = A | ((turn: Turn) => A | Reply | Promise<A | Reply>);

/**
 * An answer to a turn that asks for `schema`: a value of its type, or a function of the turn that
 * returns one or a `reply`. A function that returns a reply is asked again for the nudge, with
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

const ending = (value: Ending): Reply => ({ [ENTRY]: { kind: "reply", ending: value } });

/** Ends a turn without an answer. A reply answers no question, so it takes no schema. */
export const reply = {
  /** Ends the turn without reporting a result; the engine nudges once. */
  silent: (): Reply => ending({ kind: "silent" }),
  /** The agent is stuck, as on a permission prompt. */
  blocked: (reason = "waiting on a permission prompt"): Reply =>
    ending({ kind: "blocked", reason }),
  /** The harness failed. */
  failed: (reason = "harness crashed"): Reply => ending({ kind: "failed", reason }),
  /** The harness reported the turn timed out; it ends at once. */
  timedOut: (reason = "turn timed out"): Reply => ending({ kind: "timed-out", reason }),
  /** Holds the turn until the engine cancels it. */
  hang: (): Reply => ending({ kind: "hang" }),
  /**
   * The operator stopped the turn in their pane, as only the calling session's can be: it settles
   * `cancelled`, is never nudged, and the session takes the next turn.
   */
  interrupted: (): Reply => ending({ kind: "interrupted" }),
};

/** How a turn ended, as `run.turns` keeps it. */
export type TurnOutcome = "answered" | Ending["kind"] | "cancelled";

export type Step =
  | { kind: "answer"; value: JsonValue }
  | { kind: "reply"; ending: Ending }
  /** The script cannot meet this turn: the test's mistake, not the workflow's. */
  | { kind: "script-error"; message: string };

/**
 * Finds each agent's script and walks it. An exact key wins over a pattern; two patterns matching
 * one key is the test's mistake. A list is walked per agent, and ends the test if run past.
 */
export class Scripts {
  readonly #scripts: Readonly<Record<string, Script>>;
  /** The furthest turn each agent reached, by the key or pattern that met it. */
  readonly #reached = new Map<string, { pattern: string; n: number }>();
  /** What each entry answers. */
  readonly #noun: "turn" | "compaction";

  constructor(
    scripts: Readonly<Record<string, Script>> = {},
    of: { noun: "turn" | "compaction"; option: string } = { noun: "turn", option: "agents" },
  ) {
    this.#noun = of.noun;
    for (const [key, script] of Object.entries(scripts)) {
      if (isList(script) && script.length === 0) {
        throw new TypeError(
          `${of.option}["${key}"] is an empty list; a list has an entry per ${of.noun}`,
        );
      }
      for (const entry of isList(script) ? script : [script]) {
        if (!isEntry(entry)) {
          throw new TypeError(
            `${of.option}["${key}"] must be answer(…), reply.…() or a list of them, not ${JSON.stringify(entry)}`,
          );
        }
      }
    }
    this.#scripts = scripts;
  }

  /** Whether any script, by key or pattern, is for this agent. */
  has(agent: string): boolean {
    return !("why" in findByKey(this.#scripts, agent, "agent"));
  }

  async step(turn: Turn): Promise<Step> {
    const found = findByKey(this.#scripts, turn.agent, "agent");
    if ("why" in found) return this.error(turn, found.why);
    const { pattern, value: script } = found;
    const entry = isList(script) ? script[turn.n - 1] : script;
    if (!entry) {
      return this.error(
        turn,
        `its ${this.#whose()}${named(pattern, turn.agent)} has ${count(script, this.#noun)}`,
      );
    }
    const reached = this.#reached.get(turn.agent);
    this.#reached.set(turn.agent, { pattern, n: Math.max(reached?.n ?? 0, turn.n) });
    const meant = entry[ENTRY];
    if (meant.kind === "reply") return { kind: "reply", ending: meant.ending };
    if (!sameSchema(meant.schema, turn.schema)) {
      return this.error(
        turn,
        `it asks for ${describeSchema(turn.schema)}; its script answers ${describeSchema(meant.schema)}`,
      );
    }
    let out: JsonValue | Reply | undefined;
    try {
      out = await meant.respond(turn);
    } catch (error) {
      return this.error(turn, `its script threw: ${messageOf(error)}`);
    }
    if (out === undefined) return this.error(turn, "its script returned nothing");
    if (isEntry(out)) {
      const given = out[ENTRY];
      if (given.kind === "reply") return { kind: "reply", ending: given.ending };
      return this.error(turn, "its script returned answer(…); a function returns the value itself");
    }
    return { kind: "answer", value: out };
  }

  #whose(): string {
    return this.#noun === "turn" ? "script" : `${this.#noun} script`;
  }

  private error(turn: Turn, why: string): Step {
    return {
      kind: "script-error",
      message: `agent "${turn.agent}" ${this.#noun} ${turn.n}${turn.nudge ? " (nudge)" : ""}: ${why}. It was asked: ${firstLine(turn.prompt)}`,
    };
  }

  /** What a list scripted and no turn reached. */
  leftovers(): string[] {
    const problems: string[] = [];
    for (const [key, { pattern, n }] of this.#reached) {
      const script = this.#scripts[pattern]!;
      if (isList(script) && n < script.length) {
        problems.push(
          `agent "${key}" was asked ${count(n, this.#noun)}; its ${this.#whose()}${named(pattern, key)} has ${script.length}`,
        );
      }
    }
    const met = new Set([...this.#reached.values()].map(({ pattern }) => pattern));
    for (const [pattern, script] of Object.entries(this.#scripts)) {
      if (isList(script) && !met.has(pattern)) {
        const who = pattern.includes("*")
          ? `no agent matching "${pattern}" was asked`
          : `agent "${pattern}" was never asked`;
        problems.push(`${who}; its ${this.#whose()} has ${count(script, this.#noun)}`);
      }
    }
    return problems;
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

function isEntry(value: unknown): value is Answer | Reply {
  return typeof value === "object" && value !== null && ENTRY in value;
}

function isList(script: Script): script is readonly (Answer | Reply)[] {
  return Array.isArray(script);
}

function named(pattern: string, key: string): string {
  return pattern === key ? "" : ` (${quote(pattern)})`;
}

function quote(key: string): string {
  return `"${key}"`;
}

function count(of: number | Script, noun: string): string {
  const n = typeof of === "number" ? of : isList(of) ? of.length : 1;
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
