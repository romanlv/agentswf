import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, type JsonSchema } from "@wf/contract/schema";
import {
  DeadlineExceededError,
  type AbsoluteDeadline,
  type AgentDirectory,
  type AgentExecution,
  type AgentKey,
  type AgentOpenSpec,
  type AgentRef,
  type AgentRunStructuredSpec,
  type AgentRunTextSpec,
  type AgentStructuredTurnSpec,
  type AgentTextTurnSpec,
  type JsonObject,
  type JsonValue,
  isJsonValue,
  type OutputSchema,
  type RunResult,
  type RuntimeSelection,
  type TurnOutcome,
  type TurnUsage,
  type UsageExecution,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@wf/contract/workflow";
import type {
  AgentRunHost,
  AgentRuntimeConfig,
  HarnessOperationBinding,
  HarnessSession,
  HarnessTurn,
  HarnessTurnOutcome,
} from "@wf/harness/adapter";
import type { TurnUsage as NativeUsage } from "@wf/harness";
import { startResultControlPlane } from "./control-plane";
import {
  createResultSlotRegistry,
  type ResultSlotRegistry,
  type ResultSlotSettlement,
} from "./result-slots";
import { createRunDir } from "./run-dir";

export type RunWorkflowOptions = {
  runRoot: string;
  runtime: AgentRuntimeConfig;
  deadline: AbsoluteDeadline;
  cwd?: string;
  onLog?: (message: string, fields?: JsonObject) => void;
  signal?: AbortSignal;
};

export class WorkflowCancelledError extends Error {
  constructor(readonly reason: unknown) {
    super("workflow cancelled by operator");
    this.name = "WorkflowCancelledError";
  }
}

export type WorkflowRunResult<Result extends JsonValue> = {
  runId: string;
  value: Result;
  usage: TurnUsage[];
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
};

type AgentIdentity = {
  execution: AgentExecution;
  cwd: string;
  instructions?: string;
  lifecycle: NonNullable<AgentOpenSpec["lifecycle"]>;
  skills: readonly string[];
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
  const runDir = await createRunDir(options.runRoot, runId);
  const slots = createResultSlotRegistry({ runDir });
  const control = await startResultControlPlane({ socketRoot: runDir, slots });
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
    host = await runUntilStopped(
      () => openingHost,
      options.signal ? [options.signal] : [],
      options.deadline,
    );
  } catch (error) {
    void openingHost
      .then((lateHost) => lateHost.close("run ended before host acquisition"))
      .catch(() => undefined);
    await control.close();
    throw error;
  }
  const owner = new WorkflowOwner({
    runId,
    cwd,
    deadline: options.deadline,
    runtime: options.runtime,
    host,
    slots,
    endpoint: control.endpoint,
    onLog: options.onLog,
  });
  const stopped = new AbortController();
  const result = (async (): Promise<WorkflowRunResult<Result>> => {
    let value: Result | undefined;
    let failure: unknown;
    let failed = false;
    try {
      value = await runUntilStopped(
        () => definition.run(owner.context, args),
        [options.signal, stopped.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        ),
        options.deadline,
      );
      if (!isJsonValue(value)) throw new Error("workflow result must contain only JSON values");
    } catch (error) {
      failed = true;
      failure = error;
    }

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
    return { runId, value: value as Result, usage: owner.usage() };
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

async function runUntilStopped<T>(
  execute: () => Promise<T>,
  signals: readonly AbortSignal[],
  deadline: AbsoluteDeadline,
): Promise<T> {
  const alreadyAborted = signals.find((signal) => signal.aborted);
  if (alreadyAborted) throw new WorkflowCancelledError(alreadyAborted.reason);
  if (Date.now() >= deadline.unixMilliseconds) throw new DeadlineExceededError(deadline);
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const abort = (event: Event) => {
    const signal = event.currentTarget as AbortSignal;
    rejectStopped(new WorkflowCancelledError(signal.reason));
  };
  for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
  const cancelDeadline = scheduleAt(deadline, () => {
    rejectStopped(new DeadlineExceededError(deadline));
  });
  try {
    const aborted = signals.find((signal) => signal.aborted);
    if (aborted) throw new WorkflowCancelledError(aborted.reason);
    if (Date.now() >= deadline.unixMilliseconds) throw new DeadlineExceededError(deadline);
    return await Promise.race([execute(), stopped]);
  } finally {
    cancelDeadline();
    for (const signal of signals) signal.removeEventListener("abort", abort);
  }
}

class WorkflowOwner {
  readonly context: WorkflowContext;
  readonly #agents = new Map<string, AgentEntry>();
  readonly #usage: Array<TurnUsage | undefined> = [];
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #authorities = new Set<string>();
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
      endpoint: string;
      onLog?: RunWorkflowOptions["onLog"];
    },
  ) {
    this.context = {
      runId: options.runId,
      cwd: options.cwd,
      deadline: options.deadline,
      agents: this.agentDirectory(),
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
      parallel: (items, operation, parallelOptions) =>
        runParallel(items, operation, parallelOptions.deadline, parallelOptions.concurrency),
      call: () => unavailable("call"),
      usage: () => this.usage(),
      log: (message, fields) => options.onLog?.(message, fields),
    };
  }

  usage(): TurnUsage[] {
    return this.#usage.filter((item): item is TurnUsage => item !== undefined);
  }

  async close(deadline: AbsoluteDeadline): Promise<unknown[]> {
    if (this.#closing) return this.#closing;
    this.#closing = this.closeOnce(deadline);
    return this.#closing;
  }

  private async closeOnce(deadline: AbsoluteDeadline): Promise<unknown[]> {
    this.#closed = true;
    const cleanup = Promise.all([
      Promise.allSettled([this.options.host.close("workflow complete")]),
      Promise.allSettled([...this.#inFlight]),
    ]);
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
    return closed.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
  }

  private agentDirectory(): AgentDirectory {
    return {
      open: (spec) => this.openAgent(spec),
      attach: () => unavailable("agents.attach"),
      stop: () => unavailable("agents.stop"),
    };
  }

  private openAgent(spec: AgentOpenSpec): Promise<AgentRef> {
    if (this.#closed) throw new Error("workflow context is closed");
    scopes.getStore()?.assertAccepting();
    assertDeadline(spec.deadline);
    assertMinimumLifecycle(spec);
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
      lifecycle: structuredClone(
        spec.lifecycle ?? { retention: { kind: "workflow" as const } },
      ),
      skills: structuredClone(spec.skills ?? []),
      ...(spec.labels === undefined ? {} : { labels: structuredClone(spec.labels) }),
    };
    const scope = scopes.getStore();
    const effectiveDeadline = scope
      ? earlierDeadline(spec.deadline, scope.deadline)
      : spec.deadline;
    if (existing) {
      assertCompatibleAgent(spec.key, existing.identity, identity, spec);
      const attached = this.track(waitForDeadline(existing.state, effectiveDeadline));
      scope?.track(attached);
      return attached;
    }

    const state = this.options.host
      .openAgent({
        key: spec.key,
        deadline: effectiveDeadline,
        cwd: identity.cwd,
        execution,
        ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
        ...(spec.skills === undefined ? {} : { skills: spec.skills }),
        ...(spec.labels === undefined ? {} : { labels: spec.labels }),
      })
      .then(
        (session) =>
          new LogicalAgent({
            key: spec.key,
            execution,
            session,
            slots: this.options.slots,
            endpoint: this.options.endpoint,
            reserveUsage: () => this.reserveUsage(),
            track: (promise) => this.track(promise),
            isRunClosing: () => this.#closed,
            rememberAuthority: (binding) => {
              this.#authorities.add(binding.operationId);
              this.#authorities.add(binding.capability);
            },
            authorities: () => [...this.#authorities],
          }),
      );
    const ownedState = this.track(state);
    this.#agents.set(spec.key, { identity, state: ownedState });
    const activated = this.track(waitForDeadline(ownedState, effectiveDeadline));
    scope?.track(activated);
    return activated;
  }

  private reserveUsage(): (usage: TurnUsage) => void {
    const index = this.#usage.length;
    this.#usage.push(undefined);
    return (usage) => {
      this.#usage[index] = usage;
    };
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
    { spec: AgentRunTextSpec | AgentRunStructuredSpec<JsonValue>; result: Promise<RunResult<JsonValue>> }
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
      reserveUsage(): (usage: TurnUsage) => void;
      track<T>(promise: Promise<T>): Promise<T>;
      isRunClosing(): boolean;
      rememberAuthority(binding: HarnessOperationBinding): void;
      authorities(): readonly string[];
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
    try {
      scope?.assertAccepting();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.queue(async () => {
      if (this.#closed || this.options.isRunClosing()) {
        throw new Error("logical agent is closed");
      }
      scope?.assertActive();
      return this.executeRun(completeSpec, scope);
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

  private async executeRun(
    spec: AgentRunTextSpec | AgentRunStructuredSpec<JsonValue>,
    scope: ExecutionScope | undefined,
  ): Promise<RunResult<JsonValue>> {
    return this.executeOperation(
      spec.id!,
      spec.prompt,
      spec.deadline,
      spec.schema,
      spec.nudge,
      scope,
      (turn, binding) =>
        turn.schema
          ? this.options.session.start(turn as AgentStructuredTurnSpec<JsonValue>, binding)
          : this.options.session.start(turn as AgentTextTurnSpec, binding),
    );
  }

  private async executeOperation<T extends JsonValue>(
    turnId: string,
    prompt: string,
    deadline: AbsoluteDeadline,
    outputSchema: OutputSchema<T> | undefined,
    nudge: AgentRunTextSpec["nudge"],
    scope: ExecutionScope | undefined,
    start: (
      turn: AgentTextTurnSpec | AgentStructuredTurnSpec<T>,
      binding: HarnessOperationBinding,
    ) => Promise<HarnessTurn>,
  ): Promise<RunResult<T>> {
    assertDeadlineValue(deadline);
    scope?.assertActive();
    if (nudge) assertDeadlineValue(nudge.deadline);
    const operationDeadline = scope ? earlierDeadline(deadline, scope.deadline) : deadline;
    const nudgeDeadline = nudge
      ? scope
        ? earlierDeadline(nudge.deadline, scope.deadline)
        : nudge.deadline
      : undefined;
    const operationId = randomUUID();
    const schema = resultSchema(outputSchema);
    if (Date.now() >= operationDeadline.unixMilliseconds) {
      return this.beforeDispatchTimeout<T>(operationId);
    }
    const slotDeadline = nudgeDeadline
      ? laterDeadline(operationDeadline, nudgeDeadline)
      : operationDeadline;
    const slot = await this.options.slots.open({
      operationId,
      question: prompt,
      schema,
      deadline: slotDeadline,
    });
    const binding = {
      endpoint: this.options.endpoint,
      operationId,
      capability: slot.capability,
    };
    this.options.rememberAuthority(binding);
    let nativeTurn: HarnessTurn | undefined;
    let removeCanceller: (() => void) | undefined;
    const saveUsage = this.options.reserveUsage();
    try {
      scope?.assertActive();
      if (Date.now() >= operationDeadline.unixMilliseconds) {
        await this.options.slots.close(slot.capability);
        const usage = workflowUsage(this.key, operationId, this.execution, []);
        saveUsage(usage);
        return {
          outcome: { kind: "timed-out", reason: "operation deadline exceeded", usage },
          usage,
        };
      }
      const turn = {
        id: turnId,
        prompt: operationPrompt(prompt, schema),
        deadline: operationDeadline,
        ...(outputSchema ? { schema: outputSchema } : {}),
      } as AgentTextTurnSpec | AgentStructuredTurnSpec<T>;
      try {
        const acquiring = start(turn, binding);
        const acquisition = await observeTurnAcquisition(
          acquiring,
          operationDeadline,
          slot.settled,
        );
        if (acquisition.kind !== "turn") {
          const reason =
            acquisition.kind === "result" && acquisition.settlement.kind === "accepted"
              ? "result slot settled before native turn acquisition"
              : "operation deadline exceeded before native turn acquisition";
          this.abandonTurnAcquisition(acquiring, reason);
          await this.options.slots.close(slot.capability);
          const settlement =
            acquisition.kind === "result" ? acquisition.settlement : await slot.settled;
          const usage = workflowUsage(this.key, operationId, this.execution, []);
          saveUsage(usage);
          return {
            outcome: reconcile<T>(
              settlement.kind === "accepted" ? unresolvedReleaseOutcome() : "expired",
              settlement,
              usage,
            ),
            usage,
          };
        }
        nativeTurn = acquisition.turn;
        if (scope?.cancelled || Date.now() >= operationDeadline.unixMilliseconds) {
          this.abandonTurnAcquisition(
            Promise.resolve(nativeTurn),
            "operation deadline exceeded during native turn acquisition",
          );
          await this.options.slots.close(slot.capability);
          const settlement = await slot.settled;
          const usage = workflowUsage(this.key, operationId, this.execution, []);
          saveUsage(usage);
          return {
            outcome: reconcile<T>("expired", settlement, usage),
            usage,
          };
        }
      } catch (error) {
        const native: HarnessTurnOutcome = {
          state: error instanceof DeadlineExceededError ? "timed-out" : "failed",
          detail:
            error instanceof DeadlineExceededError
              ? "operation deadline exceeded"
              : safeOperationReason(error, this.options.authorities()),
          resultEvidence: { kind: "unavailable" },
          nativeUsage: [],
        };
        void this.close(native.detail).catch(() => undefined);
        await this.options.slots.close(slot.capability);
        const settlement = await slot.settled;
        const usage = workflowUsage(this.key, operationId, this.execution, []);
        saveUsage(usage);
        return {
          outcome: reconcile<T>(native, settlement, usage),
          usage,
        };
      }
      removeCanceller = scope?.add((reason) => requestTurnRelease(nativeTurn!, reason));
      let settlement: ResultSlotSettlement | undefined;
      let native: HarnessTurnOutcome | "expired";
      let nativeReleaseAttempted = false;
      let nativeReleaseResolved = false;
      const first = await observeTurnAndResult(
        nativeTurn,
        operationDeadline,
        slot.settled,
      );
      const samples: NativeUsage[] = [];
      if (first.kind === "result") {
        settlement = first.settlement;
        if (settlement.kind === "accepted") {
          nativeReleaseAttempted = true;
          const released = await releaseSettledTurn(nativeTurn, "result slot settled");
          native = released ?? unresolvedReleaseOutcome();
          if (released) {
            nativeReleaseResolved = true;
            samples.push(...released.nativeUsage);
          }
        } else {
          native = "expired";
        }
      } else {
        native = first.native;
        if (native !== "expired") samples.push(...native.nativeUsage);
      }
      settlement ??= await settledNow(slot.settled);
      if (
        settlement === undefined &&
        native !== "expired" &&
        native.state === "completed" &&
        nudge &&
        nudgeDeadline
      ) {
        try {
          const acquiring = nativeTurn.nudge({
            id: `${turnId}:nudge`,
            prompt: operationPrompt(
              nudge.prompt ??
                "You finished without reporting the requested result. Report it now.",
              schema,
            ),
            deadline: nudgeDeadline,
          });
          const acquisition = await observeTurnAcquisition(
            acquiring,
            nudgeDeadline,
            slot.settled,
          );
          if (acquisition.kind !== "turn") {
            const reason =
              acquisition.kind === "result" && acquisition.settlement.kind === "accepted"
                ? "result slot settled before native nudge acquisition"
                : "operation deadline exceeded before native nudge acquisition";
            this.abandonTurnAcquisition(acquiring, reason);
            nativeReleaseAttempted = true;
            settlement =
              acquisition.kind === "result" ? acquisition.settlement : undefined;
            native = settlement?.kind === "accepted" ? unresolvedReleaseOutcome() : "expired";
          } else {
            nativeTurn = acquisition.turn;
            if (scope?.cancelled || Date.now() >= nudgeDeadline.unixMilliseconds) {
              this.abandonTurnAcquisition(
                Promise.resolve(nativeTurn),
                "operation deadline exceeded during native nudge acquisition",
              );
              nativeReleaseAttempted = true;
              native = "expired";
            } else {
              const nudged = await observeTurnAndResult(
                nativeTurn,
                nudgeDeadline,
                slot.settled,
              );
              if (nudged.kind === "result") {
                settlement = nudged.settlement;
                if (settlement.kind === "accepted") {
                  nativeReleaseAttempted = true;
                  const released = await releaseSettledTurn(nativeTurn, "result slot settled");
                  native = released ?? unresolvedReleaseOutcome();
                  if (released) {
                    nativeReleaseResolved = true;
                    samples.push(...released.nativeUsage);
                  }
                } else {
                  native = "expired";
                }
              } else {
                native = nudged.native;
              }
              if (nudged.kind === "native" && native !== "expired") {
                samples.push(...native.nativeUsage);
              }
            }
          }
        } catch (error) {
          native = {
            state: error instanceof DeadlineExceededError ? "timed-out" : "failed",
            detail: safeOperationReason(error, this.options.authorities()),
            resultEvidence: { kind: "unavailable" },
            nativeUsage: [],
          };
        }
      }
      if (
        native === "expired" ||
        (native.state !== "completed" && !nativeReleaseResolved)
      ) {
        const reason =
          native === "expired"
            ? "operation deadline exceeded"
            : native.detail ?? `native turn ${native.state}`;
        if (!nativeReleaseAttempted) await requestTurnRelease(nativeTurn, reason);
        void this.close(reason).catch(() => undefined);
      }
      await this.options.slots.close(slot.capability);
      settlement ??= await slot.settled;
      const usage = workflowUsage(
        this.key,
        operationId,
        this.execution,
        samples,
      );
      saveUsage(usage);
      return {
        outcome: reconcile<T>(
          native === "expired"
            ? native
            : protectHarnessOutcome(native, this.options.authorities()),
          settlement,
          usage,
        ),
        usage,
      };
    } catch (error) {
      await this.options.slots.close(slot.capability);
      throw error;
    } finally {
      removeCanceller?.();
    }
  }

  private beforeDispatchTimeout<T extends JsonValue>(operationId: string): RunResult<T> {
    const saveUsage = this.options.reserveUsage();
    const usage = workflowUsage(this.key, operationId, this.execution, []);
    saveUsage(usage);
    return {
      outcome: { kind: "timed-out", reason: "operation deadline exceeded", usage },
      usage,
    };
  }

  private abandonTurnAcquisition(
    acquiring: Promise<HarnessTurn>,
    reason: string,
  ): void {
    const lateRelease = acquiring.then(
      (turn) => requestTurnRelease(turn, reason),
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

async function nativeBeforeDeadline(
  turn: HarnessTurn,
  deadline: AbsoluteDeadline,
): Promise<HarnessTurnOutcome | "expired"> {
  let cancelTimer: (() => void) | undefined;
  const expired = new Promise<"expired">((resolve) => {
    cancelTimer = scheduleAt(deadline, () => resolve("expired"));
  });
  return Promise.race([turn.settled, expired]).finally(() => cancelTimer?.());
}

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
      settlement.then(
        (value): TurnAcquisition => ({ kind: "result", settlement: value }),
      ),
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
  return Promise.race([
    nativeBeforeDeadline(turn, deadline).then(
      (native): TurnObservation => ({ kind: "native", native }),
    ),
    settlement.then(
      (value): TurnObservation => ({ kind: "result", settlement: value }),
    ),
  ]);
}

async function releaseSettledTurn(
  turn: HarnessTurn,
  reason: string,
): Promise<HarnessTurnOutcome | undefined> {
  const deadline = { unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS };
  try {
    const disposition = await waitForDeadline(turn.release(reason, deadline), deadline);
    return disposition.kind === "released" ? disposition.outcome : undefined;
  } catch {
    return undefined;
  }
}

function unresolvedReleaseOutcome(): HarnessTurnOutcome {
  return {
    state: "cancelled",
    detail: "native work was quarantined after result settlement",
    resultEvidence: { kind: "unavailable" },
    nativeUsage: [],
  };
}

function reconcile<T extends JsonValue>(
  native: HarnessTurnOutcome | "expired",
  settlement: ResultSlotSettlement,
  usage: TurnUsage,
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
  return schema ? (schema.jsonSchema as JsonSchema) : { type: "string" };
}

function operationPrompt(prompt: string, schema: JsonSchema): string {
  return [
    prompt,
    "",
    "When the answer is ready, return it by running:",
    "",
    "  wf result '<json>'",
    "",
    `The JSON value must match this shape: ${describe(schema)}`,
    "If wf rejects the value, correct it and run wf result again.",
    "Only a value accepted by wf counts as the result.",
  ].join("\n");
}

function workflowUsage(
  agent: string,
  operationId: string,
  execution: AgentExecution,
  samples: readonly NativeUsage[],
): TurnUsage {
  const tokens = {
    ...sumField(samples, "inputTokens", "input"),
    ...sumField(samples, "outputTokens", "output"),
    ...sumField(samples, "cachedInputTokens", "cacheRead"),
  };
  const costs = samples
    .map((sample) => sample.costUsd)
    .filter((amount): amount is number => amount !== undefined);
  const { settings: _settings, ...usageExecution } = execution;
  return {
    callPath: [],
    agent,
    operationId,
    execution: usageExecution as UsageExecution,
    ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
    ...(costs.length > 0
      ? {
          cost: {
            amount: costs.reduce((total, amount) => total + amount, 0),
            currency: "USD",
            basis: "charged" as const,
          },
        }
      : {}),
  };
}

function sumField(
  samples: readonly NativeUsage[],
  source: "inputTokens" | "outputTokens" | "cachedInputTokens",
  target: "input" | "output" | "cacheRead",
): Partial<Record<"input" | "output" | "cacheRead", number>> {
  const values = samples
    .map((sample) => sample[source])
    .filter((value): value is number => value !== undefined);
  return values.length > 0
    ? { [target]: values.reduce((total, value) => total + value, 0) }
    : {};
}

function safeOperationReason(error: unknown, authorities: readonly string[]): string {
  const reason = error instanceof Error ? error.message : String(error);
  return containsAuthority(reason, authorities)
    ? "harness operation failed without safe diagnostic detail"
    : reason;
}

function protectHarnessOutcome(
  outcome: HarnessTurnOutcome,
  authorities: readonly string[],
): HarnessTurnOutcome {
  const transcript = outcome.resultEvidence.kind === "transcript"
    ? outcome.resultEvidence.text
    : undefined;
  const unsafe =
    (outcome.detail && containsAuthority(outcome.detail, authorities)) ||
    (transcript !== undefined && containsAuthority(transcript, authorities));
  if (!unsafe) return outcome;
  return {
    ...outcome,
    ...(outcome.detail
      ? { detail: "harness operation produced no safe diagnostic detail" }
      : {}),
    resultEvidence: { kind: "unavailable" },
  };
}

function containsAuthority(text: string, authorities: readonly string[]): boolean {
  const decodedHex = text.replace(/\\x([0-9a-fA-F]{2})/g, (_match, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 16)),
  );
  const decodedEscapes = decodedHex.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_match, digits: string) => String.fromCharCode(Number.parseInt(digits, 16)),
  );
  return authorities.some(
    (authority) => text.includes(authority) || decodedEscapes.includes(authority),
  );
}

function requestTurnRelease(turn: HarnessTurn, reason: string): Promise<void> {
  return Promise.resolve().then(async () => {
    try {
      const deadline = {
        unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS,
      };
      await waitForDeadline(turn.release(reason, deadline), deadline);
    } catch {
      // The timeout/caller cancellation remains authoritative over adapter diagnostics.
    }
  });
}

function resolveExecution(
  selection: RuntimeSelection,
  runtime: AgentRuntimeConfig,
): AgentExecution {
  if (typeof selection === "string") return assertSupportedExecution(resolveAlias(selection, runtime));
  if ("alias" in selection) {
    const resolved = resolveAlias(selection.alias, runtime);
    for (const field of ["harness", "model", "settings"] as const) {
      const required = selection[field];
      if (required !== undefined && !isDeepStrictEqual(required, resolved[field])) {
        throw new Error(`runtime alias ${selection.alias} does not satisfy required ${field}`);
      }
    }
    return assertSupportedExecution(resolved);
  }
  return assertSupportedExecution(structuredClone(selection));
}

function constrainExistingExecution(
  selection: RuntimeSelection,
  existing: AgentExecution,
): AgentExecution {
  if (typeof selection === "string") {
    if (existing.alias !== selection) {
      throw new Error(`existing agent does not use runtime alias ${selection}`);
    }
    return existing;
  }
  if ("alias" in selection) {
    if (existing.alias !== selection.alias) {
      throw new Error(`existing agent does not use runtime alias ${selection.alias}`);
    }
    for (const field of ["harness", "model", "settings"] as const) {
      const required = selection[field];
      if (required !== undefined && !isDeepStrictEqual(required, existing[field])) {
        throw new Error(`existing agent does not satisfy required ${field}`);
      }
    }
    return existing;
  }
  if (!isDeepStrictEqual(selection, withoutAlias(existing))) {
    throw new Error("existing agent uses a different runtime configuration");
  }
  return existing;
}

function withoutAlias(execution: AgentExecution): Omit<AgentExecution, "alias"> {
  const { alias: _alias, ...config } = execution;
  return config;
}

function resolveAlias(alias: string, runtime: AgentRuntimeConfig): AgentExecution {
  const selected = runtime.aliases[alias];
  if (!selected) throw new Error(`unknown runtime alias: ${alias}`);
  return { ...structuredClone(selected), alias };
}

function assertSupportedExecution(execution: AgentExecution): AgentExecution {
  if (execution.settings !== undefined) {
    throw new Error("model settings are not implemented by this runner");
  }
  return execution;
}

function assertMinimumLifecycle(spec: AgentOpenSpec): void {
  if (spec.lifecycle?.retention.kind !== undefined && spec.lifecycle.retention.kind !== "workflow") {
    throw new Error("agent retention other than workflow is not implemented by this runner");
  }
  if (spec.lifecycle?.recovery) {
    throw new Error("agent crash recovery is not implemented by this runner");
  }
}

function assertCompatibleAgent(
  key: string,
  existing: AgentIdentity,
  requested: AgentIdentity,
  spec: AgentOpenSpec,
): void {
  if (!isDeepStrictEqual(existing.execution, requested.execution)) conflict(key, "runtime");
  if (spec.cwd !== undefined && existing.cwd !== requested.cwd) conflict(key, "cwd");
  for (const field of ["instructions", "lifecycle", "skills", "labels"] as const) {
    if (spec[field] !== undefined && !isDeepStrictEqual(existing[field], requested[field])) {
      conflict(key, field);
    }
  }
}

function conflict(key: string, field: string): never {
  throw new Error(`agent ${key} is already open with different ${field}`);
}

function assertDeadline(deadline: AbsoluteDeadline): void {
  assertDeadlineValue(deadline);
  if (Date.now() >= deadline.unixMilliseconds) {
    throw new DeadlineExceededError(deadline);
  }
}

function assertDeadlineValue(deadline: AbsoluteDeadline): void {
  if (
    !Number.isSafeInteger(deadline.unixMilliseconds) ||
    deadline.unixMilliseconds < 0
  ) {
    throw new Error("deadline.unixMilliseconds must be a non-negative safe integer");
  }
}

function earlierDeadline(left: AbsoluteDeadline, right: AbsoluteDeadline): AbsoluteDeadline {
  return left.unixMilliseconds <= right.unixMilliseconds ? left : right;
}

function laterDeadline(left: AbsoluteDeadline, right: AbsoluteDeadline): AbsoluteDeadline {
  return left.unixMilliseconds >= right.unixMilliseconds ? left : right;
}

async function settledNow<T>(promise: Promise<T>): Promise<T | undefined> {
  const pending = Symbol("pending");
  const result = await Promise.race([promise, Promise.resolve(pending)]);
  return result === pending ? undefined : result;
}

function scheduleAt(deadline: AbsoluteDeadline, action: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = deadline.unixMilliseconds - Date.now();
    if (remaining <= 0) {
      action();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

function waitForDeadline<T>(promise: Promise<T>, deadline: AbsoluteDeadline): Promise<T> {
  let cancelTimer: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    cancelTimer = scheduleAt(deadline, () => reject(new DeadlineExceededError(deadline)));
  });
  return Promise.race([promise, expired]).finally(() => cancelTimer?.());
}

function unavailable(name: string): Promise<never> {
  return Promise.reject(new Error(`${name} is not implemented by the minimum workflow runner`));
}
