import type {
  MessageLimits,
  MessagingEvent,
  RequestEnd,
  RouteEnds,
  UndeliveredReason,
} from "@agentswf/contract/records";
import type { PeerView, ReplyCode, SendCode } from "@agentswf/contract/wire";
import type { AgentKey } from "@agentswf/contract/workflow";
import type { AuthoredMessage } from "@agentswf/harness/adapter";
import { MESSAGE_LIMITS } from "./limits";
import {
  directions,
  pairKey,
  peerOf,
  purposeProblem,
  type Route,
  type Scope,
  sameGrant,
} from "./routes";
import {
  clock,
  type Delivered,
  envelope,
  owingLine,
  peersTable,
  type Recipient,
  type RouteLine,
  reminder,
  routeLesson,
} from "./text";

/** An agent as the runner sees it. */
export type AgentView = {
  state: "not-started" | "working" | "idle" | "stopped";
  /** Why it stopped. */
  reason?: string;
  /** The session the run was started from, which takes no part in messaging yet. */
  caller?: true;
};

/** What the logic asks of the runner, and tells it. */
export interface MessagingHost {
  /** An agent the workflow opened; undefined for any other key. */
  agent(key: AgentKey): AgentView | undefined;
  /** Whether it may `--await-reply` where it runs. */
  canAwait(key: AgentKey): boolean;
  /** The launcher it runs `wf` through. */
  launcher(key: AgentKey): string;
  /** Something is new for this agent: messages for it, or an end to its wait. */
  changed(key: AgentKey): void;
  schedule(at: number, action: () => void): () => void;
  now(): number;
  /** Written to the run's event log; `message-sent` is awaited before a send is acknowledged. */
  record(event: MessagingEventBody): Promise<void>;
}

type Body<E> = E extends unknown ? Omit<E, "callPath"> : never;
/** A messaging event as this logic writes it; the runner adds the call path and the log the rest. */
export type MessagingEventBody = Body<MessagingEvent>;

/** An operation as messaging sees it: one at a time on each agent. */
export type OperationInfo = {
  id: string;
  agent: AgentKey;
  /** A workflow's own `run`, or one a message opened. */
  kind: "workflow" | "message";
  /** Unix milliseconds; a message operation's may move later. */
  deadline: number;
  /** The latest its deadline may move to: the run's. */
  ceiling: number;
  /** The scope it runs in: its route's for a message operation, the stage's for a `run`. */
  scope: Scope;
};

/** How an operation ended, as far as its waits and debts go. */
export type OperationEnd = "result" | "settled" | "cancelled" | "failed" | "timed-out";

export type MessageRequest = {
  peer: AgentKey;
  text: string;
  awaitReply?: true;
  timeoutMs?: number;
};

export type Admission =
  | { kind: "sent"; message: number; until?: number; notice: string }
  | { kind: "refused"; code: SendCode | ReplyCode; error: string };

/** A delivery taken for an operation: its prompt text, and the messages as the test host reads them. */
export type Delivery = {
  text: string;
  messages: AuthoredMessage[];
  /** The record's numbers of the messages in it. */
  numbers: number[];
  /**
   * A message operation's deadline, moved later for the askers whose questions it now carries: the
   * later of its own and theirs, never past the run's. Absent when it did not move.
   */
  deadline?: number;
};

/** What is held for an operation whose turn has ended, without deciding anything. */
export type Pending = "continues" | "held" | "none";

/** What a turn that ended without a result goes on to, in the design's order. */
export type TurnEnd =
  /** Something continues it now: an answer, a failure, a question, or held messages. */
  | { kind: "continue" }
  /** It awaits `peer`'s answer until `until`: nothing runs, a pane stays, a headless process exits. */
  | { kind: "wait"; peer: AgentKey; until: number }
  /** It owes answers: the one reminder, as its next prompt. */
  | { kind: "remind"; text: string }
  /** A workflow's operation with nothing owed or held: 021's check-in. */
  | { kind: "check-in" }
  /** A message operation that is done. */
  | { kind: "settle" };

type Message = {
  readonly kind: "message";
  readonly n: number;
  readonly from: AgentKey;
  readonly to: AgentKey;
  readonly text: string;
  readonly bytes: number;
  readonly route: Route;
  /** The question it asks, owed by `to`. */
  asks?: Obligation;
  /** The question it answers. */
  readonly answers?: Obligation;
  shown: boolean;
  /** The operation it was shown in. */
  shownIn?: Operation;
};

type Obligation = {
  readonly request: Message;
  readonly asker: AgentKey;
  readonly askerOperation: Operation;
  readonly owedBy: AgentKey;
  /** The operation it was shown in, which owes it. */
  owingOperation?: Operation;
  /** Its owing operation was reminded of it once; the next turn's end that still owes fails it. */
  reminded?: true;
  /** The asker waits until then: its `--timeout`, or its operation's deadline as that moves. */
  until: number;
  /** It has a `--timeout` of its own, which only that fails it at. */
  readonly timed: boolean;
  state: "open" | RequestEnd;
  /** Its end, set once; a reply after it is refused `expired`. */
  endedAt?: number;
  cancelTimer?: () => void;
};

type Failure = { kind: "no-reply"; for: Operation; from: AgentKey; reason: string };
type Held = Message | Failure;

type Operation = OperationInfo & {
  awaits?: Obligation;
  readonly owes: Set<Obligation>;
  /** Routes it has been told of: those open when it began, and each announced since. */
  readonly told: Set<Route>;
  ended: boolean;
};

