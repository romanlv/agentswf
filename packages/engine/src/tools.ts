import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { canonicalSchema, type JsonSchema, parseJsonSchema } from "@agentswf/contract/schema";
import type { GivenInput, ToolCode, ToolFailure, ToolRequest } from "@agentswf/contract/wire";
import {
  type AgentKey,
  type AgentTools,
  isJsonValue,
  type JsonValue,
  TOOL_LIMITS,
  type ToolSpec,
} from "@agentswf/contract/workflow";
import { scheduleAt } from "./deadlines";
import { messageOf } from "./errors";
import type { RunEventBody } from "./run-event-log";
import { checkGiven, readGiven, simpleInput, usageLine } from "./simple-input";

/** How long a handler that ignores its aborted signal is waited for before its call is settled. */
export const TOOL_SETTLE_MS = 5_000;

/**
 * The agents whose handlers the current code runs in, innermost last: one of them can't be given
 * work, since its turn waits for the handler. It crosses into an operation started from a handler,
 * kept with the operation, so a call into that operation adds to it.
 */
const toolStack = new AsyncLocalStorage<readonly AgentKey[]>();

/** Why `what` on `agent` is refused from a handler it is in; undefined when it isn't. */
export function refusedInTool(agent: AgentKey, what: string): Error | undefined {
  if (!toolStack.getStore()?.includes(agent)) return undefined;
  return new Error(
    `agent-in-tool: ${what} on agent ${agent} is refused, as its tool call is running and its turn waits for it`,
  );
}

/** Whether the current code runs in a tool's handler. */
export function inToolHandler(): boolean {
  return (toolStack.getStore()?.length ?? 0) > 0;
}

export type ToolHost<Scope> = {
  /** Written to the run's event log; false when it wasn't. */
  record(event: RunEventBody): Promise<boolean>;
  /** Runs `fn` in the operation's scope, or in none. */
  runIn<T>(scope: Scope | undefined, fn: () => T): T;
  now?(): number;
};

/** An operation as tool calls bind to it. */
export type ToolOperation<Scope> = {
  id: string;
  agent: AgentKey;
  callPath: string[];
  stage?: string;
  scope: Scope | undefined;
  /** Unix milliseconds, now; absent when nothing bounds it. */
  deadline(): number | undefined;
};

export type ToolAnswer =
  | { kind: "tool-result"; output?: string }
  | { kind: "tool-failed"; outcome: ToolFailure; error: string }
  | { kind: "refused"; code: ToolCode | "internal-error"; error: string };

type Held = { specs: AgentTools; schemas: Map<string, JsonSchema | undefined> };

type Running = {
  tool: string;
  /** When it will have settled, at the latest; absent when only its handler ends it. */
  settledBy?: number;
  abort(cause: ToolFailure): void;
  settled: Promise<void>;
};

type Operation<Scope> = ToolOperation<Scope> & {
  stack: readonly AgentKey[];
  accepted: boolean;
  ending: boolean;
  running?: Running;
};

/** The run's tools: each agent's, and the calls of each operation. */
export class ToolCalls<Scope> {
  readonly #host: ToolHost<Scope>;
  readonly #now: () => number;
  readonly #held = new Map<AgentKey, Held>();
  readonly #current = new Map<AgentKey, Operation<Scope>>();
  readonly #operations = new Map<string, Operation<Scope>>();

  constructor(host: ToolHost<Scope>) {
    this.#host = host;
    this.#now = host.now ?? Date.now;
  }

  // Tools

  /** An agent opened or forked with these tools; checked against the limits first. */
  give(agent: AgentKey, tools: AgentTools): void {
    this.#held.set(agent, held(agent, tools));
  }

  /**
   * An agent opened again, or a fork returned again: matching tools take the new handlers and
   * budgets, different ones conflict, and none given keeps what it has.
   */
  reopen(agent: AgentKey, tools: AgentTools | undefined): void {
    if (tools === undefined) return;
    const next = held(agent, tools);
    const existing = this.#held.get(agent);
    if (!existing || !sameTools(existing, next)) {
      throw new Error(`agent ${agent} is already open with different tools`);
    }
    this.#held.set(agent, next);
  }

