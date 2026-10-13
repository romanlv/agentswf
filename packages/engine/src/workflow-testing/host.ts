import type { SandboxRecord } from "@agentswf/contract/records";
import {
  type MessageResponse,
  REPLY_CODES,
  type ReplyCode,
  SEND_CODES,
  type SendCode,
  WIRE_VERSION,
} from "@agentswf/contract/wire";
import {
  type AgentExecution,
  type AgentPlacement,
  type Effort,
  type JsonObject,
  type KeepPane,
  type PaneLayout,
  placementOf,
} from "@agentswf/contract/workflow";
import {
  createPlacementHostFactory,
  createSingleSessionHostFactory,
  findHarness,
  headlessRefusal,
  loginFailure,
  PLACEMENT_HARNESSES,
  settingsRefusal,
} from "@agentswf/harness";
import type { AgentRunHostFactory, HarnessActivation } from "@agentswf/harness/adapter";
import {
  createFakeAdapter,
  createFakeCallingSession,
  type FakeAdapterTurn,
  type FakeAdapterTurnContext,
  type FakeFork,
  type FakeSet,
} from "@agentswf/harness/testing";
import { submitControl, submitResult, submitWaiting } from "@agentswf/wf/client";
import {
  type Message,
  type MessageOutcome,
  type MessageScripts,
  type ReceivedMessage,
  reply,
  type Scripts,
  type SendOptions,
  type Step,
  type Turn,
  type TurnOutcome,
} from "./script";

/**
 * A turn as the workflow wrote it, and how it ended. `messages` are those it was shown, absent when
 * none were.
 */
export type TurnRecord = Omit<Turn, "signal" | "messages" | "send" | "reply"> & {
  messages?: readonly Message[];
  outcome: TurnOutcome;
};

/** A compaction as the workflow asked for it, and how it ended. */
export type CompactionRecord = {
  agent: string;
  /** 1-based among the agent's compactions. */
  n: number;
  id: string;
  /** The spec's prompt: what the harness is to keep and drop. */
  focus: string;
  outcome: TurnOutcome;
};

/** A switch of an agent's model or effort, as the host was asked for it. */
export type SetRecord = {
  agent: string;
  /** 1-based among the agent's switches. */
  n: number;
  /** The settings switched to, whole. */
  model: string;
  effort?: Effort;
};

/** An agent the workflow opened, as it opened it. */
export type OpenedAgent = {
  key: string;
  execution: AgentExecution;
  instructions?: string;
  labels?: JsonObject;
  /** The skills it was given by name; absent when the workflow named none. */
  skills?: readonly string[];
  /** The sandbox it ran in; absent on the host. */
  sandbox?: AgentSandbox;
  /**
   * The agent it was forked from, or the session the run was started from, and how many of its
   * turns in this run the copy holds.
   */
  forkedFrom?: { key: string; turns: number } | { caller: true; turns: number };
  /**
   * Its pane's layout as the workflow wrote it; this host has no screen, so nothing says where a
   * pane landed or whether a `beside` fell back.
   */
  layout?: PaneLayout;
  /** Why the engine already knew `layout` could not be used: a `beside` an agent with no pane. */
  layoutFallback?: string;
  keepPane?: KeepPane;
  /** Its pane was kept when it was done: `keepPane` asked, and how its last operation ended let it. */
  keptPane?: true;
};

/** The sandbox an agent ran in, as the run's record keeps it. */
export type AgentSandbox = Pick<SandboxRecord, "key" | "provider" | "spec" | "domains">;

export type ScriptedHost = {
  factory: AgentRunHostFactory;
  turns: TurnRecord[];
  compactions: CompactionRecord[];
  sets: SetRecord[];
  agents: OpenedAgent[];
  /** Turns started and not yet ended, for a stalled run's message. */
  inFlight(): TurnRecord[];
};

