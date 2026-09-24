import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RunAccounting, SettledOperation } from "@wf/contract/records";
import { type JsonSchema, parseJsonSchema } from "@wf/contract/schema";
import {
  type AbsoluteDeadline,
  type AgentExecution,
  type AgentKey,
  type AgentOpenSpec,
  type AgentRef,
  type AgentRunStructuredSpec,
  type AgentRunTextSpec,
  type AgentStructuredTurnSpec,
  type AgentTextTurnSpec,
  DeadlineExceededError,
  isJsonValue,
  type JsonObject,
  type JsonValue,
  type OperationRecord,
  type OutputSchema,
  type PlacementChoice,
  placementOf,
  type RunResult,
  type RuntimeSelection,
  type TurnOutcome,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@wf/contract/workflow";
import { findHarness } from "@wf/harness";
import type {
  AgentRunHost,
  AgentRuntimeConfig,
  HarnessReleaseDisposition,
  HarnessSession,
  HarnessTurn,
  HarnessTurnOutcome,
} from "@wf/harness/adapter";
import { PUBLISHED_PRICES } from "./accounting/prices";
import { summarizeRun } from "./accounting/summary";
import { installAgentLauncher } from "./agent-launcher";
import {
  type ResultChannel,
  type ResultControlPlane,
  startResultControlPlane,
} from "./control-plane";
import {
  assertDeadline,
  assertDeadlineValue,
  deadlineWithin,
  earlierDeadline,
  laterDeadline,
  runUntilStopped,
  scheduleAt,
  WorkflowCancelledError,
  waitForDeadline,
} from "./deadlines";
import {
  createResultSlotRegistry,
  type ResultSlotRegistry,
  type ResultSlotSettlement,
} from "./result-slots";
import { createRunDir } from "./run-dir";
import { type AgentLedger, createRunLedger, type RunLedger } from "./run-usage";

export { WorkflowCancelledError } from "./deadlines";

export type RunWorkflowOptions = {
  runRoot: string;
  runtime: AgentRuntimeConfig;
  deadline: AbsoluteDeadline;
  cwd?: string;
  onLog?: (message: string, fields?: JsonObject) => void;
  signal?: AbortSignal;
};

export type WorkflowRunResult<Result extends JsonValue> = {
  runId: string;
  value: Result;
  /** Every operation's record, completed with the spend read when the run ended. */
  usage: SettledOperation[];
  /** ISO times the run started and its own work, cleanup included, ended. */
  startedAt: string;
  finishedAt: string;
  /**
   * Derived from `usage` and the two times, which are what a record keeps; `summarizeRun` prices
   * them again with another table.
   */
  accounting: RunAccounting;
};

export type WorkflowRunHandle<Result extends JsonValue> = {
  runId: string;
  result: Promise<WorkflowRunResult<Result>>;
  inspect(): WorkflowRunSnapshot;
  stop(reason?: unknown): Promise<void>;
};

export type WorkflowRunSnapshot = {
  state: "starting" | "running" | "closing" | "closed";
  agents: readonly {
    key: AgentKey;
    execution: AgentExecution;
    state:
      | "starting"
      | "idle"
      | "working"
      | "blocked"
      | "dormant"
      | "quarantined"
      | "missing"
      | "unknown";
    observedAt: number;
    detail?: string;
  }[];
};

type AgentEntry = {
  identity: AgentIdentity;
  state: Promise<LogicalAgent>;
  /**
   * Closed with the agent: its socket is its authority, so it must not outlive it.
   * `undefined` when the channel never opened; the agent state carries the reason.
   */
  channel: Promise<ResultChannel | undefined>;
};

type AgentIdentity = {
  execution: AgentExecution;
  cwd: string;
  instructions?: string;
  labels?: AgentOpenSpec["labels"];
};

const CLEANUP_GRACE_MILLISECONDS = 5_000;
const scopes = new AsyncLocalStorage<ExecutionScope>();

export async function runWorkflow<Args extends JsonValue, Result extends JsonValue>(
  definition: WorkflowDefinition<Args, Result>,
  args: Args,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult<Result>> {
  return (await startWorkflow(definition, args, options)).result;
}

export async function startWorkflow<Args extends JsonValue, Result extends JsonValue>(
  definition: WorkflowDefinition<Args, Result>,
  args: Args,
  options: RunWorkflowOptions,
): Promise<WorkflowRunHandle<Result>> {
  assertDeadline(options.deadline);
  if (options.signal?.aborted) throw new WorkflowCancelledError(options.signal.reason);
  const runId = randomUUID();
  const startedAt = Date.now();
  const runDir = await createRunDir(options.runRoot, runId);
  const slots = createResultSlotRegistry({ runDir });
  const control = await startResultControlPlane({ slots });
  const cwd = options.cwd ?? process.cwd();
  let host: AgentRunHost;
  const openingHost = Promise.resolve().then(() =>
    options.runtime.host.openRun({
      runId,
      cwd,
      deadline: options.deadline,
    }),
  );
  try {
    host = await runUntilStopped(() => openingHost, options.signal, options.deadline);
  } catch (error) {
    void openingHost
      .then((lateHost) => lateHost.close("run ended before host acquisition"))
      .catch(() => undefined);
    await control.close();
    throw error;
  }
  const ledger = createRunLedger({ accounting: options.runtime.host.accounting, startedAt });
  const owner = new WorkflowOwner({
    runId,
    cwd,
    deadline: options.deadline,
    runtime: options.runtime,
    host,
    slots,
    control,
    ledger,
    onLog: options.onLog,
  });
  const stopped = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, stopped.signal])
    : stopped.signal;
  const result = (async (): Promise<WorkflowRunResult<Result>> => {
    let value: Result | undefined;
    let failure: unknown;
    let failed = false;
    try {
      value = await runUntilStopped(
        () => definition.run(owner.context, args),
        signal,
        options.deadline,
      );
      if (!isJsonValue(value)) throw new Error("workflow result must contain only JSON values");
    } catch (error) {
      failed = true;
      failure = error;
    }

    if (!failed) await ledger.letFinish(options.deadline, signal);
    const cleanupErrors: unknown[] = [];
    const ownerCleanupDeadline = {
      unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS,
    };
    try {
      cleanupErrors.push(...(await owner.close(ownerCleanupDeadline)));
    } catch (error) {
      cleanupErrors.push(error);
    }
    const controlCleanupDeadline = {
      unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS,
    };
    try {
      await waitForDeadline(control.close(), controlCleanupDeadline);
    } catch (error) {
      cleanupErrors.push(
        error instanceof DeadlineExceededError
          ? new Error(
              `control-plane cleanup exceeded ${CLEANUP_GRACE_MILLISECONDS}ms shutdown grace`,
            )
          : error,
      );
    }

    if (failed) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError([failure, ...cleanupErrors], "workflow and cleanup failed");
      }
      throw failure;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "workflow cleanup failed");
    }
    // Before the wait for session files, which is bookkeeping rather than the run's own time.
    const finishedAt = new Date().toISOString();
    const usage = await ledger.settle(signal);
    const times = { startedAt: new Date(startedAt).toISOString(), finishedAt };
    return {
      runId,
      value: value as Result,
      usage,
      ...times,
      accounting: summarizeRun(usage, PUBLISHED_PRICES, times),
    };
  })();

  return {
    runId,
    result,
    inspect: () => structuredClone(host.inspect()),
    async stop(reason) {
      stopped.abort(reason);
      try {
        await result;
      } catch (error) {
        if (!(error instanceof WorkflowCancelledError)) throw error;
      }
    },
  };
}