  /** The tools an agent has now, handlers included, as a fork takes them. */
  of(agent: AgentKey): AgentTools {
    return this.#held.get(agent)?.specs ?? {};
  }

  /** The tools an agent has, for its lesson: each one's name, description and input schema. */
  taught(agent: AgentKey): { name: string; description: string; input?: JsonSchema }[] {
    const tools = this.#held.get(agent);
    if (!tools) return [];
    return Object.entries(tools.specs).map(([name, spec]) => {
      const input = tools.schemas.get(name);
      return { name, description: spec.description, ...(input ? { input } : {}) };
    });
  }

  // Operations

  /** An operation began: calls from its agent bind to it until it ends. */
  opened(operation: ToolOperation<Scope>): void {
    const state: Operation<Scope> = {
      ...operation,
      stack: toolStack.getStore() ?? [],
      accepted: false,
      ending: false,
    };
    this.#operations.set(operation.id, state);
    this.#current.set(operation.agent, state);
  }

  /** Its result was accepted: it is ending, and takes no more calls. */
  accepted(operationId: string): void {
    const operation = this.#operations.get(operationId);
    if (operation) operation.accepted = true;
  }

  /**
   * The operation's end, before it is recorded: a call still running is aborted `cancelled`, unless
   * its budget already passed, and waited for until it settles.
   */
  async ended(operationId: string): Promise<void> {
    const operation = this.#operations.get(operationId);
    if (!operation) return;
    operation.ending = true;
    const running = operation.running;
    if (running) {
      running.abort("cancelled");
      await running.settled;
    }
    this.#operations.delete(operationId);
    if (this.#current.get(operation.agent) === operation) this.#current.delete(operation.agent);
  }

  /**
   * The operation is being cancelled or stopped: a call it has running is aborted now, not once the
   * turn has settled, which may wait for the call.
   */
  abort(operationId: string, cause: ToolFailure): void {
    const operation = this.#operations.get(operationId);
    if (!operation) return;
    // A call sent before the agent was interrupted may still arrive: it isn't run.
    operation.ending = true;
    operation.running?.abort(cause);
  }

  /** The operation's deadline moved: a call made from now on is bounded by the new one. */
  extended(operationId: string, deadline: number): void {
    const operation = this.#operations.get(operationId);
    if (operation) operation.deadline = () => deadline;
  }

  /** The call this agent has running, which holds back its `wf result` and `wf waiting`. */
  running(agent: AgentKey): { tool: string; settledBy?: number } | undefined {
    const running = this.#current.get(agent)?.running;
    return running && { tool: running.tool, ...optional("settledBy", running.settledBy) };
  }

  // Calls

  /**
   * `wf tool`'s request from `agent`'s socket. `lifetime` sets how long its connection may stay
   * open, from now: undefined for as long as the call takes.
   */
  async call(
    agent: AgentKey,
    request: ToolRequest,
    lifetime: (milliseconds: number | undefined) => void,
  ): Promise<ToolAnswer> {
    const operation = this.#current.get(agent);
    const refuse = async (code: ToolCode, error: string, extra?: { error?: string }) => {
      const recorded = await this.#host.record({
        kind: "tool-refused",
        callPath: operation?.callPath ?? [],
        ...optional("stage", operation?.stage),
        ...(operation && code !== "no-operation" ? { operationId: operation.id } : {}),
        agent,
        tool: request.tool,
        code,
        ...(extra?.error === undefined ? {} : { error: extra.error }),
      });
      return recorded
        ? ({ kind: "refused", code, error } as const)
        : ({ kind: "refused", code: "internal-error", error: UNRECORDED_REFUSAL } as const);
    };
    if (!operation || operation.ending) {
      return refuse(
        "no-operation",
        "you aren't in a turn; a tool can be called only while you work on one",
      );
    }
    if (operation.accepted) {
      return refuse(
        "result-accepted",
        "your result is accepted, so this turn is ending; the tool wasn't run",
      );
    }
    if (operation.running) {
      return refuse(
        "tool-busy",
        `your call of ${operation.running.tool} is still running; wait for it to answer, then call again`,
      );
    }
    const tools = this.#held.get(agent);
    const spec =
      tools && Object.hasOwn(tools.specs, request.tool) ? tools.specs[request.tool] : undefined;
    if (!tools || !spec) {
      const names = tools ? Object.keys(tools.specs) : [];
      return refuse(
        "unknown-tool",
        names.length === 0
          ? `you have no tool named ${request.tool}; you have no tools`
          : `you have no tool named ${request.tool}; yours: ${names.join(", ")}`,
      );
    }
    const read = readInput(request.tool, tools.schemas.get(request.tool), request);
    if (!read.ok) return refuse("invalid-input", read.error, { error: read.error });