/**
 * The run host a workflow's test runs on: the production session core behind each placement,
 * over a fake adapter that answers from the scripts. It refuses the harnesses each real host
 * refuses; the fake sandbox provider hosts panes, so no sandbox is refused one.
 */
export function createScriptedHost(
  scripts: Scripts,
  /** Unscripted, an agent's compactions all answer `""`. */
  compactionScripts: Scripts,
  messageScripts: MessageScripts,
  events: {
    /** A turn started or ended: the run is not stalled. */
    onActivity(): void;
    /** The script could not meet a turn: the test fails. */
    onScriptError(message: string): void;
  },
  /**
   * The session the run is started from, as `awf run --here` finds one, and the model its files
   * show, which a fork of it runs on (ADR 0010).
   */
  caller?: { harness: string; cwd: string; model?: string; here?: boolean },
): ScriptedHost {
  const turns: TurnRecord[] = [];
  const compactions: CompactionRecord[] = [];
  const compactionCounts = new Map<string, number>();
  const sets: SetRecord[] = [];
  const agents: OpenedAgent[] = [];
  const open = new Set<TurnRecord>();
  const counts = new Map<string, number>();
  /** Each fork's session, by the agent it copied and that agent's turns so far. */
  const forks = new Map<string, NonNullable<OpenedAgent["forkedFrom"]>>();
  /** The calling session's key, once the workflow has it as an agent. */
  let callerKey: string | undefined;
  // As a real run has it: a session whose files name no model is none to fork.
  const calling =
    caller &&
    (caller.model === undefined
      ? `${caller.harness} session fake-calling has nothing to fork: its files hold no request naming a model, as in its first turn`
      : createFakeCallingSession({
          harness: caller.harness,
          cwd: caller.cwd,
          model: caller.model,
          onFork: (sessionRef) =>
            forks.set(sessionRef, {
              caller: true,
              turns: callerKey === undefined ? 0 : (counts.get(callerKey) ?? 0),
            }),
        }));
  const end = (record: TurnRecord, outcome: TurnOutcome) => {
    record.outcome = outcome;
    open.delete(record);
    events.onActivity();
  };
  const failTest = (message: string): FakeAdapterTurn => {
    events.onScriptError(message);
    return { state: "failed", detail: message };
  };
  /** Each operation's calls in flight, by its call id. */
  const operations = new Map<string, Operation>();
  /** How many workflow turns, and how many message operations, each agent has had. */
  const workflowTurns = new Map<string, number>();
  const messageOperations = new Map<string, number>();
  const next = (counter: Map<string, number>, agent: string) => {
    const n = (counter.get(agent) ?? 0) + 1;
    counter.set(agent, n);
    return n;
  };

  /** `wf send` or `wf reply` from a running script; with `awaitReply`, resolves with the reply. */
  const message = async (
    invocation: Invocation,
    command: "send" | "reply",
    peer: string,
    text: string,
    options: SendOptions = {},
  ): Promise<MessageOutcome> => {
    const { operation } = invocation;
    if (invocation.state !== "running") {
      const why = `agent "${invocation.turn.agent}" turn ${invocation.turn.n}: its script sent after its turn ended; await only the host's calls while a reply is awaited`;
      failTest(why);
      throw new Error(why);
    }
    const call = submitControl(operation.binding.endpoint, {
      version: WIRE_VERSION,
      command,
      peer,
      text,
      ...(options.awaitReply ? { awaitReply: true as const } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    invocation.calls.add(call);
    let response: MessageResponse;
    try {
      response = await call;
    } finally {
      invocation.calls.delete(call);
    }
    if (response.kind === "rejected") {
      if (MESSAGE_CODES.has(response.code)) {
        suspendIfAwaiting(invocation);
        return { kind: "refused", code: response.code as SendCode | ReplyCode };
      }
      throw new Error(`wf ${command} was refused (${response.code}): ${response.error}`);
    }
    if (!options.awaitReply) {
      suspendIfAwaiting(invocation);
      return { kind: "sent" };
    }
    return new Promise((resolve) => {
      operation.awaiting.push({ peer, by: invocation, resolve });
      suspendIfAwaiting(invocation);
    });
  };

  /**
   * Ends the native turn when its script has gone still awaiting a reply, as an agent ends its turn
   * after `wf send --await-reply`: nothing of the host's in flight, and no step taken since.
   */
  const suspendIfAwaiting = (invocation: Invocation) => {
    setTimeout(() => {
      const { operation } = invocation;
      if (
        invocation.state === "running" &&
        invocation.calls.size === 0 &&
        operation.awaiting.some((each) => each.by === invocation)
      ) {
        invocation.stopped.resolve("suspended");
      }
    }, 0);
  };

  /** Starts the script for this turn: the agent's turn script, or a message script when one woke it. */
  const invoke = (
    context: FakeAdapterTurnContext,
    operation: Operation,
    record: TurnRecord,
    shown: readonly Message[],
  ): Invocation => {
    const { activation, authored } = context;
    const invocation: Invocation = {
      operation,
      calls: new Set(),
      state: "running",
      stopped: Promise.withResolvers(),
      turn: undefined as unknown as Turn,
    };
    const messages = [...shown];
    const { outcome: _outcome, messages: _shown, ...written } = record;
    const turn: Turn = {
      ...written,
      messages,
      send: (peer, text, options) => message(invocation, "send", peer, text, options),
      reply: (peer, text, options) => message(invocation, "reply", peer, text, options),
      signal: context.signal,
    };
    invocation.turn = turn;
    let step: Promise<Step>;
    if (authored?.cause) {
      if (context.kind === "turn") operation.message = next(messageOperations, activation.key);
      const woke = shown[0] ?? operation.woke;
      operation.woke = woke;
      step = messageScripts.step(
        {
          ...woke!,
          turn,
          reply: (text, options) => turn.reply(woke!.from, text, options),
          send: turn.send,
          silent: reply.silent,
          fail: (reason) => reply.failed(reason),
        } satisfies ReceivedMessage,
        operation.message!,
      );
    } else {
      if (context.kind === "turn") operation.workflow = next(workflowTurns, activation.key);
      step = scripts.step(turn, operation.workflow);
    }
    void step.then((taken) => {
      const was = invocation.state;
      invocation.state = "settled";
      if (was === "running") invocation.stopped.resolve({ step: taken });
      else if (was === "suspended") {
        failTest(
          `agent "${turn.agent}" turn ${turn.n}: its script went on after its turn ended awaiting a reply; await only the host's calls`,
        );
      }
    });
    return invocation;
  };

  /** Runs the native turn until its script stops: an answer or ending, or a wait for a reply. */
  const until = async (
    invocation: Invocation,
    context: FakeAdapterTurnContext,
    record: TurnRecord,
  ): Promise<FakeAdapterTurn> => {
    const { operation } = invocation;
    const stopped = await Promise.race([invocation.stopped.promise, whenAborted(context.signal)]);
    if (stopped === "cancelled") {
      invocation.state = "cancelled";
      end(record, "cancelled");
      settle(operation, (each) => each.by === invocation, { kind: "failed", reason: "cancelled" });
      return {};
    }
    if (stopped === "suspended") {
      invocation.state = "suspended";
      operation.suspended = invocation;
      end(record, "awaiting-reply");
      return {};
    }
    return perform(stopped.step, context, record, invocation);
  };

  /**
   * Lets go of scripts of `agent` suspended awaiting a reply that will not come: its call ended, as
   * another of its calls starting or its session closing shows. Their waits resolve `cancelled`.
   */
  const abandon = (agent: string, except?: Operation) => {
    for (const operation of operations.values()) {
      const { suspended } = operation;
      if (operation.agent !== agent || operation === except || !suspended) continue;
      operation.suspended = undefined;
      suspended.state = "cancelled";
      settle(operation, (each) => each.by === suspended, { kind: "failed", reason: "cancelled" });
    }
  };

  const perform = (
    step: Step,
    context: FakeAdapterTurnContext,
    record: TurnRecord,
    invocation?: Invocation,
  ): FakeAdapterTurn => {
    if (step.kind === "script-error") {
      open.delete(record);
      return failTest(step.message);
    }
    if (step.kind === "answer") {
      return {
        act: async () => {
          // Submitted is answered, even though the engine then releases the turn.
          let outcome: TurnOutcome = "cancelled";
          try {
            // As an agent's `wf send` returns before it can run `wf result`.
            if (invocation) await Promise.allSettled([...invocation.calls]);
            const { endpoint, operationId } = context.binding!;
            const response = await submitResult(endpoint, {
              version: WIRE_VERSION,
              command: "result",
              operationId,
              raw: JSON.stringify(step.value),
            });
            if (response.kind === "accepted") {
              outcome = "answered";
              // The wait is dropped, as the agent's would be.
              if (invocation) {
                settle(invocation.operation, () => true, { kind: "failed", reason: "dropped" });
              }
            } else if (!CLOSED_CODES.has(response.code)) {
              outcome = "failed";
              failTest(
                response.code === "owes-reply"
                  ? `agent "${record.agent}" turn ${record.n}: its script answered while it owes a reply; reply with turn.reply first: ${response.error}`
                  : `agent "${record.agent}" turn ${record.n}: the schema refused its script's answer: ${response.error}`,
              );
            }
          } finally {
            end(record, outcome);
          }
        },
      };
    }
    const { ending } = step;
    if (ending.kind === "waiting") {
      return {
        act: async () => {
          const { endpoint, operationId } = context.binding!;
          const response = await submitWaiting(endpoint, {
            version: WIRE_VERSION,
            command: "waiting",
            operationId,
            reason: ending.reason,
            ...(ending.timeoutMs === undefined ? {} : { timeoutMs: ending.timeoutMs }),
          });
          if (response.kind === "rejected" && !CLOSED_CODES.has(response.code)) {
            failTest(`waiting rejected: ${response.error}`);
          }
          end(record, response.kind === "rejected" ? "cancelled" : "waiting");
        },
      };
    }
    if (ending.kind === "hang") {
      return {
        act: async (turn) => {
          await whenAborted(turn.signal);
          end(record, "hang");
        },
      };
    }
    if (ending.kind === "interrupted") {
      if (!context.activation.execution.caller) {
        open.delete(record);
        return failTest(
          `agent "${record.agent}" turn ${record.n}: only the calling session can be interrupted by the operator`,
        );
      }
      end(record, "interrupted");
      return { state: "cancelled", detail: "interrupted by the operator" };
    }
    end(record, ending.kind);
    return ended(ending, context.activation.execution.harness);
  };

  const compact = async (context: FakeAdapterTurnContext): Promise<FakeAdapterTurn> => {
    const { activation } = context;
    const n = (compactionCounts.get(activation.key) ?? 0) + 1;
    compactionCounts.set(activation.key, n);
    const record: CompactionRecord = {
      agent: activation.key,
      n,
      id: context.id,
      focus: context.prompt,
      outcome: "hang",
    };
    compactions.push(record);
    const done = (outcome: TurnOutcome) => {
      record.outcome = outcome;
      events.onActivity();
    };
    // What every real host refuses, so a test cannot pass where a run would fail.
    const refused = refusedCompaction(activation, (counts.get(activation.key) ?? 0) > 0);
    if (refused) {
      done("failed");
      return { state: "failed", detail: refused };
    }
    if (!compactionScripts.has(activation.key)) {
      done("answered");
      return { summary: "" };
    }
    const step = await Promise.race([
      compactionScripts.step({
        agent: activation.key,
        n,
        nudge: false,
        prompt: context.prompt,
        messages: [],
        send: noMessages,
        reply: noMessages,
        cwd: activation.cwd,
        model: context.settings.model,
        ...(context.settings.effort === undefined ? {} : { effort: context.settings.effort }),
        signal: context.signal,
      }),
      whenAborted(context.signal),
    ]);
    if (step === "cancelled") {
      done("cancelled");
      return {};
    }
    if (step.kind === "script-error") return failTest(step.message);
    if (step.kind === "answer") {
      if (typeof step.value !== "string") {
        return failTest(
          `agent "${activation.key}" compaction ${n}: its compaction script answers a summary, text, not ${JSON.stringify(step.value)}`,
        );
      }
      done("answered");
      return { summary: step.value };
    }
    const { ending } = step;
    if (ending.kind === "waiting") return failTest("compaction cannot report waiting");
    if (ending.kind === "hang") {
      return {
        act: async (turn) => {
          await whenAborted(turn.signal);
          done("hang");
        },
      };
    }
    if (ending.kind === "interrupted") {
      return failTest(
        `agent "${activation.key}" compaction ${n}: a compaction is not interrupted by the operator`,
      );
    }
    done(ending.kind);
    return ended(ending, activation.execution.harness);
  };

  const script = async (context: FakeAdapterTurnContext): Promise<FakeAdapterTurn> => {
    events.onActivity();
    if (context.kind === "compact") return compact(context);
    const { authored, activation, binding } = context;
    // The engine hands every turn and nudge what the workflow wrote, bound to its call.
    if (!authored || !binding) {
      return failTest(
        `agent "${activation.key}" got a ${context.kind} without what the workflow wrote`,
      );
    }
    const operation = operations.get(binding.operationId) ?? {
      agent: activation.key,
      binding,
      awaiting: [],
    };
    operations.set(binding.operationId, operation);
    abandon(activation.key, operation);
    const n = (counts.get(activation.key) ?? 0) + (context.kind === "turn" ? 1 : 0);
    counts.set(activation.key, n);
    const delivered = authored.messages ?? [];
    const shown = delivered.flatMap((each): Message[] =>
      each.kind === "message"
        ? [
            {
              from: each.from,
              text: each.text,
              ...(each.asks ? { asks: true as const } : {}),
              ...(each.answers ? { answers: true as const } : {}),
            },
          ]
        : [],
    );
    const record: TurnRecord = {
      agent: activation.key,
      n,
      // A continuation that delivers nothing is a reminder of a reply owed: a nudge.
      nudge: context.kind === "nudge" || (context.kind === "deliver" && delivered.length === 0),
      prompt: authored.prompt,
      ...(authored.schema === undefined ? {} : { schema: authored.schema }),
      ...(authored.label === undefined ? {} : { label: authored.label }),
      ...(authored.stage === undefined ? {} : { stage: authored.stage }),
      cwd: activation.cwd,
      model: context.settings.model,
      ...(context.settings.effort === undefined ? {} : { effort: context.settings.effort }),
      ...(authored.cause === undefined ? {} : { cause: authored.cause }),
      ...(shown.length === 0 ? {} : { messages: shown }),
      outcome: "hang",
    };
    turns.push(record);
    open.add(record);

    // A reply or a failure settles the send awaiting it, and resumes the script that awaits it.
    const settled: [Awaiting, MessageOutcome][] = [];
    for (const each of delivered) {
      if (each.kind === "message" && !each.answers) continue;
      const at = operation.awaiting.findIndex((awaiting) => awaiting.peer === each.from);
      if (at === -1) continue;
      const [awaiting] = operation.awaiting.splice(at, 1);
      settled.push([
        awaiting!,
        each.kind === "message"
          ? { kind: "replied", text: each.text }
          : { kind: "failed", reason: each.reason },
      ]);
    }
    const { suspended } = operation;
    if (suspended) {
      if (!settled.some(([awaiting]) => awaiting.by === suspended)) {
        open.delete(record);
        return failTest(
          `agent "${activation.key}" turn ${n}: the test host cannot script this: its script awaits a reply, and a turn came without it: ${
            shown.find((each) => each.asks)
              ? `${shown.find((each) => each.asks)!.from} asked it a question`
              : "it was reminded of a reply it owes"
          }; a script that awaits does nothing until its reply comes`,
        );
      }
      operation.suspended = undefined;
      suspended.state = "running";
      suspended.stopped = Promise.withResolvers();
      (suspended.turn.messages as Message[]).push(...shown);
      for (const [awaiting, outcome] of settled) awaiting.resolve(outcome);
      return until(suspended, context, record);
    }
    for (const [awaiting, outcome] of settled) awaiting.resolve(outcome);
    if (authored.cause && shown.length === 0 && operation.woke === undefined) {
      open.delete(record);
      return failTest(`agent "${activation.key}" turn ${n}: woken with no message`);
    }
    return until(invoke(context, operation, record, shown), context, record);
  };

  const side = (placement: AgentPlacement) =>
    createSingleSessionHostFactory(
      createFakeAdapter({
        harnesses: PLACEMENT_HARNESSES[placement],
        supportsWaiting: (activation) =>
          placement === "pane" &&
          activation.execution.harness === "claude" &&
          !activation.execution.caller,
        placement,
        launchesInSandbox: true,
        givesSkills: true,
        refuse: (activation: HarnessActivation) =>
          placement === "headless" ? headlessRefusal(activation) : paneRefusal(activation),
        // As the real hosts: each continues a forked session, and forks where the harness can.
        continues: true as const,
        forks: (activation: HarnessActivation) =>
          findHarness(activation.execution.harness)?.forkSession !== undefined,
        onFork: ({ activation, sessionRef }: FakeFork) =>
          forks.set(sessionRef, {
            key: activation.key,
            turns: counts.get(activation.key) ?? 0,
          }),
        // As the real hosts: each switches where the harness can, in its placement.
        sets: (activation: HarnessActivation) =>
          settingsRefusal(activation.execution) === undefined,
        onSet: ({ activation, settings }: FakeSet) => {
          sets.push({
            agent: activation.key,
            n: sets.filter((set) => set.agent === activation.key).length + 1,
            ...settings,
          });
          events.onActivity();
          return undefined;
        },
        script,
      }),
    );
  const placed = createPlacementHostFactory({
    pane: side("pane"),
    headless: side("headless"),
    ...(caller && caller.here !== false
      ? {
          caller: {
            caller: { harness: caller.harness, cwd: caller.cwd },
            calling,
            openRun: (spec) =>
              createSingleSessionHostFactory(
                createFakeAdapter({
                  harnesses: [caller.harness],
                  placement: "pane",
                  script: (context) => {
                    callerKey = context.activation.key;
                    return script(context);
                  },
                  ...(typeof calling === "object" ? { found: calling } : {}),
                }),
              ).openRun(spec),
          },
        }
      : calling
        ? { calling }
        : {}),
  });

  return {
    factory: {
      ...(placed.caller ? { caller: placed.caller } : {}),
      ...(placed.calling ? { calling: placed.calling } : {}),
      async openRun(spec) {
        const run = await placed.openRun(spec);
        return {
          inspect: () => run.inspect(),
          close: (reason) => run.close(reason),
          async openAgent(request) {
            const session = await run.openAgent(request);
            const opened: OpenedAgent = {
              key: request.key,
              execution: request.execution,
              ...(request.instructions ? { instructions: request.instructions } : {}),
              ...(request.labels ? { labels: request.labels } : {}),
              ...(request.skills ? { skills: request.skills.names } : {}),
              ...(request.continues && forks.has(request.continues.sessionRef)
                ? { forkedFrom: forks.get(request.continues.sessionRef)! }
                : {}),
              ...(request.layout ? { layout: request.layout } : {}),
              ...(request.layoutFallback ? { layoutFallback: request.layoutFallback } : {}),
              ...(request.keepPane ? { keepPane: request.keepPane } : {}),
            };
            agents.push(opened);
            return {
              ...session,
              close(reason, options) {
                if (options?.keep) opened.keptPane = true;
                abandon(request.key);
                return session.close(reason, options);
              },
            };
          },
        };
      },
    },
    turns,
    compactions,
    sets,
    agents,
    inFlight: () => [...open],
  };
}

/** A call's state across its turns: the sends its scripts await, and a script awaiting one. */
type Operation = {
  agent: string;
  binding: NonNullable<FakeAdapterTurnContext["binding"]>;
  /** Sends awaiting a reply, oldest first. */
  awaiting: Awaiting[];
  /** The script whose turn ended awaiting a reply, which the turn that carries it resumes. */
  suspended?: Invocation;
  /** The call's place among its agent's workflow turns, or among its message operations. */
  workflow?: number;
  message?: number;
  /** The message a message operation last ran its script with, for a reminder. */
  woke?: Message;
};

type Awaiting = { peer: string; by: Invocation; resolve(outcome: MessageOutcome): void };

/** One run of a script, which may outlast its native turn while it awaits a reply. */
type Invocation = {
  operation: Operation;
  turn: Turn;
  /** Its `wf` calls in flight. */
  calls: Set<Promise<unknown>>;
  state: "running" | "suspended" | "settled" | "cancelled";
  /** Where it stopped in its current native turn. */
  stopped: PromiseWithResolvers<"suspended" | { step: Step }>;
};

const MESSAGE_CODES = new Set<string>([...SEND_CODES, ...REPLY_CODES]);
/** The call ended before the script's answer reached it: the turn was let go, not refused. */
const CLOSED_CODES = new Set<string>([
  "closed-operation",
  "expired-operation",
  "unknown-operation",
]);

function settle(
  operation: Operation,
  which: (awaiting: Awaiting) => boolean,
  outcome: MessageOutcome,
): void {
  const settling = operation.awaiting.filter(which);
  operation.awaiting = operation.awaiting.filter((each) => !which(each));
  for (const awaiting of settling) awaiting.resolve(outcome);
}

async function noMessages(): Promise<MessageOutcome> {
  throw new Error("a compaction sends no messages");
}

/** What the pane host refuses before it opens a pane. */
function paneRefusal(activation: HarnessActivation): string | undefined {
  const { harness } = activation.execution;
  const spec = findHarness(harness);
  if (activation.continues && spec && !spec.interactiveResume) {
    return `${harness} panes cannot continue a forked session: ${spec.absent.interactiveResume}`;
  }
  return undefined;
}

function whenAborted(signal: AbortSignal): Promise<"cancelled"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("cancelled");
    else signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
  });
}