class WorkflowOwner {
  readonly context: WorkflowContext;
  readonly #agents = new Map<string, AgentEntry>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<unknown[]> | undefined;

  constructor(
    private readonly options: {
      runId: string;
      cwd: string;
      deadline: AbsoluteDeadline;
      runtime: AgentRuntimeConfig;
      host: AgentRunHost;
      slots: ResultSlotRegistry;
      control: ResultControlPlane;
      ledger: RunLedger;
      onLog?: RunWorkflowOptions["onLog"];
    },
  ) {
    this.context = {
      runId: options.runId,
      cwd: options.cwd,
      deadline: options.deadline,
      agents: {
        open: (spec) => {
          try {
            return this.openAgent(spec);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        attach: () => unavailable("agents.attach"),
        stop: () => unavailable("agents.stop"),
      },
      participants: {
        connect: () => unavailable("participants.connect"),
        get: () => unavailable("participants.get"),
      },
      messages: { allow: () => unavailable("messages.allow") },
      steps: {
        run: () => unavailable("steps.run"),
        sleep: () => unavailable("steps.sleep"),
      },
      signals: { receive: () => unavailable("signals.receive") },
      parallel: (items, operation, parallelOptions) => {
        const inherited = scopes.getStore()?.deadline ?? options.deadline;
        const deadline = parallelOptions?.deadline
          ? earlierDeadline(parallelOptions.deadline, inherited)
          : inherited;
        return runParallel(items, operation, deadline, parallelOptions?.concurrency);
      },
      call: () => unavailable("call"),
      usage: () => options.ledger.records(),
      log: (message, fields) => options.onLog?.(message, fields),
    };
  }

  async close(deadline: AbsoluteDeadline): Promise<unknown[]> {
    this.#closing ??= (async (): Promise<unknown[]> => {
      this.#closed = true;
      const cleanup = Promise.all([
        Promise.allSettled([this.options.host.close("workflow complete")]),
        Promise.allSettled([...this.#inFlight]),
      ]).then(async (settled) => {
        // Only now: an agent can still be submitting from inside its own close, and taking its
        // socket away first turns that into a connection error it cannot report.
        await Promise.allSettled(
          [...this.#agents.values()].map((agent) => agent.channel.then((c) => c?.close())),
        );
        return settled;
      });
      let closed: PromiseSettledResult<void>[];
      try {
        [closed] = await waitForDeadline(cleanup, deadline);
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          return [
            new Error(`agent cleanup exceeded ${CLEANUP_GRACE_MILLISECONDS}ms shutdown grace`),
          ];
        }
        throw error;
      }
      return closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    })();
    return this.#closing;
  }

  private openAgent(spec: AgentOpenSpec): Promise<AgentRef> {
    if (this.#closed) throw new Error("workflow context is closed");
    scopes.getStore()?.assertAccepting();
    if (spec.skills && spec.skills.length > 0) {
      throw new Error("agent skills are not implemented by this runner");
    }
    const existing = this.#agents.get(spec.key);
    const execution = existing
      ? constrainExistingExecution(spec.runtime, existing.identity.execution)
      : resolveExecution(spec.runtime, this.options.runtime);
    const identity: AgentIdentity = {
      execution,
      cwd: spec.cwd ?? this.options.cwd,
      ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
      ...(spec.labels === undefined ? {} : { labels: structuredClone(spec.labels) }),
    };
    const scope = scopes.getStore();
    const inheritedDeadline = scope?.deadline ?? this.options.deadline;
    const effectiveDeadline = spec.deadline
      ? earlierDeadline(spec.deadline, inheritedDeadline)
      : inheritedDeadline;
    assertDeadline(effectiveDeadline);
    if (existing) {
      assertCompatibleAgent(spec.key, existing.identity, identity, spec);
      const attached = this.track(waitForDeadline(existing.state, effectiveDeadline));
      scope?.track(attached);
      return attached;
    }

    // Opened before the session so registration below stays synchronous: two concurrent `agent()`
    // calls for one key must not each build an agent.
    const launcherSessions = new Set<string>();
    let harnessSession: HarnessSession | undefined;
    const ledger = this.options.ledger.agent({
      key: spec.key,
      execution,
      cwd: identity.cwd,
      sessions: () => [...new Set([...launcherSessions, ...(harnessSession?.sessions?.() ?? [])])],
    });
    const opened = this.options.control.openChannel(spec.key, (id) => launcherSessions.add(id));
    const reachable = opened.then(async (channel) => ({
      channel,
      // Beside the socket, in the directory the control plane made for this agent alone. Deriving
      // a directory from the key instead would let two keys that differ only in punctuation share
      // one, and the second install would point the first agent at the wrong socket.
      launcher: await installAgentLauncher(
        dirname(channel.endpoint),
        channel.endpoint,
        findHarness(execution.harness)?.sessionEnv,
      ),
    }));
    // Read below only once the session exists; a failure before then is reported through `state`.
    reachable.catch(() => undefined);
    // An open socket authorizes an agent until something closes it, so every failure path does.
    const closeChannel = () => opened.then((channel) => channel.close()).catch(() => undefined);
    const state = this.options.host
      .openAgent({
        key: spec.key,
        deadline: effectiveDeadline,
        cwd: identity.cwd,
        execution,
        ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
        ...(spec.labels === undefined ? {} : { labels: spec.labels }),
      })
      .catch(async (error: unknown) => {
        await closeChannel();
        throw error;
      })
      .then(async (session) => {
        harnessSession = session;
        let channel: ResultChannel;
        let launcher: string;
        try {
          ({ channel, launcher } = await reachable);
        } catch (error) {
          // A session with no way to answer is no agent at all; neither half outlives the other.
          await Promise.allSettled([session.close(reasonOf(error)), closeChannel()]);
          throw error;
        }
        return new LogicalAgent({
          key: spec.key,
          execution,
          session,
          slots: this.options.slots,
          endpoint: channel.endpoint,
          launcher,
          deadline: this.options.deadline,
          ledger,
          track: (promise) => this.track(promise),
          isRunClosing: () => this.#closed,
        });
      });
    const ownedState = this.track(state);
    this.#agents.set(spec.key, {
      identity,
      state: ownedState,
      // Never rejects: the failure is already carried by `state`, and a second copy with no
      // reader is an unhandled rejection that takes the process down with it.
      channel: opened.then(
        (channel) => channel,
        () => undefined,
      ),
    });
    const activated = this.track(waitForDeadline(ownedState, effectiveDeadline));
    scope?.track(activated);
    return activated;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.#inFlight.add(promise);
    promise.finally(() => this.#inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }
}

class LogicalAgent implements AgentRef {
  readonly #operations = new Map<
    string,
    {
      spec: AgentRunTextSpec | AgentRunStructuredSpec<JsonValue>;
      result: Promise<RunResult<JsonValue>>;
    }
  >();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    private readonly options: {
      key: string;
      execution: AgentExecution;
      session: HarnessSession;
      slots: ResultSlotRegistry;
      endpoint: string;
      /** The path this agent is told to run; see `installAgentLauncher`. */
      launcher: string;
      deadline: AbsoluteDeadline;
      ledger: AgentLedger;
      track<T>(promise: Promise<T>): Promise<T>;
      isRunClosing(): boolean;
    },
  ) {}

  get key(): string {
    return this.options.key;
  }

  get execution(): AgentExecution {
    return this.options.execution;
  }

  enqueue(_spec: AgentTextTurnSpec): Promise<never>;
  enqueue<T extends JsonValue>(_spec: AgentStructuredTurnSpec<T>): Promise<never>;
  enqueue(): Promise<never> {
    return unavailable("AgentRef.enqueue");
  }

  run(spec: AgentRunTextSpec): Promise<RunResult<string>>;
  run<T extends JsonValue>(spec: AgentRunStructuredSpec<T>): Promise<RunResult<T>>;
  run<T extends JsonValue>(
    spec: AgentRunTextSpec | AgentRunStructuredSpec<T>,
  ): Promise<RunResult<string | T>> {
    if (this.#closed) return Promise.reject(new Error("logical agent is closed"));
    const scope = scopes.getStore();
    try {
      scope?.assertAccepting();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = spec.id ?? randomUUID();
    const completeSpec = structuredClone({ ...spec, id }) as
      | AgentRunTextSpec
      | AgentRunStructuredSpec<JsonValue>;
    const existing = this.#operations.get(id);
    if (existing) {
      if (!isDeepStrictEqual(existing.spec, completeSpec)) {
        const rejected = Promise.reject<RunResult<string | T>>(
          new Error(`turn id ${id} was reused with a different specification`),
        );
        scope?.track(rejected);
        return rejected;
      }
      scope?.track(existing.result);
      return existing.result as Promise<RunResult<string | T>>;
    }
    let deadline: AbsoluteDeadline;
    try {
      if (spec.deadline && spec.timeoutMs !== undefined) {
        throw new Error("a turn cannot specify both deadline and timeoutMs");
      }
      const inheritedDeadline = scope?.deadline ?? this.options.deadline;
      deadline =
        spec.timeoutMs === undefined
          ? (spec.deadline ?? inheritedDeadline)
          : deadlineWithin(spec.timeoutMs, inheritedDeadline);
    } catch (error) {
      const rejected = Promise.reject<RunResult<string | T>>(error);
      scope?.track(rejected);
      return rejected;
    }
    const result = this.queue(async () => {
      if (this.#closed || this.options.isRunClosing()) {
        throw new Error("logical agent is closed");
      }
      scope?.assertActive();
      return this.executeOperation(completeSpec, scope, deadline);
    });
    const tracked = this.options.track(result);
    scope?.track(tracked);
    this.#operations.set(id, { spec: completeSpec, result: tracked });
    return tracked as Promise<RunResult<string | T>>;
  }

  compact(): Promise<never> {
    return unavailable("AgentRef.compact");
  }

  close(reason?: string): Promise<void> {
    this.#closed = true;
    if (!this.#closePromise) {
      let attempt: Promise<void>;
      try {
        attempt = Promise.resolve(this.options.session.close(reason));
      } catch (error) {
        attempt = Promise.reject(error);
      }
      this.#closePromise = attempt;
      void attempt.catch(() => {
        if (this.#closePromise === attempt) this.#closePromise = undefined;
      });
    }
    return this.#closePromise;
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeOperation(
    spec: AgentRunTextSpec | AgentRunStructuredSpec<JsonValue>,
    scope: ExecutionScope | undefined,
    deadline: AbsoluteDeadline,
  ): Promise<RunResult<JsonValue>> {
    const nudge = spec.nudge === false ? undefined : (spec.nudge ?? {});
    assertDeadlineValue(deadline);
    scope?.assertActive();
    if (nudge?.deadline) assertDeadlineValue(nudge.deadline);
    const operationDeadline = scope ? earlierDeadline(deadline, scope.deadline) : deadline;
    const nudgeDeadline = nudge
      ? scope
        ? earlierDeadline(nudge.deadline ?? scope.deadline, scope.deadline)
        : (nudge.deadline ?? this.options.deadline)
      : undefined;
    const operationId = randomUUID();
    const schema = resultSchema(spec.schema);
    if (Date.now() >= operationDeadline.unixMilliseconds) {
      const usage = this.options.ledger
        .reserve(operationId)
        .settle({ settledAt: operationDeadline.unixMilliseconds }, []);
      return {
        outcome: { kind: "timed-out", reason: "operation deadline exceeded", usage },
        usage,
      };
    }
    const slot = await this.options.slots.open({
      operationId,
      agentId: this.options.key,
      question: spec.prompt,
      schema,
      deadline: nudgeDeadline ? laterDeadline(operationDeadline, nudgeDeadline) : operationDeadline,
    });
    const binding = { endpoint: this.options.endpoint, operationId };
    const charges: number[] = [];
    let later: Promise<HarnessTurnOutcome> | undefined;
    const entry = this.options.ledger.reserve(operationId);
    /** The native turn this operation currently answers for; a nudge replaces it. */
    const held: HeldTurn = {};
    const finish = async (
      native: HarnessTurnOutcome | "expired",
      settlement?: ResultSlotSettlement,
    ): Promise<RunResult<JsonValue>> => {
      await this.options.slots.close(operationId);
      const settled = settlement ?? (await slot.settled);
      const usage = entry.settle(
        {
          ...(held.deliveredAt === undefined ? {} : { deliveredAt: held.deliveredAt }),
          settledAt:
            settled.kind === "accepted"
              ? settled.acceptedAt
              : held.ended === undefined
                ? Math.min(Date.now(), operationDeadline.unixMilliseconds)
                : // An attempt that ran past its deadline settled at it; the engine noticed later.
                  Math.min(held.ended.at, held.ended.deadline.unixMilliseconds),
        },
        charges,
        later,
      );
      return { outcome: reconcile<JsonValue>(native, settled, usage), usage };
    };
    let removeCanceller: (() => void) | undefined;
    try {
      scope?.assertActive();
      if (Date.now() >= operationDeadline.unixMilliseconds) return await finish("expired");
      const turn: AgentTextTurnSpec = {
        id: spec.id!,
        prompt: operationPrompt(spec.prompt, schema, this.options.launcher, operationId),
        deadline: operationDeadline,
      };
      const outputSchema = spec.schema;
      removeCanceller = scope?.add((reason) =>
        held.turn ? releaseTurn(held.turn, reason) : Promise.resolve(),
      );
      const first = await this.attemptTurn(
        () =>
          outputSchema
            ? this.options.session.start({ ...turn, schema: outputSchema }, binding)
            : this.options.session.start(turn, binding),
        operationDeadline,
        slot.settled,
        scope,
        "turn",
        held,
      );
      if (first.kind === "unacquired") {
        const expiry = first.error instanceof DeadlineExceededError;
        const native: HarnessTurnOutcome = {
          state: expiry ? "timed-out" : "failed",
          detail: expiry ? "operation deadline exceeded" : reasonOf(first.error),
          resultEvidence: { kind: "unavailable" },
          chargesUsd: [],
        };
        void this.close(native.detail).catch(() => undefined);
        return await finish(native);
      }
      if (first.kind === "abandoned") return await finish(first.native, first.settlement);
      charges.push(...first.charges);
      later = first.later;
      let { native, settlement, releaseAttempted, releaseResolved } = first;
      // Peek rather than wait: a slot that has not settled must not hold the operation open.
      settlement ??= await Promise.race([slot.settled, Promise.resolve(undefined)]);
      if (
        settlement === undefined &&
        native !== "expired" &&
        native.state === "completed" &&
        nudge &&
        nudgeDeadline
      ) {
        try {
          const again = await this.attemptTurn(
            () =>
              held.turn!.nudge({
                id: `${spec.id!}:nudge`,
                prompt: operationPrompt(
                  nudge.prompt ??
                    "You finished without reporting the requested result. Report it now.",
                  schema,
                  this.options.launcher,
                  operationId,
                ),
                deadline: nudgeDeadline,
              }),
            nudgeDeadline,
            slot.settled,
            scope,
            "nudge",
            held,
          );
          if (again.kind === "unacquired") throw again.error;
          ({ native, settlement } = again);
          if (again.kind === "abandoned") {
            releaseAttempted = true;
          } else {
            ({ releaseAttempted, releaseResolved, later } = again);
            charges.push(...again.charges);
          }
        } catch (error) {
          native = {
            state: error instanceof DeadlineExceededError ? "timed-out" : "failed",
            detail: reasonOf(error),
            resultEvidence: { kind: "unavailable" },
            chargesUsd: [],
          };
        }
      }
      if (native === "expired" || (native.state !== "completed" && !releaseResolved)) {
        const reason =
          native === "expired"
            ? "operation deadline exceeded"
            : (native.detail ?? `native turn ${native.state}`);
        if (!releaseAttempted) await releaseTurn(held.turn!, reason);
        void this.close(reason).catch(() => undefined);
      }
      return await finish(native, settlement);
    } catch (error) {
      await this.options.slots.close(operationId);
      throw error;
    } finally {
      removeCanceller?.();
    }
  }

  /**
   * One attempt against the native turn — the opening dispatch or a nudge. `held` takes custody
   * of a turn this operation keeps, so scope cancellation releases it. An error before acquisition
   * comes back as `unacquired`, because the opening dispatch and a nudge diagnose it differently;
   * an error after acquisition propagates.
   */
  private async attemptTurn(
    begin: () => Promise<HarnessTurn>,
    deadline: AbsoluteDeadline,
    settled: Promise<ResultSlotSettlement>,
    scope: ExecutionScope | undefined,
    what: "turn" | "nudge",
    held: HeldTurn,
  ): Promise<TurnAttempt> {
    let acquiring: Promise<HarnessTurn>;
    let acquisition: TurnAcquisition;
    const began = Date.now();
    try {
      acquiring = begin();
      acquisition = await observeTurnAcquisition(acquiring, deadline, settled);
    } catch (error) {
      return { kind: "unacquired", error };
    }
    if (acquisition.kind !== "turn") {
      const settlement = acquisition.kind === "result" ? acquisition.settlement : undefined;
      // An answer proves the prompt arrived, even though the turn it came from was never held.
      if (settlement?.kind === "accepted") held.deliveredAt ??= began;
      this.abandonTurnAcquisition(
        acquiring,
        settlement?.kind === "accepted"
          ? `result slot settled before native ${what} acquisition`
          : `operation deadline exceeded before native ${what} acquisition`,
      );
      return {
        kind: "abandoned",
        native: settlement?.kind === "accepted" ? unresolvedReleaseOutcome() : "expired",
        settlement,
      };
    }
    const turn = acquisition.turn;
    if (scope?.cancelled || Date.now() >= deadline.unixMilliseconds) {
      this.abandonTurnAcquisition(
        Promise.resolve(turn),
        `operation deadline exceeded during native ${what} acquisition`,
      );
      return { kind: "abandoned", native: "expired", settlement: undefined };
    }
    held.turn = turn;
    held.deliveredAt ??= Date.now();
    const observed = await observeTurnAndResult(turn, deadline, settled);
    // Before any release: its grace is cleanup, not the agent's time.
    held.ended = { at: Date.now(), deadline };
    const unreleased = {
      kind: "observed",
      releaseAttempted: false,
      releaseResolved: false,
    } as const;
    if (observed.kind === "native") {
      return {
        ...unreleased,
        native: observed.native,
        settlement: undefined,
        charges: observed.native === "expired" ? [] : observed.native.chargesUsd,
      };
    }
    if (observed.settlement.kind !== "accepted") {
      return { ...unreleased, native: "expired", settlement: observed.settlement, charges: [] };
    }
    const disposition = await releaseTurn(turn, "result slot settled", true);
    const outcome = disposition?.kind === "released" ? disposition.outcome : undefined;
    const finishing = disposition?.kind === "finishing";
    return {
      kind: "observed",
      native: outcome ?? (finishing ? FINISHING_OUTCOME : unresolvedReleaseOutcome()),
      settlement: observed.settlement,
      charges: outcome?.chargesUsd ?? [],
      releaseAttempted: true,
      releaseResolved: outcome !== undefined || finishing,
      ...(finishing ? { later: turn.settled } : {}),
    };
  }

  private abandonTurnAcquisition(acquiring: Promise<HarnessTurn>, reason: string): void {
    const lateRelease = acquiring.then(
      (turn) => releaseTurn(turn, reason),
      () => undefined,
    );
    this.options.track(lateRelease);
    void this.close(reason).catch(() => undefined);
  }
}

class ExecutionScope {
  readonly #cancellers = new Set<(reason: string) => Promise<unknown>>();
  readonly #owned = new Set<Promise<unknown>>();
  #cancelled = false;
  #sealed = false;
  #cancellation: Promise<void> | undefined;

  constructor(readonly deadline: AbsoluteDeadline) {}

  get cancelled(): boolean {
    return this.#cancelled;
  }

  assertActive(): void {
    if (this.#cancelled || Date.now() >= this.deadline.unixMilliseconds) {
      throw new DeadlineExceededError(this.deadline);
    }
  }

  assertAccepting(): void {
    this.assertActive();
    if (this.#sealed) throw new Error("parallel execution scope is closed");
  }

  add(cancel: (reason: string) => Promise<unknown>): () => void {
    if (this.#cancelled) {
      void Promise.resolve()
        .then(() => cancel("parallel deadline exceeded"))
        .catch(() => undefined);
      return () => undefined;
    }
    this.#cancellers.add(cancel);
    return () => this.#cancellers.delete(cancel);
  }

  track(promise: Promise<unknown>): void {
    this.assertAccepting();
    this.#owned.add(promise);
    promise.catch(() => undefined);
  }

  async settleOwned(): Promise<void> {
    const settled = await Promise.allSettled([...this.#owned]);
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }

  seal(): void {
    this.#sealed = true;
  }

  cancel(): Promise<void> {
    if (this.#cancellation) return this.#cancellation;
    this.#cancelled = true;
    this.#cancellation = Promise.allSettled(
      [...this.#cancellers].map((cancel) =>
        Promise.resolve().then(() => cancel("parallel deadline exceeded")),
      ),
    ).then(() => undefined);
    return this.#cancellation;
  }
}

function runParallel<Item, Result>(
  items: readonly Item[],
  operation: (item: Item, index: number) => Promise<Result>,
  deadline: AbsoluteDeadline,
  requestedConcurrency?: number,
): Promise<Result[]> {
  assertDeadline(deadline);
  const concurrency = requestedConcurrency ?? Math.max(1, items.length);
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("parallel concurrency must be a positive safe integer");
  }
  const parent = scopes.getStore();
  parent?.assertAccepting();
  if (items.length === 0) return Promise.resolve([]);
  const execution = executeParallel(items, operation, deadline, concurrency, parent);
  parent?.track(execution);
  return execution;
}

async function executeParallel<Item, Result>(
  items: readonly Item[],
  operation: (item: Item, index: number) => Promise<Result>,
  deadline: AbsoluteDeadline,
  concurrency: number,
  parent: ExecutionScope | undefined,
): Promise<Result[]> {
  const scope = new ExecutionScope(deadline);
  const removeFromParent = parent?.add(() => scope.cancel());
  const results = new Array<Result>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    await scopes.run(scope, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        scope.assertActive();
        results[index] = await operation(items[index]!, index);
      }
    });
  });
  const completion = Promise.all(workers).then(async () => {
    scope.seal();
    await scope.settleOwned();
  });
  let cancelTimer: (() => void) | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    cancelTimer = scheduleAt(deadline, () => {
      void scope.cancel().then(() => reject(new DeadlineExceededError(deadline)));
    });
  });
  try {
    await Promise.race([completion, expiry]);
    if (scope.cancelled || Date.now() >= deadline.unixMilliseconds) {
      await scope.cancel();
      throw new DeadlineExceededError(deadline);
    }
    return results;
  } catch (error) {
    await scope.cancel();
    completion.catch(() => undefined);
    throw error;
  } finally {
    cancelTimer?.();
    removeFromParent?.();
  }
}

type HeldTurn = {
  turn?: HarnessTurn;
  /** When the harness first accepted a turn for this operation. */
  deliveredAt?: number;
  /** When the last held attempt was seen to end, and the deadline it ran under. */
  ended?: { at: number; deadline: AbsoluteDeadline };
};

type TurnAttempt =
  | { kind: "unacquired"; error: unknown }
  | {
      /** No turn came under this operation; `abandonTurnAcquisition` releases any late one. */
      kind: "abandoned";
      native: HarnessTurnOutcome | "expired";
      settlement: ResultSlotSettlement | undefined;
    }
  | {
      kind: "observed";
      native: HarnessTurnOutcome | "expired";
      settlement: ResultSlotSettlement | undefined;
      charges: readonly number[];
      releaseAttempted: boolean;
      releaseResolved: boolean;
      /** The outcome of an answered turn the host left to finish, once it has. */
      later?: Promise<HarnessTurnOutcome>;
    };

type TurnObservation =
  | { kind: "native"; native: HarnessTurnOutcome | "expired" }
  | { kind: "result"; settlement: ResultSlotSettlement };

type TurnAcquisition =
  | { kind: "turn"; turn: HarnessTurn }
  | { kind: "result"; settlement: ResultSlotSettlement }
  | { kind: "expired" };

async function observeTurnAcquisition(
  acquiring: Promise<HarnessTurn>,
  deadline: AbsoluteDeadline,
  settlement: Promise<ResultSlotSettlement>,
): Promise<TurnAcquisition> {
  let cancelTimer: (() => void) | undefined;
  const expired = new Promise<TurnAcquisition>((resolve) => {
    cancelTimer = scheduleAt(deadline, () => resolve({ kind: "expired" }));
  });
  try {
    return await Promise.race([
      acquiring.then((turn): TurnAcquisition => ({ kind: "turn", turn })),
      settlement.then((value): TurnAcquisition => ({ kind: "result", settlement: value })),
      expired,
    ]);
  } finally {
    cancelTimer?.();
  }
}

async function observeTurnAndResult(
  turn: HarnessTurn,
  deadline: AbsoluteDeadline,
  settlement: Promise<ResultSlotSettlement>,
): Promise<TurnObservation> {
  let cancelTimer: (() => void) | undefined;
  const expired = new Promise<"expired">((resolve) => {
    cancelTimer = scheduleAt(deadline, () => resolve("expired"));
  });
  return Promise.race([
    Promise.race([turn.settled, expired])
      .finally(() => cancelTimer?.())
      .then((native): TurnObservation => ({ kind: "native", native })),
    settlement.then((value): TurnObservation => ({ kind: "result", settlement: value })),
  ]);
}

/**
 * `undefined` when the host throws or does not answer within the cleanup grace. After an accepted
 * answer, a host whose session continues may leave the turn finishing, and the
 * operation returns at once rather than waiting out the agent's closing message.
 */
async function releaseTurn(
  turn: HarnessTurn,
  reason: string,
  answered = false,
): Promise<HarnessReleaseDisposition | undefined> {
  const deadline = { unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS };
  try {
    return await waitForDeadline(
      turn.release(reason, deadline, answered ? { answered } : undefined),
      deadline,
    );
  } catch {
    return undefined;
  }
}

/** Stands in for an answered turn still finishing; an accepted answer is what the caller sees. */
const FINISHING_OUTCOME: HarnessTurnOutcome = {
  state: "completed",
  detail: "left to finish after its answer was accepted",
  resultEvidence: { kind: "unavailable" },
  chargesUsd: [],
};

function unresolvedReleaseOutcome(): HarnessTurnOutcome {
  return {
    state: "cancelled",
    detail: "native work was quarantined after result settlement",
    resultEvidence: { kind: "unavailable" },
    chargesUsd: [],
  };
}

function reconcile<T extends JsonValue>(
  native: HarnessTurnOutcome | "expired",
  settlement: ResultSlotSettlement,
  usage: OperationRecord,
): TurnOutcome<T> {
  if (settlement.kind === "accepted") {
    return { kind: "answered", value: settlement.value as T, usage };
  }
  if (native === "expired" || settlement.kind === "expired") {
    return { kind: "timed-out", reason: "operation deadline exceeded", usage };
  }
  switch (native.state) {
    case "completed":
      return { kind: "unanswered", reason: "agent settled without an accepted result", usage };
    case "blocked":
      return { kind: "blocked", reason: native.detail ?? "agent is blocked", usage };
    case "timed-out":
      return { kind: "timed-out", reason: native.detail ?? "operation timed out", usage };
    case "failed":
      return {
        kind: "failed",
        reason: native.detail ?? "harness operation failed",
        retryable: false,
        usage,
      };
    case "cancelled":
      return { kind: "cancelled", reason: native.detail ?? "operation cancelled", usage };
  }
}

function resultSchema<T extends JsonValue>(schema: OutputSchema<T> | undefined): JsonSchema {
  return schema ? parseJsonSchema(schema) : { type: "string" };
}

function operationPrompt(
  prompt: string,
  schema: JsonSchema,
  launcher: string,
  callId: string,
): string {
  // The full path, because the command is not on the agent's PATH and in some harnesses cannot be.
  // A quoted heredoc passes the JSON through untouched: a quoted argument broke on shell quoting
  // (story 002). Not indented: a copied terminator with leading spaces never closes the heredoc.
  // The schema itself, not a rendering of it: without its bounds, first answers were 0/160 valid
  // (E5). `wf` says what to do about a rejection, so the prompt does not.
  return [
    prompt,
    "",
    "When the answer is ready, return it by running:",
    "",
    `${launcher} result ${callId} <<'WF_JSON'`,
    "<json>",
    "WF_JSON",
    "",
    "The JSON must match this schema:",
    JSON.stringify(schema),
  ].join("\n");
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveExecution(
  selection: RuntimeSelection,
  runtime: AgentRuntimeConfig,
): AgentExecution {
  if (typeof selection === "string") return resolveAlias(selection, runtime);
  if ("alias" in selection) {
    const resolved = resolveAlias(selection.alias, runtime);
    for (const field of ["harness", "model"] as const) {
      const required = selection[field];
      if (required !== undefined && !isDeepStrictEqual(required, resolved[field])) {
        throw new Error(`runtime alias ${selection.alias} does not satisfy required ${field}`);
      }
    }
    return { ...resolved, ...storedPlacement(selection) };
  }
  const { harness, model } = selection;
  return { harness, model, ...storedPlacement(selection) };
}

/**
 * A pane is the default and is left unsaid, and `metered` is kept only where it means something,
 * so the same agent always has one identity.
 */
function storedPlacement(choice: PlacementChoice): PlacementChoice {
  // A workflow is untyped JavaScript at run time; a misspelt placement must not become a pane.
  if (
    choice.placement !== undefined &&
    choice.placement !== "pane" &&
    choice.placement !== "headless"
  ) {
    throw new Error(
      `unknown placement ${JSON.stringify(choice.placement)}; expected pane or headless`,
    );
  }
  return placementOf(choice) === "headless"
    ? { placement: "headless", ...(choice.metered === true ? { metered: true as const } : {}) }
    : {};
}

function constrainExistingExecution(
  selection: RuntimeSelection,
  existing: AgentExecution,
): AgentExecution {
  if (typeof selection === "string") {
    return constrainExistingExecution({ alias: selection }, existing);
  }
  if ("alias" in selection) {
    if (existing.alias !== selection.alias) {
      throw new Error(`existing agent does not use runtime alias ${selection.alias}`);
    }
    for (const field of ["harness", "model"] as const) {
      const required = selection[field];
      if (required !== undefined && !isDeepStrictEqual(required, existing[field])) {
        throw new Error(`existing agent does not satisfy required ${field}`);
      }
    }
  } else if (selection.harness !== existing.harness || selection.model !== existing.model) {
    throw new Error("existing agent uses a different runtime configuration");
  }
  const placed = placementOf(existing);
  if (
    (selection.placement !== undefined && placementOf(selection) !== placed) ||
    (selection.metered !== undefined &&
      placed === "headless" &&
      selection.metered !== existing.metered)
  ) {
    throw new Error("existing agent uses a different placement");
  }
  return existing;
}

function resolveAlias(alias: string, runtime: AgentRuntimeConfig): AgentExecution {
  const selected = runtime.aliases[alias];
  if (!selected) throw new Error(`unknown runtime alias: ${alias}`);
  // Placement is the agent's to choose, never the operator's, so only the target is copied.
  return { harness: selected.harness, model: selected.model, alias };
}

function assertCompatibleAgent(
  key: string,
  existing: AgentIdentity,
  requested: AgentIdentity,
  spec: AgentOpenSpec,
): void {
  if (!isDeepStrictEqual(existing.execution, requested.execution)) conflict(key, "runtime");
  if (spec.cwd !== undefined && existing.cwd !== requested.cwd) conflict(key, "cwd");
  for (const field of ["instructions", "labels"] as const) {
    if (spec[field] !== undefined && !isDeepStrictEqual(existing[field], requested[field])) {
      conflict(key, field);
    }
  }
}

function conflict(key: string, field: string): never {
  throw new Error(`agent ${key} is already open with different ${field}`);
}

function unavailable(name: string): Promise<never> {
  return Promise.reject(new Error(`${name} is not implemented by the minimum workflow runner`));
}