    // Checked, so the call holds the agent's slot before anything is awaited.
    const id = randomUUID();
    const controller = new AbortController();
    let cause: ToolFailure | undefined;
    let handlerEnded = false;
    const timeoutMs = spec.timeoutMs === undefined ? TOOL_LIMITS.defaultTimeoutMs : spec.timeoutMs;
    const deadline = operation.deadline();
    const startedAt = this.#now();
    const budgetEnd = minimum(timeoutMs === false ? undefined : startedAt + timeoutMs, deadline);
    const bound =
      deadline !== undefined && budgetEnd === deadline ? ("deadline" as const) : timeoutMs;
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    const running: Running = {
      tool: request.tool,
      ...optional("settledBy", budgetEnd === undefined ? undefined : budgetEnd + TOOL_SETTLE_MS),
      abort: (why) => {
        if (cause || handlerEnded) return;
        cause = why;
        controller.abort(
          new Error(
            why === "timed-out" ? "the tool call's budget passed" : "the tool call was cancelled",
          ),
        );
      },
      settled,
    };
    operation.running = running;
    // The engine answers before the connection is cut: the budget, the settle, and a margin.
    lifetime(
      budgetEnd === undefined ? undefined : Math.max(budgetEnd - startedAt, 0) + 2 * TOOL_SETTLE_MS,
    );
    const keys = {
      call: id,
      callPath: operation.callPath,
      ...optional("stage", operation.stage),
      operationId: operation.id,
      agent,
      tool: request.tool,
    };
    try {
      if (!(await this.#host.record({ kind: "tool-called", ...keys, input: read.value }))) {
        return { kind: "refused", code: "internal-error", error: UNRECORDED_CALL };
      }
      // In steps, as every engine deadline is: a budget weeks away must not overflow a timer.
      const cancelTimer =
        budgetEnd === undefined
          ? undefined
          : scheduleAt({ unixMilliseconds: budgetEnd }, () => running.abort("timed-out"));
      if (cause) {
        // Its operation ended, or its budget passed, before it could start: the handler isn't run.
        const error = `${request.tool} wasn't run: ${cause === "timed-out" ? "its time was up" : "your turn ended"} first`;
        const recorded = await this.#host.record({
          kind: "tool-ended",
          ...keys,
          outcome: cause,
          error,
          durationMs: 0,
        });
        cancelTimer?.();
        return recorded
          ? { kind: "tool-failed", outcome: cause, error }
          : { kind: "refused", code: "internal-error", error: UNRECORDED_END };
      }
      const handlerStart = this.#now();
      const ended = await this.#settle(
        spec,
        read.value,
        { id, agent, signal: controller.signal },
        operation,
        // As soon as it returns or throws, before an abort racing it could count.
        () => {
          handlerEnded = true;
        },
      );
      handlerEnded = true;
      cancelTimer?.();
      const durationMs = this.#now() - handlerStart;
      const answer = cause ? aborted(request.tool, cause, bound) : ended;
      const outcome = answer.kind === "tool-result" ? "ok" : answer.outcome;
      const recorded = await this.#host.record({
        kind: "tool-ended",
        ...keys,
        outcome,
        ...(answer.kind === "tool-result" &&
        ended.kind === "tool-result" &&
        ended.value !== undefined
          ? { result: ended.value }
          : {}),
        ...(answer.kind === "tool-failed" ? { error: answer.error } : {}),
        durationMs,
      });
      if (!recorded) return { kind: "refused", code: "internal-error", error: UNRECORDED_END };
      return answer.kind === "tool-result"
        ? { kind: "tool-result", ...optional("output", answer.output) }
        : answer;
    } finally {
      operation.running = undefined;
      settle();
    }
  }

  /** Runs the handler, and waits for it at most `TOOL_SETTLE_MS` once its signal aborts. */
  async #settle(
    spec: ToolSpec,
    input: Record<string, JsonValue>,
    call: { id: string; agent: AgentKey; signal: AbortSignal },
    operation: Operation<Scope>,
    onEnd: () => void,
  ): Promise<
    | { kind: "tool-result"; output?: string; value?: JsonValue }
    | { kind: "tool-failed"; outcome: "failed"; error: string }
  > {
    const handled = Promise.resolve()
      .then(() =>
        toolStack.run([...operation.stack, call.agent], () =>
          this.#host.runIn(operation.scope, () => spec.handler(structuredClone(input), call)),
        ),
      )
      .then(
        (value) => {
          onEnd();
          return resultOf(value);
        },
        (error: unknown) => {
          onEnd();
          return {
            kind: "tool-failed" as const,
            outcome: "failed" as const,
            error: messageOf(error),
          };
        },
      );
    const { promise: abortedSignal, resolve } = Promise.withResolvers<"aborted">();
    if (call.signal.aborted) resolve("aborted");
    else call.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
    const first = await Promise.race([handled, abortedSignal]);
    if (first !== "aborted") return first;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const late = await Promise.race([
      handled,
      new Promise<"late">((done) => {
        wait = setTimeout(() => done("late"), TOOL_SETTLE_MS);
      }),
    ]);
    clearTimeout(wait);
    // Whatever it then returned, the caller takes the abort's outcome; one still running is dropped.
    return late === "late"
      ? { kind: "tool-failed", outcome: "failed", error: "it didn't settle" }
      : late;
  }
}