function refusedCompaction(activation: HarnessActivation, hasRun: boolean): string | undefined {
  if (activation.execution.caller) {
    return "the calling session's context is the operator's, so a run does not compact it";
  }
  const spec = findHarness(activation.execution.harness);
  const capability =
    placementOf(activation.execution) === "pane" ? "compactPane" : "compactHeadless";
  if (spec && !spec[capability]) {
    return `${activation.execution.harness} has no compaction of its own: ${spec.absent[capability]}`;
  }
  if (!hasRun) return "there is nothing to compact before the first turn";
  return undefined;
}

type Ended = Exclude<
  Extract<Step, { kind: "reply" }>["ending"],
  { kind: "waiting" | "hang" | "interrupted" }
>;

/** A scripted ending as the agent's harness reports it. */
function ended(ending: Ended, harness: string): FakeAdapterTurn {
  if (ending.kind === "silent") return {};
  if (ending.kind !== "needs-login") return { state: ending.kind, detail: ending.reason };
  const check = findHarness(harness)?.login;
  const provider = ending.provider === undefined ? {} : { provider: ending.provider };
  return check
    ? {
        state: "failed",
        ...loginFailure(harness, check, { ...provider, said: "reply.needsLogin()" }),
      }
    : {
        state: "failed",
        detail: `${harness} needs a login`,
        login: { harness, ...provider, run: "log in" },
      };
}