/**
 * The messaging logic of one attempt: routes, admission, inboxes and owed answers. It decides every
 * case the design lists and writes the record; it starts nothing. The runner opens and continues
 * operations when it says, and the control plane hands it `wf`'s commands.
 */
export class Messaging {
  readonly limits: MessageLimits;
  readonly #host: MessagingHost;
  readonly attempt: Scope = { id: 0, state: "open" };
  #scopes = 0;
  #grants = 0;
  #messages = 0;
  /** Every route granted in the attempt, open or closed, by each pair it carries. */
  readonly #routes = new Map<string, Route[]>();
  readonly #inboxes = new Map<AgentKey, Held[]>();
  readonly #current = new Map<AgentKey, Operation>();
  readonly #operations = new Map<string, Operation>();
  /** Every question asked in the attempt, in order. */
  readonly #obligations: Obligation[] = [];
  /** Every message admitted, by its number. */
  readonly #sentBy = new Map<number, Message>();
  #closed = false;

  constructor(host: MessagingHost, limits: MessageLimits = MESSAGE_LIMITS) {
    this.#host = host;
    this.limits = limits;
  }

  scope(stage: string): Scope {
    return { id: ++this.#scopes, stage, state: "open" };
  }

  // Routes

  /**
   * Grants a route in `scope`, atomically: anything invalid rejects with nothing granted. Granting
   * the same route again does nothing; another route over an open pair rejects.
   */
  grant(ends: RouteEnds, options: { purpose: unknown; maxMessages?: unknown; scope: Scope }): void {
    const { scope } = options;
    if (this.#closed || scope.state !== "open")
      throw new Error("routes are granted only while a scope is open");
    const problem = purposeProblem(options.purpose);
    if (problem) throw new Error(problem);
    const purpose = options.purpose as string;
    const requested = options.maxMessages;
    if (
      requested !== undefined &&
      (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1)
    )
      throw new Error("a route's maxMessages is a positive whole number");
    const pairs = directions(ends);
    for (const [from, to] of pairs) {
      if (from === to) throw new Error(`a route from ${from} to itself is not allowed`);
      for (const key of [from, to]) {
        const agent = this.#host.agent(key);
        if (!agent) throw new Error(`${key} is not an agent this workflow opened`);
        if (agent.caller)
          throw new Error(`${key} is the calling session, which cannot take part in messaging yet`);
        if (agent.state === "stopped") throw new Error(`${key} has stopped`);
      }
    }
    const open = pairs.map(([from, to]) => this.#open(from, to));
    if (open.some(Boolean)) {
      if (
        open.every(
          (route) =>
            route && sameGrant(route, ends, purpose, requested as number | undefined, scope),
        ) &&
        new Set(open).size === 1
      )
        return;
      const [from, to] = pairs[open.findIndex(Boolean)]!;
      throw new Error(
        `${from} and ${to} already have an open route; grant the same route, or one after it closes`,
      );
    }
    const asked = requested as number | undefined;
    const maxMessages = Math.min(asked ?? this.limits.perRoute, this.limits.perRoute);
    const route: Route = {
      ends,
      purpose,
      maxMessages,
      ...(asked !== undefined && asked > maxMessages ? { asked } : {}),
      ...(asked === undefined ? {} : { requested: asked }),
      scope,
      count: 0,
      open: true,
      order: ++this.#grants,
    };
    for (const [from, to] of pairs) {
      const key = pairKey(from, to);
      this.#routes.set(key, [...(this.#routes.get(key) ?? []), route]);
    }
    void this.#record({
      kind: "route-opened",
      ...ends,
      purpose,
      maxMessages,
      ...(route.asked === undefined ? {} : { asked: route.asked }),
      ...(scope.stage === undefined ? {} : { stage: scope.stage }),
    });
    for (const agent of new Set(pairs.flat())) this.#host.changed(agent);
  }

  /**
   * The stage's function returned: its routes take no new messages, though an answer still goes. A
   * message held for an agent busy outside the stage is undelivered: it would reach it only after
   * the stage had ended.
   */
  finishing(scope: Scope): void {
    if (scope.state !== "open") return;
    scope.state = "finishing";
    for (const [agent, held] of this.#inboxes) {
      const busy = this.#current.get(agent);
      if (!busy || busy.scope === scope) continue;
      this.#drop(
        agent,
        held.filter(
          (item): item is Message =>
            item.kind === "message" && item.route.scope === scope && !item.answers,
        ),
        `its stage ${scope.stage ?? ""} finished before ${agent} saw the question`.replace(
          "  ",
          " ",
        ),
      );
    }
  }

  /** The stage has ended: its routes close, and what they still held is undelivered. */
  closeScope(scope: Scope): void {
    scope.state = "closed";
    for (const route of this.#openRoutes()) {
      if (route.scope === scope) this.#closeRoute(route, "stage-ended");
    }
  }