const UNRECORDED_REFUSAL = "the tool call was refused, but the refusal couldn't be recorded";
const UNRECORDED_CALL =
  "the tool call couldn't be recorded, so it wasn't run; it may be safe to call again";
const UNRECORDED_END =
  "the tool call ran, but its end couldn't be recorded; check what it did before calling it again";

function resultOf(
  value: unknown,
):
  | { kind: "tool-result"; output?: string; value?: JsonValue }
  | { kind: "tool-failed"; outcome: "failed"; error: string } {
  if (value === undefined) return { kind: "tool-result" };
  if (!isJsonValue(value)) {
    return {
      kind: "tool-failed",
      outcome: "failed",
      error: "the tool returned a value that isn't JSON, so nothing could be sent back",
    };
  }
  const output = typeof value === "string" ? value : JSON.stringify(value);
  if (Buffer.byteLength(JSON.stringify(value)) > TOOL_LIMITS.resultBytes) {
    return {
      kind: "tool-failed",
      outcome: "failed",
      error: `the tool's result is too large to send back: over ${TOOL_LIMITS.resultBytes} bytes`,
    };
  }
  return { kind: "tool-result", output, value };
}

function aborted(
  tool: string,
  cause: ToolFailure,
  /** What bounded it: its own budget, or the turn's deadline. */
  bound: number | false | "deadline",
): { kind: "tool-failed"; outcome: ToolFailure; error: string } {
  const what =
    cause === "cancelled"
      ? `${tool} was stopped as your turn ended`
      : bound === "deadline"
        ? `${tool} didn't answer before your turn's deadline`
        : `${tool} didn't answer in time${bound === false ? "" : ` (${bound / 1000} s)`}`;
  return {
    kind: "tool-failed",
    outcome: cause,
    error: `${what}; it may have run, so check before calling it again`,
  };
}

function readInput(
  tool: string,
  schema: JsonSchema | undefined,
  given: GivenInput,
): { ok: true; value: Record<string, JsonValue> } | { ok: false; error: string } {
  if (!schema) {
    return given.raw === undefined && given.args === undefined
      ? { ok: true, value: {} }
      : { ok: false, error: `${tool} takes no input; call it with its name alone` };
  }
  const size = given.raw ?? JSON.stringify(given.args ?? []);
  if (Buffer.byteLength(size) > TOOL_LIMITS.inputBytes) {
    return { ok: false, error: `the input is too large: over ${TOOL_LIMITS.inputBytes} bytes` };
  }
  const read = readGiven(schema, given);
  if (!read.ok) return read;
  const invalid = checkGiven(schema, given, read.value);
  if (invalid) return { ok: false, error: invalid };
  const value = read.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "the input must be a JSON object" };
  }
  return { ok: true, value: value as Record<string, JsonValue> };
}

/** What the lesson shows for a tool's input: its usage line, or its schema when not simple. */
export function toolUsage(input: JsonSchema | undefined): { flags: string } | { schema: string } {
  if (!input) return { flags: "" };
  const simple = simpleInput(input);
  return simple ? { flags: usageLine(simple) } : { schema: JSON.stringify(input) };
}

function held(agent: AgentKey, tools: AgentTools): Held {
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    throw new Error(`agent ${agent}'s tools are an object of tools by name`);
  }
  const names = Object.keys(tools);
  if (names.length > TOOL_LIMITS.tools) {
    throw new Error(`agent ${agent} has ${names.length} tools; at most ${TOOL_LIMITS.tools}`);
  }
  const schemas = new Map<string, JsonSchema | undefined>();
  for (const name of names) {
    const spec = tools[name]!;
    const where = `agent ${agent}'s tool ${JSON.stringify(name)}`;
    if (!TOOL_LIMITS.name.test(name)) {
      throw new Error(`${where}: a tool's name matches ${TOOL_LIMITS.name}`);
    }
    if (typeof spec?.handler !== "function") throw new Error(`${where} has no handler`);
    if (typeof spec.description !== "string" || spec.description.trim() === "") {
      throw new Error(`${where} needs a description`);
    }
    if (Buffer.byteLength(spec.description) > TOOL_LIMITS.descriptionBytes) {
      throw new Error(`${where}: its description is over ${TOOL_LIMITS.descriptionBytes} bytes`);
    }
    const timeout = spec.timeoutMs;
    if (
      timeout !== undefined &&
      timeout !== false &&
      !(Number.isSafeInteger(timeout) && timeout > 0)
    ) {
      throw new Error(`${where}: timeoutMs is a positive integer, or false for none`);
    }
    if (spec.input === undefined) {
      schemas.set(name, undefined);
      continue;
    }
    let input: JsonSchema;
    try {
      input = parseJsonSchema(spec.input);
    } catch (error) {
      throw new Error(`${where}: ${messageOf(error)}`);
    }
    if (!("type" in input) || input.type !== "object") {
      throw new Error(`${where}: its input schema must be an object`);
    }
    if (Buffer.byteLength(canonicalSchema(input)) > TOOL_LIMITS.schemaBytes) {
      throw new Error(`${where}: its input schema is over ${TOOL_LIMITS.schemaBytes} bytes`);
    }
    // Its JSON, in the author's order for the lesson, without TypeBox's own keys.
    schemas.set(name, JSON.parse(JSON.stringify(input)) as JsonSchema);
  }
  return { specs: { ...tools }, schemas };
}

function sameTools(a: Held, b: Held): boolean {
  const names = Object.keys(a.specs);
  if (names.length !== Object.keys(b.specs).length) return false;
  return names.every((name) => {
    const other = b.specs[name];
    if (!other || other.description !== a.specs[name]!.description) return false;
    const left = a.schemas.get(name);
    const right = b.schemas.get(name);
    return (left && canonicalSchema(left)) === (right && canonicalSchema(right));
  });
}

function minimum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