  /**
   * Whether anything on `scope`'s routes is still in flight: a question not yet answered, or a
   * message held for an agent. A stage waits for this, as well as for the operations it owns.
   */
  busy(scope: Scope): boolean {
    const onScope = (message: Message) => message.route.scope === scope;
    if (this.#obligations.some((each) => each.state === "open" && onScope(each.request)))
      return true;
    for (const held of this.#inboxes.values()) {
      if (held.some((item) => item.kind !== "no-reply" && onScope(item))) return true;
    }
    return false;
  }

  // Operations

  /** An operation began on its agent; its routes so far are the ones its prompt teaches. */
  opened(info: OperationInfo): void {
    const operation: Operation = {
      ...info,
      owes: new Set(),
      told: new Set(this.#routesOf(info.agent)),
      ended: false,
    };
    this.#operations.set(info.id, operation);
    this.#current.set(info.agent, operation);
  }

  /** A message operation's deadline moved later, and with it any wait it has no `--timeout` for. */
  extended(id: string, deadline: number): void {
    const operation = this.#operations.get(id);
    if (!operation || deadline <= operation.deadline) return;
    operation.deadline = deadline;
    const waited = operation.awaits;
    if (waited?.state === "open" && !waited.timed) waited.until = deadline;
  }

  /**
   * An operation ended: its wait is dropped and what it still owed fails. A result while it awaited
   * an answer drops the wait, as a cancellation does.
   */
  ended(id: string, how: OperationEnd): void {
    const operation = this.#operations.get(id);
    if (!operation || operation.ended) return;
    operation.ended = true;
    if (this.#current.get(operation.agent) === operation) this.#current.delete(operation.agent);
    const waited = operation.awaits;
    operation.awaits = undefined;
    if (waited?.state === "open") {
      this.#end(
        waited,
        waited.request.shown ? "released" : "withdrawn",
        `${operation.agent} finished first`,
      );
    }
    // An answer accepted but not yet shown is withdrawn with it.
    this.#withdrawHeldFor(operation);
    for (const owed of [...operation.owes]) {
      this.#end(
        owed,
        "failed",
        how === "settled" || how === "result"
          ? "it did not reply"
          : `its operation ${how === "cancelled" ? "was cancelled" : how === "timed-out" ? "timed out" : "failed"} before it replied`,
      );
    }
  }

  /** The operation open on this agent, if any. */
  current(agent: AgentKey): OperationInfo | undefined {
    return this.#current.get(agent);
  }

  /**
   * A refusal of `wf result` or `wf waiting` given this call id, or the acknowledgement of a
   * `wf waiting` while an answer is awaited; null when the command goes on as before.
   */
  checkFinish(
    agent: AgentKey,
    id: string,
    command: "result" | "waiting",
  ):
    | { kind: "refused"; code: "owes-reply" | "no-result"; error: string }
    | { kind: "awaiting"; peer: AgentKey; until: number; notice: string }
    | null {
    const operation = this.#operations.get(id);
    if (!operation || operation.agent !== agent || operation.ended) return null;
    const wf = this.#host.launcher(agent);
    if (operation.kind === "message") {
      return {
        kind: "refused",
        code: "no-result",
        error: `call ${id} is a message, not a task: it takes no result and cannot wait. ${this.#owes(operation).length ? "Reply, then end your turn." : "End your turn."}`,
      };
    }
    const owes = this.#owes(operation);
    if (owes.length > 0) {
      const peer = owes[0]!;
      return {
        kind: "refused",
        code: "owes-reply",
        error:
          command === "result"
            ? `you owe ${peer} a reply. Send it with ${wf} reply ${peer}, then run ${wf} result ${id} again.`
            : `you owe ${peer} a reply; send it with ${wf} reply ${peer} first.`,
      };
    }
    const waited = operation.awaits;
    if (command === "waiting" && waited?.state === "open") {
      return {
        kind: "awaiting",
        peer: waited.owedBy,
        until: waited.until,
        notice: `you already await ${waited.owedBy}'s reply, until ${clock(waited.until, this.#host.now())}. End your turn, or finish with ${wf} result ${id}.`,
      };
    }
    return null;
  }

  // Sending

  async send(from: AgentKey, request: MessageRequest): Promise<Admission> {
    const checked = this.#checkSend(from, request);
    if (checked.kind === "refused") return this.#refused(from, request, "send", checked);
    const { operation, route, bytes } = checked;
    const message = this.#admit(from, request.peer, request.text, bytes, route);
    const until = request.awaitReply ? this.#ask(message, operation, request.timeoutMs) : undefined;
    await this.#sent(message, operation);
    this.#host.changed(request.peer);
    return {
      kind: "sent",
      message: message.n,
      ...(until === undefined ? {} : { until }),
      notice: this.#sentNotice(request.peer, operation, until),
    };
  }

  async reply(from: AgentKey, request: MessageRequest): Promise<Admission> {
    const checked = this.#checkReply(from, request);
    if (checked.kind === "refused") return this.#refused(from, request, "reply", checked);
    const { operation, owed, bytes } = checked;
    // Accepting it settles the question: a timeout after this changes nothing.
    owed.state = "replied";
    owed.endedAt = this.#host.now();
    owed.cancelTimer?.();
    owed.owingOperation?.owes.delete(owed);
    if (owed.askerOperation.awaits === owed) owed.askerOperation.awaits = undefined;
    const message = this.#admit(from, owed.asker, request.text, bytes, owed.request.route, owed);
    const until = request.awaitReply ? this.#ask(message, operation, request.timeoutMs) : undefined;
    await this.#sent(message, operation);
    void this.#record({
      kind: "request-ended",
      message: owed.request.n,
      owedBy: owed.owedBy,
      asker: owed.asker,
      end: "replied",
      reply: message.n,
    });
    this.#host.changed(owed.asker);
    const asked = until === undefined ? "" : ` ${this.#awaitNotice(operation, until)}`;
    return {
      kind: "sent",
      message: message.n,
      ...(until === undefined ? {} : { until }),
      notice: `replied to ${request.peer}.${asked}`,
    };
  }

  #checkSend(
    from: AgentKey,
    request: MessageRequest,
  ):
    | { kind: "ok"; operation: Operation; route: Route; bytes: number }
    | { kind: "refused"; code: SendCode; error: string } {
    const wf = this.#host.launcher(from);
    const operation = this.#current.get(from);
    if (!operation) return refuse("no-operation", "this agent has no open operation.");
    const { peer } = request;
    // Keyed by direction: every route here is one `from` may start a conversation on.
    const initiating = this.#routes.get(pairKey(from, peer)) ?? [];
    const replyOnly = () => {
      const owes = this.#owes(operation).includes(peer);
      return refuse(
        "no-route",
        owes
          ? `your route with ${peer} only answers its requests. Answer it with ${wf} reply ${peer}.`
          : `your route with ${peer} only answers its requests, and it asked nothing. Nothing to send; end your turn.`,
      );
    };
    if (initiating.length === 0) {
      return this.#open(peer, from)
        ? replyOnly()
        : refuse("no-route", `no route to ${peer}. Your routes: ${wf} peers`);
    }
    const agent = this.#host.agent(peer);
    if (agent?.state === "stopped")
      return refuse(
        "peer-stopped",
        `${peer} has stopped${agent.reason ? ` (${JSON.stringify(agent.reason)})` : ""}.`,
      );
    const route = initiating.find((each) => each.open);
    if (!route) {
      if (this.#open(peer, from)) return replyOnly();
      const last = initiating.at(-1)!;
      return refuse(
        "closed",
        `the route to ${peer} closed${last.scope.stage ? ` when its stage ${last.scope.stage} ended` : ""}.`,
      );
    }
    if (route.scope.state !== "open" || this.#closed) {
      return refuse(
        "closed",
        `${route.scope.stage ? `stage ${route.scope.stage}` : "the workflow"} is finishing; it takes no new messages. ${this.#sayIt(operation, "Say so in your result.")}`,
      );
    }
    const bytes = Buffer.byteLength(request.text);
    if (bytes > this.limits.bytes) {
      return refuse(
        "too-large",
        `${Math.ceil(bytes / 1024)} KB; the limit is ${this.limits.bytes / 1024} KB. Put it in a file and send its path.`,
      );
    }
    if (request.awaitReply) {
      const asking = this.#checkAsk(from, peer, operation);
      if (asking) return asking;
    }
    if (route.count + (request.awaitReply ? 2 : 1) > route.maxMessages) {
      return refuse(
        "limit",
        `${route.maxMessages} messages with ${peer}, this route's limit${request.awaitReply && route.count + 1 <= route.maxMessages ? ", with room for a message but not a question and its reply" : ""}. ${this.#sayIt(operation, "Say so in your result.")}`,
      );
    }
    const unread = this.#unread(peer);
    if (unread >= this.limits.unread) {
      return refuse(
        "inbox-full",
        `${peer} has ${unread} unread messages. Try again after its turn ends, or ${this.#sayIt(operation, "say so in your result.", true)}`,
      );
    }
    return { kind: "ok", operation, route, bytes };
  }

  #checkReply(
    from: AgentKey,
    request: MessageRequest,
  ):
    | { kind: "ok"; operation: Operation; owed: Obligation; bytes: number }
    | { kind: "refused"; code: ReplyCode; error: string } {
    const wf = this.#host.launcher(from);
    const operation = this.#current.get(from);
    if (!operation) return refuse("no-operation", "this agent has no open operation.");
    const { peer } = request;
    // The latest question from that peer to this agent in the attempt.
    const latest = this.#obligations.findLast(
      (each) => each.asker === peer && each.owedBy === from && each.request.shown,
    );
    if (!latest || latest.state === "replied") {
      return refuse("none-owed", `you owe ${peer} nothing. Send it with ${wf} send ${peer}.`);
    }
    if (latest.state !== "open" || latest.owingOperation !== operation) {
      const agent = this.#host.agent(peer);
      return refuse(
        "expired",
        agent?.state === "stopped"
          ? `${peer} has stopped${agent.reason ? ` (${JSON.stringify(agent.reason)})` : ""}; nothing reaches it now.`
          : `${peer} stopped waiting at ${clock(latest.endedAt ?? this.#host.now(), this.#host.now())}. Send it with ${wf} send ${peer}.`,
      );
    }
    const route = latest.request.route;
    if (!route.open)
      return refuse(
        "closed",
        `the route to ${peer} closed${route.scope.stage ? ` when its stage ${route.scope.stage} ended` : ""}.`,
      );
    if (request.awaitReply && route.scope.state !== "open") {
      return refuse(
        "closed",
        `${route.scope.stage ? `stage ${route.scope.stage}` : "the workflow"} is finishing; reply without --await-reply.`,
      );
    }
    const bytes = Buffer.byteLength(request.text);
    if (bytes > this.limits.bytes) {
      return refuse(
        "too-large",
        `${Math.ceil(bytes / 1024)} KB; the limit is ${this.limits.bytes / 1024} KB. Put it in a file and send its path.`,
      );
    }
    if (request.awaitReply) {
      const asking = this.#checkAsk(from, peer, operation, latest);
      if (asking) return asking;
      // The reply's own room was reserved with its question; asking back needs room for an answer.
      if (route.count + 1 > route.maxMessages) {
        return refuse(
          "limit",
          `${route.maxMessages} messages with ${peer}, this route's limit: room for your reply, not for asking back. Reply without --await-reply.`,
        );
      }
    }
    return { kind: "ok", operation, owed: latest, bytes };
  }

  /** `awaiting`, `unsupported` and `cycle`, checked for any question. */
  #checkAsk(
    from: AgentKey,
    peer: AgentKey,
    operation: Operation,
    /** The question a reply answers, which counts as answered here. */
    answering?: Obligation,
  ): { kind: "refused"; code: "awaiting" | "unsupported" | "cycle"; error: string } | undefined {
    const wf = this.#host.launcher(from);
    if (operation.awaits?.state === "open") {
      return refuse(
        "awaiting",
        `you already await ${operation.awaits.owedBy}. End your turn, or send without --await-reply.`,
      );
    }
    if (!this.#host.canAwait(from)) {
      return refuse(
        "unsupported",
        "this agent cannot await a reply here. Send without --await-reply and say where the answer should go, such as a file.",
      );
    }
    // Follow the open waits from the peer: one that leads back here would hold every agent on it
    // until a deadline stopped them.
    const chain: AgentKey[] = [];
    let at: AgentKey | undefined = peer;
    const seen = new Set<AgentKey>();
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      const waited: Obligation | undefined = this.#current.get(at)?.awaits;
      if (waited?.state !== "open" || waited === answering) break;
      chain.push(at);
      if (waited.owedBy === from) {
        const last = at;
        const through = chain.slice(1);
        const who =
          through.length === 0
            ? `${peer} already waits on you`
            : `${peer} already waits, through ${through.join(", ")}, on you`;
        const owing = waited.request.shown;
        return refuse(
          "cycle",
          owing
            ? `${who}, and you owe ${last === peer ? "it" : last} a reply. Answer with ${wf} reply ${last}; it may --await-reply.`
            : `${who}. Send without --await-reply and end your turn; ${last}'s request reaches you then.`,
        );
      }
      at = waited.owedBy;
    }
    return undefined;
  }

  #refused(
    from: AgentKey,
    request: MessageRequest,
    command: "send" | "reply",
    refusal: { code: SendCode | ReplyCode; error: string },
  ): Admission {
    const operation = this.#current.get(from);
    void this.#record({
      kind: "message-refused",
      from,
      to: request.peer,
      ...(operation ? { operationId: operation.id } : {}),
      command,
      code: refusal.code,
      bytes: Buffer.byteLength(request.text),
      ...(request.awaitReply ? { awaitReply: true as const } : {}),
    });
    return { kind: "refused", code: refusal.code, error: refusal.error };
  }

  #admit(
    from: AgentKey,
    to: AgentKey,
    text: string,
    bytes: number,
    route: Route,
    answers?: Obligation,
  ): Message {
    const message: Message = {
      kind: "message",
      n: ++this.#messages,
      from,
      to,
      text,
      bytes,
      route,
      ...(answers ? { answers } : {}),
      shown: false,
    };
    // An answer's room was reserved when it was asked.
    if (!answers) route.count += 1;
    this.#inbox(to).push(message);
    this.#sentBy.set(message.n, message);
    return message;
  }

  /** Makes `message` a question its recipient owes an answer to, and its sender's wait. */
  #ask(message: Message, operation: Operation, timeoutMs?: number): number {
    message.route.count += 1;
    const now = this.#host.now();
    const until = Math.min(
      operation.deadline,
      timeoutMs === undefined ? Infinity : now + timeoutMs,
    );
    const obligation: Obligation = {
      request: message,
      asker: message.from,
      askerOperation: operation,
      owedBy: message.to,
      until,
      timed: until < operation.deadline,
      state: "open",
    };
    message.asks = obligation;
    operation.awaits = obligation;
    this.#obligations.push(obligation);
    // Only `--timeout` fails a question: reaching the operation's own deadline times it out.
    if (obligation.timed) {
      obligation.cancelTimer = this.#host.schedule(until, () => {
        if (obligation.state === "open") {
          this.#end(
            obligation,
            "timed-out",
            `your --timeout passed at ${clock(until, this.#host.now())}`,
          );
        }
      });
    }
    return until;
  }

  /** Durable before `wf send` returns: a failed write rejects, and `wf` says it may have been queued. */
  async #sent(message: Message, operation: Operation): Promise<void> {
    await this.#host.record({
      kind: "message-sent",
      message: message.n,
      from: message.from,
      to: message.to,
      operationId: operation.id,
      text: message.text,
      bytes: message.bytes,
      ...(message.asks
        ? { awaitsReply: { until: new Date(message.asks.until).toISOString() } }
        : {}),
      ...(message.answers ? { replyTo: message.answers.request.n } : {}),
    });
  }

  #sentNotice(peer: AgentKey, operation: Operation, until?: number): string {
    if (until !== undefined) return `sent to ${peer}. ${this.#awaitNotice(operation, until)}`;
    const state = this.#host.agent(peer)?.state;
    const when =
      this.#current.get(peer)?.awaits?.state === "open"
        ? "it reads this with the reply it awaits"
        : state === "not-started"
          ? "it has not run, so this starts its first turn"
          : state === "idle"
            ? "it is idle, so this wakes it"
            : "it reads this when its current turn ends";
    return `sent to ${peer}; ${when}.`;
  }

  #awaitNotice(operation: Operation, until: number): string {
    const wf = this.#host.launcher(operation.agent);
    return [
      `Its reply starts your next turn (deadline ${clock(until, this.#host.now())}).`,
      "Go on with work that does not need the answer, then end your turn with one line saying what you await; do not poll or sleep.",
      ...(operation.kind === "workflow"
        ? [
            `If you find the answer first, or decide not to wait, finish with ${wf} result ${operation.id}; the wait is dropped.`,
          ]
        : []),
    ].join("\n");
  }

  // Delivering

  /**
   * Whether a message is held that would open a message operation on this idle agent, and the
   * route it came by, whose sender is the operation's cause and whose scope owns it.
   */
  opening(agent: AgentKey): { from: AgentKey; scope: Scope } | undefined {
    const first = this.#inbox(agent).find((item): item is Message => item.kind !== "no-reply");
    return first && { from: first.from, scope: first.route.scope };
  }

  /**
   * Takes what is held for this operation, marks it shown and returns its text. `opens`, a new
   * message operation, takes the first route's messages alone; continuing an operation or joining a
   * workflow's `run` takes everything held. Questions shown become this operation's to answer.
   * Undefined when nothing is held to take.
   */
  take(id: string, how: "opens" | "continues" | "joins"): Delivery | undefined {
    const operation = this.#operations.get(id);
    if (!operation || operation.ended) return undefined;
    const inbox = this.#inbox(operation.agent);
    const first = inbox.find((item): item is Message => item.kind !== "no-reply");
    const taken = inbox.filter((item) =>
      item.kind === "no-reply"
        ? item.for === operation
        : how !== "opens" || item.route === first?.route,
    );
    if (taken.length === 0) return undefined;
    this.#inboxes.set(
      operation.agent,
      inbox.filter((item) => !taken.includes(item)),
    );
    const delivered: Delivered[] = [];
    const messages: AuthoredMessage[] = [];
    const numbers: number[] = [];
    for (const item of taken) {
      if (item.kind === "no-reply") {
        delivered.push(item);
        messages.push({ kind: "no-reply", from: item.from, reason: item.reason });
        continue;
      }
      item.shown = true;
      item.shownIn = operation;
      numbers.push(item.n);
      const asks = item.asks?.state === "open" ? item.asks : undefined;
      if (asks) {
        asks.owingOperation = operation;
        operation.owes.add(asks);
      }
      const answers = item.answers?.askerOperation === operation;
      delivered.push({
        kind: "message",
        from: item.from,
        text: item.text,
        purpose: item.route.purpose,
        ...(answers ? { answers: true as const } : {}),
        ...(asks ? { asks: true as const } : {}),
      });
      messages.push({
        kind: "message",
        from: item.from,
        text: item.text,
        ...(answers ? { answers: true as const } : {}),
        ...(asks ? { asks: true as const } : {}),
      });
      void this.#record({
        kind: "message-delivery",
        message: item.n,
        from: item.from,
        to: item.to,
        operationId: operation.id,
        state: "offered",
      });
    }
    const announced = this.#routesOf(operation.agent).filter((route) => !operation.told.has(route));
    for (const route of announced) operation.told.add(route);
    const text = envelope(delivered, this.#recipient(operation), {
      ...(how === "opens" ? { opens: true } : {}),
      ...(how === "opens"
        ? {}
        : { announced: announced.map((route) => this.#line(route, operation.agent)) }),
    });
    // A message operation opens on its routes' lesson, as a workflow's `run` does.
    const lesson = how === "opens" ? this.lesson(operation.agent) : "";
    const deadline = this.#deadlineFor(operation);
    if (deadline !== undefined) this.extended(operation.id, deadline);
    return {
      text: lesson ? `${lesson}\n\n${text}` : text,
      messages,
      numbers,
      ...(deadline === undefined ? {} : { deadline }),
    };
  }

  /**
   * A message operation's deadline for the questions it carries: the latest of its askers', if
   * later than its own, never past its ceiling.
   */
  #deadlineFor(operation: Operation): number | undefined {
    if (operation.kind !== "message") return undefined;
    const wanted = Math.min(
      operation.ceiling,
      Math.max(
        operation.deadline,
        ...[...operation.owes].map((owed) => owed.askerOperation.deadline),
      ),
    );
    return wanted > operation.deadline ? wanted : undefined;
  }

  /** What the harness confirmed of a delivery: the model read it, or nothing says it did. */
  confirmed(id: string, numbers: readonly number[], state: "observed" | "unconfirmed"): void {
    const operation = this.#operations.get(id);
    if (!operation) return;
    for (const n of numbers) {
      const sent = this.#sentBy.get(n);
      if (sent?.shownIn !== operation) continue;
      void this.#record({
        kind: "message-delivery",
        message: n,
        from: sent.from,
        to: sent.to,
        operationId: id,
        state,
      });
    }
  }

  /**
   * Where a turn that ended without a result goes, in the design's order: what continues it, a
   * wait, the one reminder, then the check-in or the end of a message operation. A reminder's turn
   * ending still owing fails what it owes.
   */
  turnEnded(id: string): TurnEnd {
    const operation = this.#operations.get(id);
    if (!operation || operation.ended)
      return { kind: operation?.kind === "message" ? "settle" : "check-in" };
    if (this.#pending(operation) === "continues") return { kind: "continue" };
    const waited = operation.awaits;
    if (waited?.state === "open") return { kind: "wait", peer: waited.owedBy, until: waited.until };
    // Each question gets one reminder; a turn that ends still owing one it was reminded of fails it.
    for (const owed of [...operation.owes]) {
      if (owed.reminded) this.#end(owed, "failed", "it did not reply after a reminder");
    }
    const unreminded = [...operation.owes].filter((owed) => owed.state === "open");
    if (unreminded.length > 0) {
      for (const owed of unreminded) owed.reminded = true;
      return {
        kind: "remind",
        text: reminder(
          unreminded.map((owed) => owed.asker),
          this.#recipient(operation),
        ),
      };
    }
    return { kind: operation.kind === "workflow" ? "check-in" : "settle" };
  }

  /**
   * What is held for an operation whose turn has ended, deciding nothing: `continues` when its turn
   * end would go on with it, `held` when messages wait for a later operation or to cut a check-in's
   * `wf waiting` short, `none` otherwise.
   */
  pending(id: string): Pending {
    const operation = this.#operations.get(id);
    return operation && !operation.ended ? this.#pending(operation) : "none";
  }

  #pending(operation: Operation): Pending {
    const held = this.#inbox(operation.agent);
    if (held.length === 0) return "none";
    const its = held.some(
      (item) =>
        (item.kind === "no-reply" && item.for === operation) ||
        (item.kind === "message" && item.answers?.askerOperation === operation),
    );
    if (its) return "continues";
    const messages = held.some((item) => item.kind === "message");
    // A waiting operation is continued by a question as well; a workflow's by anything held. A
    // message operation that waits on nothing ends, and what is held opens the next one.
    if (operation.awaits?.state === "open") {
      return held.some((item) => item.kind === "message" && item.asks?.state === "open")
        ? "continues"
        : messages
          ? "held"
          : "none";
    }
    if (operation.kind === "workflow" && messages) return "continues";
    return messages ? "held" : "none";
  }

  /** The route lesson for an operation's prompt: empty for an agent with no routes. */
  lesson(agent: AgentKey): string {
    return routeLesson(
      this.#routesOf(agent).map((route) => this.#line(route, agent)),
      this.#host.launcher(agent),
    );
  }

  // Seeing

  peers(agent: AgentKey): {
    peers: PeerView[];
    owes: AgentKey[];
    awaits?: { peer: AgentKey; until: number };
    text: string;
  } {
    const peers = this.#routesOf(agent, true).map((route): PeerView => {
      const peer = peerOf(route, agent);
      const view = this.#host.agent(peer);
      const waited = this.#current.get(peer)?.awaits;
      const awaiting = waited?.state === "open" ? waited.owedBy : undefined;
      const queued = this.#inbox(peer).filter(
        (item) => item.kind !== "no-reply" && item.from === agent,
      ).length;
      return {
        peer,
        can: this.#can(route, agent),
        state:
          view?.state === "stopped" ? "stopped" : awaiting ? "awaiting" : (view?.state ?? "idle"),
        ...(awaiting && view?.state !== "stopped" ? { awaits: awaiting } : {}),
        ...(view?.state === "stopped" && view.reason ? { reason: view.reason } : {}),
        queued,
        purpose: route.purpose,
      };
    });
    const { owes, awaits } = this.#standing(agent);
    return {
      peers,
      owes,
      ...(awaits ? { awaits } : {}),
      text: peersTable(peers, awaits, owes, this.#host.now(), agent),
    };
  }

  /** The line `wf` leads with while this agent's operation owes or awaits an answer. */
  owing(agent: AgentKey): string | undefined {
    const { owes, awaits } = this.#standing(agent);
    return owingLine(owes, awaits, this.#host.launcher(agent), this.#host.now());
  }

  // Ending

  /**
   * The agent stopped: what it asked is dropped, what it owed fails, and its routes close. Its own
   * operation's end, if the runner records one too, changes nothing after this.
   */
  agentStopped(agent: AgentKey, reason: string): void {
    for (const owed of this.#obligations) {
      if (owed.asker === agent && owed.state === "open") {
        this.#end(owed, owed.request.shown ? "released" : "withdrawn", `${agent} stopped`);
      }
      if (owed.owedBy === agent && owed.state === "open") {
        this.#end(owed, "failed", `it stopped (${JSON.stringify(reason)}) before replying`);
      }
    }
    for (const route of this.#openRoutes()) {
      if (directions(route.ends).some((pair) => pair.includes(agent))) {
        this.#closeRoute(route, "agent-stopped");
      }
    }
    for (const item of this.#inbox(agent)) {
      if (item.kind !== "no-reply") this.#undelivered(item, "route-closed");
    }
    this.#inboxes.delete(agent);
  }

  /** The attempt ended: nothing more is delivered, and what was held is recorded undelivered. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const owed of this.#obligations) {
      if (owed.state === "open")
        this.#end(owed, "failed", "the attempt ended", {
          undelivered: "attempt-ended",
          tell: false,
        });
    }
    for (const [agent, held] of this.#inboxes) {
      for (const item of held)
        if (item.kind !== "no-reply") this.#undelivered(item, "attempt-ended");
      this.#inboxes.delete(agent);
    }
    for (const route of this.#openRoutes()) this.#closeRoute(route, "attempt-ended");
  }

  // Internals

  #inbox(agent: AgentKey): Held[] {
    const held = this.#inboxes.get(agent);
    if (held) return held;
    const fresh: Held[] = [];
    this.#inboxes.set(agent, fresh);
    return fresh;
  }

  #open(from: AgentKey, to: AgentKey): Route | undefined {
    return this.#routes.get(pairKey(from, to))?.find((route) => route.open);
  }

  #openRoutes(): Route[] {
    return [...new Set([...this.#routes.values()].flat())].filter((route) => route.open);
  }

  /**
   * This agent's open routes, either end, in the order granted; with `stopped`, also those a peer's
   * stop closed, so `wf peers` can say it stopped.
   */
  #routesOf(agent: AgentKey, stopped = false): Route[] {
    return [...new Set([...this.#routes.values()].flat())]
      .filter(
        (route) =>
          (route.open || (stopped && route.closed === "agent-stopped")) &&
          directions(route.ends).some((pair) => pair.includes(agent)),
      )
      .sort((a, b) => a.order - b.order);
  }

  #can(route: Route, agent: AgentKey): PeerView["can"] {
    return route.ends.between ? "both" : route.ends.from === agent ? "send" : "reply";
  }

  #line(route: Route, agent: AgentKey): RouteLine {
    return { peer: peerOf(route, agent), can: this.#can(route, agent), purpose: route.purpose };
  }

  #recipient(operation: Operation): Recipient {
    return {
      launcher: this.#host.launcher(operation.agent),
      callId: operation.id,
      kind: operation.kind,
    };
  }

  #owes(operation: Operation): AgentKey[] {
    return [...operation.owes].filter((each) => each.state === "open").map((each) => each.asker);
  }

  #standing(agent: AgentKey): { owes: AgentKey[]; awaits?: { peer: AgentKey; until: number } } {
    const operation = this.#current.get(agent);
    if (!operation) return { owes: [] };
    const waited = operation.awaits?.state === "open" ? operation.awaits : undefined;
    return {
      owes: this.#owes(operation),
      ...(waited ? { awaits: { peer: waited.owedBy, until: waited.until } } : {}),
    };
  }

  /** Messages held for an agent that count against its unread limit: answers do not. */
  #unread(agent: AgentKey): number {
    return this.#inbox(agent).filter((item) => item.kind !== "no-reply" && !item.answers).length;
  }

  /**
   * "Say so in your result" where a workflow's operation would, "end your turn" or "say so in your
   * reply" in a message operation, which takes no result.
   */
  #sayIt(operation: Operation, workflowText: string, lower = false): string {
    if (operation.kind === "workflow") return workflowText;
    const text = this.#owes(operation).length ? "Say so in your reply." : "End your turn.";
    return lower ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  }

  /**
   * An owed answer ends without one: its asker is told, if it still waits on it. A question never
   * shown is undelivered with it, unless it is an answer that asked back: that answer still goes,
   * its question dropped. `gone`: the caller has already taken the question out and recorded it.
   */
  #end(
    owed: Obligation,
    end: Exclude<RequestEnd, "replied">,
    reason: string,
    options: { gone?: true; undelivered?: UndeliveredReason; tell?: false } = {},
  ): void {
    if (owed.state !== "open") return;
    owed.state = end;
    owed.endedAt = this.#host.now();
    owed.cancelTimer?.();
    owed.owingOperation?.owes.delete(owed);
    const { request } = owed;
    // Its reserved room goes; a question never shown no longer counts either. An answer's own room
    // was its question's.
    request.route.count -= request.shown || request.answers ? 1 : 2;
    if (!request.shown && !options.gone) {
      if (request.answers) request.asks = undefined;
      else {
        this.#inboxes.set(
          owed.owedBy,
          this.#inbox(owed.owedBy).filter((item) => item !== request),
        );
        this.#undelivered(
          request,
          options.undelivered ?? (end === "failed" ? "route-closed" : "withdrawn"),
        );
      }
    }
    void this.#record({
      kind: "request-ended",
      message: owed.request.n,
      owedBy: owed.owedBy,
      asker: owed.asker,
      end,
      reason,
    });
    const operation = owed.askerOperation;
    if (operation.awaits === owed) operation.awaits = undefined;
    if (options.tell !== false && !operation.ended && (end === "failed" || end === "timed-out")) {
      this.#inbox(owed.asker).push({ kind: "no-reply", for: operation, from: owed.owedBy, reason });
      this.#host.changed(owed.asker);
    }
  }

  #withdrawHeldFor(operation: Operation): void {
    const held = this.#inbox(operation.agent);
    const withdrawn = held.filter(
      (item) =>
        (item.kind === "no-reply" && item.for === operation) ||
        (item.kind === "message" && item.answers?.askerOperation === operation),
    );
    if (withdrawn.length === 0) return;
    this.#inboxes.set(
      operation.agent,
      held.filter((item) => !withdrawn.includes(item)),
    );
    for (const item of withdrawn) {
      if (item.kind !== "message") continue;
      this.#undelivered(item, "withdrawn");
      // An answer that asked back takes its question with it: its asker is told.
      if (item.asks?.state === "open") {
        this.#end(item.asks, "failed", `${operation.agent} finished before it saw the question`, {
          gone: true,
        });
      }
    }
  }

  /**
   * Takes held messages out of an agent's inbox, undelivered on a closing route: a question among
   * them fails, and its asker is told why.
   */
  #drop(agent: AgentKey, dropped: readonly Message[], reason: string): void {
    if (dropped.length === 0) return;
    this.#inboxes.set(
      agent,
      this.#inbox(agent).filter((item) => !dropped.includes(item as Message)),
    );
    for (const message of dropped) {
      this.#undelivered(message, "route-closed");
      if (message.asks?.state === "open") this.#end(message.asks, "failed", reason, { gone: true });
    }
  }

  #closeRoute(route: Route, reason: "stage-ended" | "agent-stopped" | "attempt-ended"): void {
    if (!route.open) return;
    route.open = false;
    route.closed = reason;
    void this.#record({ kind: "route-closed", ...route.ends, reason });
    // What it held and had not shown is undelivered; an answer already accepted still goes.
    for (const [agent, held] of this.#inboxes) {
      this.#drop(
        agent,
        held.filter(
          (item): item is Message =>
            item.kind === "message" && item.route === route && !item.answers,
        ),
        "its route closed before it saw the question",
      );
    }
  }

  #undelivered(message: Message, reason: UndeliveredReason): void {
    void this.#record({
      kind: "message-undelivered",
      message: message.n,
      from: message.from,
      to: message.to,
      reason,
    });
  }

  #record(event: MessagingEventBody): Promise<void> {
    return this.#host.record(event).catch(() => undefined);
  }
}

function refuse<C extends SendCode | ReplyCode>(code: C, error: string) {
  return { kind: "refused" as const, code, error };
}
