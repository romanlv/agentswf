import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentSkillsRecord,
  RunAccounting,
  SandboxRecord,
  SettledDecision,
  SettledOperation,
} from "@agentswf/contract/records";
import { type JsonSchema, parseJsonSchema } from "@agentswf/contract/schema";
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
  type CompactSpec,
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
  type SkillSource,
  type TurnOutcome,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { type AgentSkills, findHarness, hostHome, skillsLayout } from "@agentswf/harness";
import type {
  AgentRunHost,
  AgentRuntimeConfig,
  AuthoredTurn,
  HarnessActivation,
  HarnessAuthored,
  HarnessReleaseDisposition,
  HarnessSession,
  HarnessTurn,
  HarnessTurnOutcome,
} from "@agentswf/harness/adapter";
import type { Occupant } from "@agentswf/sandbox";
import { PUBLISHED_PRICES } from "./accounting/prices";
import { summarizeRun } from "./accounting/summary";
import { buildAgentBundle, installAgentLauncher, installSandboxedDoor } from "./agent-launcher";
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
import { RunDecisions } from "./decisions/directory";
import type { DecisionInstallation } from "./decisions/seam";
import { messageOf } from "./errors";
import {
  createResultSlotRegistry,
  type ResultSlotRegistry,
  type ResultSlotSettlement,
} from "./result-slots";
import { createRunDir } from "./run-dir";
import { type AgentProgress, RunProgress, type StageProgress } from "./run-progress";
import {
  type AccountedAgent,
  type AgentLedger,
  createRunLedger,
  type RunLedger,
} from "./run-usage";
import { type CredentialLocks, seedHome } from "./sandbox-homes";
import {
  RUN_SANDBOX_ONLY,
  RunSandboxes,
  type RunSandboxOptions,
  type SeatedAgent,
} from "./sandboxes";
import { placeSkills, RunSkills, readSkillSources } from "./skills/run-skills";

export { WorkflowCancelledError } from "./deadlines";

export type RunWorkflowOptions = {
  runRoot: string;
  runtime: AgentRuntimeConfig;
  deadline: AbsoluteDeadline;
  cwd?: string;
  onLog?: (message: string, fields?: JsonObject) => void;
  signal?: AbortSignal;
  /** The sandbox providers agents may run in; without them, a sandboxed agent is refused. */
  sandboxes?: RunSandboxOptions;
  /** Where public skills are fetched to, shared by runs; `$XDG_CACHE_HOME/awf/skills` by default. */
  skillCache?: string;
  /** The decision models workflows may ask; without them, `decisions.decide` is refused. */
  decisions?: DecisionInstallation;
};

/** What a run is known by once it has ended, whether or not it succeeded. */
export type SettledRun = {
  runId: string;
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
  /** Each sandbox the run opened, with its agents; absent when it opened none. */
  sandboxes?: SandboxRecord[];
  /** Each agent's skills; absent when no agent opened. */
  skills?: AgentSkillsRecord[];
  /** Every decision the run asked, in the order asked; absent when it asked none. */
  decisions?: SettledDecision[];
};

export type WorkflowRunResult<Result extends JsonValue> = SettledRun & { value: Result };

/**
 * A run that failed after its host opened, carrying what it spent. `cause` is the run's own error:
 * the body's, or an `AggregateError` with the cleanup's.
 */
export class WorkflowRunError extends Error implements SettledRun {
  readonly runId: string;
  readonly usage: SettledOperation[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly accounting: RunAccounting;
  readonly sandboxes?: SandboxRecord[];
  readonly skills?: AgentSkillsRecord[];
  readonly decisions?: SettledDecision[];

  constructor(cause: unknown, run: SettledRun) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "WorkflowRunError";
    this.runId = run.runId;
    this.usage = run.usage;
    this.startedAt = run.startedAt;
    this.finishedAt = run.finishedAt;
    this.accounting = run.accounting;
    if (run.sandboxes) this.sandboxes = run.sandboxes;
    if (run.skills) this.skills = run.skills;
    if (run.decisions) this.decisions = run.decisions;
  }
}

export type WorkflowRunHandle<Result extends JsonValue> = {
  runId: string;
  result: Promise<WorkflowRunResult<Result>>;
  inspect(): WorkflowRunSnapshot;
  stop(reason?: unknown): Promise<void>;
};

export type WorkflowRunSnapshot = {
  state: "starting" | "running" | "closing" | "closed";
  /** Labelled `parallel` calls, in the order they began. */
  stages: readonly StageProgress[];
  agents: readonly (Partial<AgentProgress> & {
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
  })[];
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
  /** As the agent was first opened with it: a ref, an inline spec, or absent. */
  sandbox?: unknown;
  /** Its skills' sources, checked; absent when it has the operator's. */
  skills?: SkillSource[];
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
  const progress = new RunProgress();
  // Shared by sandboxed agents' homes and a host agent's own: they may copy one credential.
  const locks: CredentialLocks = new Map();
  const environment = options.sandboxes?.environment ?? process.env;
  const sandboxes = new RunSandboxes({
    ...(options.sandboxes ? { sandboxes: options.sandboxes } : {}),
    locks,
    runDir,
    runRoot: options.runRoot,
    cwd,
    deadline: options.deadline,
    log: (message) => options.onLog?.(message),
  });
  if (sandboxes.hasRunSandbox) {
    try {
      await runUntilStopped(() => sandboxes.openRunSandbox(), options.signal, options.deadline);
    } catch (error) {
      await sandboxes.close().catch(() => undefined);
      await host.close("the run's sandbox did not open").catch(() => undefined);
      await control.close();
      if (error instanceof WorkflowCancelledError || error instanceof DeadlineExceededError) {
        throw error;
      }
      throw new Error(`the run's sandbox did not open: ${messageOf(error)}`);
    }
  }
  const decisions = new RunDecisions({
    ...(options.decisions ? { installation: options.decisions } : {}),
    runDir,
  });
  const skills = new RunSkills({
    runDir,
    ...(options.skillCache === undefined ? {} : { cacheRoot: options.skillCache }),
    environment,
  });
  const owner = new WorkflowOwner({
    decisions,
    sandboxes,
    skills,
    runDir,
    locks,
    environment,
    progress,
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
  // Aborted by a stop that comes after the body ended; the one that ended it does not cut short the
  // read of what it spent.
  const reading = new AbortController();
  let bodyEnded = false;
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
    bodyEnded = true;
    const cutReading = () => reading.abort();
    if (!signal.aborted) signal.addEventListener("abort", cutReading, { once: true });

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

    // Before the wait for session files, which is bookkeeping rather than the run's own time.
    const finishedAt = new Date().toISOString();
    const usage = await ledger.settle(reading.signal);
    signal.removeEventListener("abort", cutReading);
    const times = { startedAt: new Date(startedAt).toISOString(), finishedAt };
    const opened = sandboxes.records();
    const given = skills.records();
    const asked = decisions.records();
    const settled: SettledRun = {
      runId,
      usage,
      ...times,
      accounting: summarizeRun(usage, PUBLISHED_PRICES, times, asked),
      ...(opened.length > 0 ? { sandboxes: opened } : {}),
      ...(given.length > 0 ? { skills: given } : {}),
      ...(asked.length > 0 ? { decisions: asked } : {}),
    };
    if (failed) {
      throw new WorkflowRunError(
        cleanupErrors.length > 0
          ? new AggregateError([failure, ...cleanupErrors], "workflow and cleanup failed")
          : failure,
        settled,
      );
    }
    if (cleanupErrors.length > 0) {
      throw new WorkflowRunError(
        new AggregateError(cleanupErrors, "workflow cleanup failed"),
        settled,
      );
    }
    return { ...settled, value: value as Result };
  })();

  return {
    runId,
    result,
    inspect: () => {
      const { state, agents } = structuredClone(host.inspect());
      const known = progress.snapshot();
      return {
        state,
        stages: known.stages,
        agents: agents.map((agent) => ({ ...known.agents.get(agent.key), ...agent })),
      };
    },
    async stop(reason) {
      stopped.abort(reason);
      if (bodyEnded) reading.abort();
      try {
        await result;
      } catch (error) {
        const cause = error instanceof WorkflowRunError ? error.cause : error;
        if (!(cause instanceof WorkflowCancelledError)) throw error;
      }
    },
  };
}

/** An agent's sessions, as its launcher reports them and as its harness session knows them. */
type AgentSessions = { launcher: Set<string>; harness?: HarnessSession };

/** What both ways of opening an agent share. */
type AgentOpening = {
  spec: AgentOpenSpec;
  execution: AgentExecution;
  deadline: AbsoluteDeadline;
  sessions: AgentSessions;
  ledger: AgentLedger;
  /** Its skills' sources, resolved when it opens; absent when it has the operator's. */
  skills?: SkillSource[];
  /** The host's activation for the agent, working in `cwd`, inside `occupant` if sandboxed. */
  activation(cwd: string, occupant?: Occupant, skills?: AgentSkills): HarnessActivation;
};

class WorkflowOwner {
  readonly context: WorkflowContext;
  readonly #agents = new Map<string, AgentEntry>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<unknown[]> | undefined;
  /** The bundled `wf`'s source, built once, at the first sandboxed agent. */
  #bundle: Promise<string> | undefined;

  constructor(
    private readonly options: {
      sandboxes: RunSandboxes;
      skills: RunSkills;
      runDir: string;
      locks: CredentialLocks;
      environment: Readonly<Record<string, string | undefined>>;
      decisions: RunDecisions;
      runId: string;
      cwd: string;
      deadline: AbsoluteDeadline;
      runtime: AgentRuntimeConfig;
      host: AgentRunHost;
      slots: ResultSlotRegistry;
      control: ResultControlPlane;
      ledger: RunLedger;
      progress: RunProgress;
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
      sandboxes: {
        open: (spec) => {
          if (this.#closed) return Promise.reject(new Error("workflow context is closed"));
          return this.track(options.sandboxes.open(spec));
        },
      },
      decisions: {
        decide: (spec) => {
          if (this.#closed) return Promise.reject(new Error("workflow context is closed"));
          const scope = scopes.getStore();
          try {
            scope?.assertAccepting();
          } catch (error) {
            return Promise.reject(error);
          }
          const decided = this.track(
            options.decisions.decide(spec, {
              deadline: scope?.deadline ?? options.deadline,
              ...(scope ? { add: (cancel) => scope.add(cancel) } : {}),
            }),
          );
          scope?.track(decided);
          return decided;
        },
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
        const label = parallelOptions?.label;
        return runParallel(items, operation, deadline, parallelOptions?.concurrency, () =>
          label === undefined ? undefined : options.progress.stage(label, items.length),
        );
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
        // A call nobody awaited any more is cancelled and recorded, not left to its deadline.
        this.options.decisions.close().then(() => Promise.allSettled([...this.#inFlight])),
      ]).then(async ([settled]) => {
        // Once their sessions are closed: nothing of theirs runs inside any more.
        const released = await this.options.sandboxes.release();
        // Only now: an agent can still be submitting from inside its own close, and taking its
        // socket away first turns that into a connection error it cannot report.
        await Promise.allSettled(
          [...this.#agents.values()].map((agent) => agent.channel.then((c) => c?.close())),
        );
        // Last, after every agent in each: closing a sandbox ends what runs in it.
        const closed = await this.options.sandboxes.close();
        return [
          ...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
          ...released,
          ...closed,
        ];
      });
      try {
        return await waitForDeadline(cleanup, deadline);
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          // A session that would not close still must not outlive its sandbox: its agents are
          // released and the sandboxes closed, which ends everything inside, on a grace of their own.
          const sandboxes = this.options.sandboxes;
          const closed = await waitForDeadline(
            sandboxes
              .release()
              .then(async (released) => [...released, ...(await sandboxes.close())]),
            { unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS },
          ).catch((late: unknown) => [late]);
          return [
            new Error(`agent cleanup exceeded ${CLEANUP_GRACE_MILLISECONDS}ms shutdown grace`),
            ...closed,
          ];
        }
        throw error;
      }
    })();
    return this.#closing;
  }

  private openAgent(spec: AgentOpenSpec): Promise<AgentRef> {
    if (this.#closed) throw new Error("workflow context is closed");
    scopes.getStore()?.assertAccepting();
    const inRunSandbox = this.options.sandboxes.hasRunSandbox;
    if (inRunSandbox && spec.sandbox !== undefined)
      throw new Error(`agent ${spec.key}: ${RUN_SANDBOX_ONLY}`);
    const existing = this.#agents.get(spec.key);
    const execution = existing
      ? constrainExistingExecution(spec.runtime, existing.identity.execution)
      : resolveExecution(spec.runtime, this.options.runtime);
    const identity: AgentIdentity = {
      execution,
      cwd: spec.cwd ?? this.options.cwd,
      ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
      ...(spec.labels === undefined ? {} : { labels: structuredClone(spec.labels) }),
      ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
      ...(spec.skills === undefined ? {} : { skills: readSkillSources(spec.skills) }),
    };
    const scope = scopes.getStore();
    const inheritedDeadline = scope?.deadline ?? this.options.deadline;
    const effectiveDeadline = spec.deadline
      ? earlierDeadline(spec.deadline, inheritedDeadline)
      : inheritedDeadline;
    assertDeadline(effectiveDeadline);
    if (existing) {
      assertCompatibleAgent(spec.key, existing.identity, identity, spec);
      const seated =
        spec.sandbox === undefined
          ? existing.state
          : this.assertSameSandbox(spec.key, existing.identity, spec.sandbox).then(
              () => existing.state,
            );
      const attached = this.track(waitForDeadline(seated, effectiveDeadline));
      scope?.track(attached);
      return attached;
    }

    this.options.progress.agentOpened(spec.key, scope?.stage);
    // Opened before the session so registration below stays synchronous: two concurrent `agent()`
    // calls for one key must not each build an agent.
    const sessions: AgentSessions = { launcher: new Set() };
    const accounted: AccountedAgent = {
      key: spec.key,
      execution,
      cwd: identity.cwd,
      sessions: () => [
        ...new Set([...sessions.launcher, ...(sessions.harness?.sessions?.() ?? [])]),
      ],
    };
    const opening: AgentOpening = {
      spec,
      execution,
      deadline: effectiveDeadline,
      sessions,
      ledger: this.options.ledger.agent(accounted),
      ...(identity.skills ? { skills: identity.skills } : {}),
      activation: (cwd, occupant, skills) => ({
        key: spec.key,
        deadline: effectiveDeadline,
        cwd,
        execution,
        ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
        ...(spec.labels === undefined ? {} : { labels: spec.labels }),
        ...(occupant ? { occupant } : {}),
        ...(skills ? { skills } : {}),
      }),
    };
    const { state, channel } =
      spec.sandbox === undefined && !inRunSandbox
        ? this.openHostAgent(opening, identity.cwd, accounted)
        : this.openSandboxedAgent(opening, identity.cwd, accounted);
    const ownedState = this.track(state);
    this.#agents.set(spec.key, {
      identity,
      state: ownedState,
      // Never rejects: the failure is already carried by `state`, and a second copy with no
      // reader is an unhandled rejection that takes the process down with it.
      channel: channel.then(
        (opened) => opened,
        () => undefined,
      ),
    });
    const activated = this.track(waitForDeadline(ownedState, effectiveDeadline));
    scope?.track(activated);
    return activated;
  }

  /**
   * An agent on the host: its skills placed first, since a source that will not resolve refuses the
   * agent before it holds anything, then its channel and session together.
   */
  private openHostAgent(
    { spec, execution, sessions, ledger, activation, skills: sources }: AgentOpening,
    cwd: string,
    accounted: AccountedAgent,
  ): { state: Promise<LogicalAgent>; channel: Promise<ResultChannel> } {
    const placed = this.placeHostSkills(spec.key, execution, cwd, sources);
    const opened = placed.then((skills) => {
      if (skills?.given.ownHome) accounted.home = skills.given.ownHome;
      return this.options.control.openChannel(spec.key, (id) => sessions.launcher.add(id));
    });
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
    const state = placed
      .then((skills) => this.options.host.openAgent(activation(cwd, undefined, skills?.given)))
      .catch(async (error: unknown) => {
        await closeChannel();
        throw error;
      })
      .then(async (session) => {
        sessions.harness = session;
        let channel: ResultChannel;
        let launcher: string;
        try {
          ({ channel, launcher } = await reachable);
        } catch (error) {
          // A session with no way to answer is no agent at all; neither half outlives the other.
          await Promise.allSettled([session.close(messageOf(error)), closeChannel()]);
          throw error;
        }
        const writeBack = (await placed)?.writeBack;
        return this.logicalAgent(
          spec.key,
          execution,
          session,
          channel.endpoint,
          launcher,
          ledger,
          writeBack ? { writeBack } : undefined,
        );
      });
    return { state, channel: opened };
  }

  /**
   * Copies an agent's skills where its harness reads them on the host: a directory of the agent's
   * own, or, for a harness that finds skills only in its home, a home of its own seeded as a
   * sandboxed agent's is. An agent the workflow named none for keeps the operator's.
   */
  private async placeHostSkills(
    key: string,
    execution: AgentExecution,
    cwd: string,
    sources: SkillSource[] | undefined,
  ): Promise<{ given: AgentSkills; writeBack?: () => Promise<void> } | undefined> {
    if (!sources) {
      this.options.skills.record(key, "operator");
      return undefined;
    }
    const resolved = await this.options.skills.resolve(sources);
    const id = randomUUID();
    // Real paths: claude compares them with its working directory, codex keys its trust by them.
    const [runDir, realCwd] = await Promise.all([realpath(this.options.runDir), realpath(cwd)]);
    const given = skillsLayout(
      execution.harness,
      resolved.map((skill) => skill.name),
      { bundle: join(runDir, "agents", id), cwd: realCwd },
    );
    this.options.skills.record(key, resolved, given.ownHome);
    const { ownHome } = given;
    if (!ownHome) {
      await placeSkills(resolved, given.directory);
      return { given };
    }
    await mkdir(dirname(ownHome), { recursive: true });
    const seeded = await seedHome(
      ownHome,
      join(runDir, "staging", id),
      hostHome(execution.harness, ownHome, this.options.environment),
      realCwd,
      this.options.locks,
      (staged) => placeSkills(resolved, join(staged, relative(ownHome, given.directory))),
    );
    return { given, writeBack: () => seeded.writeBack() };
  }

  /**
   * A sandboxed agent opens in order, each step before the next: its sandbox (a private one opened
   * now), its channel, its door, its home, its admission, then its session. Everything refused
   * about where it runs is refused before a channel opens.
   */
  private openSandboxedAgent(
    { spec, execution, deadline, sessions, ledger, activation, skills: sources }: AgentOpening,
    cwd: string,
    accounted: AccountedAgent,
  ): { state: Promise<LogicalAgent>; channel: Promise<ResultChannel> } {
    const scope = scopes.getStore();
    const opened = (async () => {
      const skills = sources ? await this.options.skills.resolve(sources) : undefined;
      const seat = await this.options.sandboxes.seat({
        key: spec.key,
        sandbox: spec.sandbox,
        cwd,
        execution,
        ...(skills ? { skills } : {}),
      });
      // Once it has a place: an agent refused one was given nothing. In a sandbox, none named is
      // none had, as its fresh home holds none of the operator's.
      this.options.skills.record(spec.key, skills ?? []);
      // What the agent really ran in, which is where accounting finds its sessions.
      accounted.cwd = seat.cwd;
      accounted.home = seat.home;
      let channel: ResultChannel | undefined;
      try {
        channel = await this.options.control.openChannel(spec.key, (id) =>
          sessions.launcher.add(id),
        );
        const door = await installSandboxedDoor(
          dirname(channel.endpoint),
          channel.endpoint,
          await this.bundle(),
          findHarness(execution.harness)?.sessionEnv,
        );
        // The last step before the agent holds anything inside; its bound may be gone by now.
        assertDeadline(deadline);
        scope?.assertActive();
        const seated = await seat.admit(door);
        return { seat, seated, channel, launcher: door.launcher };
      } catch (error) {
        // The channel first, as at run end; neither undoing masks why the agent did not open.
        await channel?.close().catch(() => undefined);
        await seat.abandon();
        throw error;
      }
    })();
    const state = opened.then(async ({ seat, seated, channel, launcher }) => {
      let session: HarnessSession;
      try {
        session = await this.options.host.openAgent(
          activation(seat.cwd, seated.occupant, seat.skills),
        );
      } catch (error) {
        await seated.release().catch(() => undefined);
        await channel.close().catch(() => undefined);
        await seat.abandon();
        throw error;
      }
      sessions.harness = session;
      return this.logicalAgent(
        spec.key,
        execution,
        session,
        channel.endpoint,
        launcher,
        ledger,
        seated,
      );
    });
    return { state, channel: opened.then(({ channel }) => channel) };
  }

  private logicalAgent(
    key: string,
    execution: AgentExecution,
    session: HarnessSession,
    endpoint: string,
    launcher: string,
    ledger: AgentLedger,
    seated?: Pick<SeatedAgent, "writeBack">,
  ): LogicalAgent {
    return new LogicalAgent({
      key,
      execution,
      session,
      slots: this.options.slots,
      endpoint,
      launcher,
      deadline: this.options.deadline,
      ledger,
      progress: this.options.progress,
      track: (promise) => this.track(promise),
      isRunClosing: () => this.#closed,
      ...(seated
        ? {
            // A turn may have refreshed the agent's credential; the operator's copy follows it.
            afterOperation: () =>
              seated
                .writeBack()
                .catch((error) => this.options.onLog?.(`agent ${key}: ${messageOf(error)}`)),
          }
        : {}),
    });
  }

  private bundle(): Promise<string> {
    this.#bundle ??= buildAgentBundle();
    const building = this.#bundle;
    // A build that failed is tried again by the next agent, not remembered.
    building.catch(() => {
      if (this.#bundle === building) this.#bundle = undefined;
    });
    return building;
  }

  /** A reopened agent names the sandbox it runs in, or none: a different one is a conflict. */
  private async assertSameSandbox(
    key: string,
    existing: AgentIdentity,
    sandbox: unknown,
  ): Promise<void> {
    if (!(await this.options.sandboxes.same(key, existing.sandbox, sandbox, existing.cwd))) {
      conflict(key, "sandbox");
    }
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
  readonly #compactions = new Map<
    string,
    { spec: CompactSpec; result: Promise<TurnOutcome<string>> }
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
      progress: RunProgress;
      track<T>(promise: Promise<T>): Promise<T>;
      isRunClosing(): boolean;
      /** After each operation settles, whatever its outcome. */
      afterOperation?(): Promise<void>;
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
      const { progress, key } = this.options;
      progress.turnStarted(key);
      try {
        const settled = await this.executeOperation(completeSpec, scope, deadline);
        const { outcome } = settled;
        progress.turnSettled(key, outcome.kind, "reason" in outcome ? outcome.reason : undefined);
        return settled;
      } catch (error) {
        progress.turnSettled(key, "failed", messageOf(error));
        throw error;
      } finally {
        await this.options.afterOperation?.();
      }
    });
    const tracked = this.options.track(result);
    scope?.track(tracked);
    this.#operations.set(id, { spec: completeSpec, result: tracked });
    return tracked as Promise<RunResult<string | T>>;
  }

  compact(spec: CompactSpec): Promise<TurnOutcome<string>> {
    if (this.#closed) return Promise.reject(new Error("logical agent is closed"));
    const scope = scopes.getStore();
    try {
      scope?.assertAccepting();
      assertDeadlineValue(spec.deadline);
    } catch (error) {
      return Promise.reject(error);
    }
    const completeSpec = structuredClone(spec);
    const existing = this.#compactions.get(spec.id);
    if (existing) {
      if (!isDeepStrictEqual(existing.spec, completeSpec)) {
        const rejected = Promise.reject<TurnOutcome<string>>(
          new Error(`compaction id ${spec.id} was reused with a different specification`),
        );
        scope?.track(rejected);
        return rejected;
      }
      scope?.track(existing.result);
      return existing.result;
    }
    const result = this.queue(async () => {
      if (this.#closed || this.options.isRunClosing()) {
        throw new Error("logical agent is closed");
      }
      scope?.assertActive();
      const { progress, key } = this.options;
      progress.turnStarted(key);
      try {
        const outcome = await this.executeCompaction(completeSpec, scope);
        progress.turnSettled(key, outcome.kind, "reason" in outcome ? outcome.reason : undefined);
        return outcome;
      } catch (error) {
        progress.turnSettled(key, "failed", messageOf(error));
        throw error;
      } finally {
        await this.options.afterOperation?.();
      }
    });
    const tracked = this.options.track(result);
    scope?.track(tracked);
    this.#compactions.set(spec.id, { spec: completeSpec, result: tracked });
    return tracked;
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
      return { outcome: reconcile<JsonValue>(native, settled, usage) };
    };
    let removeCanceller: (() => void) | undefined;
    try {
      scope?.assertActive();
      if (Date.now() >= operationDeadline.unixMilliseconds) return await finish("expired");
      const authored: AuthoredTurn = {
        prompt: spec.prompt,
        ...(spec.label === undefined ? {} : { label: spec.label }),
        ...(spec.schema === undefined ? {} : { schema: spec.schema }),
      };
      const turn: AgentTextTurnSpec & HarnessAuthored = {
        id: spec.id!,
        prompt: operationPrompt(spec.prompt, schema, this.options.launcher, operationId),
        deadline: operationDeadline,
        authored,
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
          detail: expiry ? "operation deadline exceeded" : messageOf(first.error),
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
        const nudgePrompt =
          nudge.prompt ?? "You finished without reporting the requested result. Report it now.";
        try {
          const again = await this.attemptTurn(
            () =>
              held.turn!.nudge({
                id: `${spec.id!}:nudge`,
                prompt: operationPrompt(nudgePrompt, schema, this.options.launcher, operationId),
                deadline: nudgeDeadline,
                authored: { ...authored, prompt: nudgePrompt },
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
            detail: messageOf(error),
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
   * The harness's own compaction, with the spec's prompt as its focus (ADR 0007). Nothing answers
   * through a result slot: the harness confirms it compacted by setting `summary`. One past its
   * deadline is left to end on its own rather than stopped, which would close a pane's agent.
   */
  private async executeCompaction(
    spec: CompactSpec,
    scope: ExecutionScope | undefined,
  ): Promise<TurnOutcome<string>> {
    const deadline = earlierDeadline(
      spec.deadline,
      scope ? earlierDeadline(scope.deadline, this.options.deadline) : this.options.deadline,
    );
    const entry = this.options.ledger.reserve(randomUUID());
    const times: { deliveredAt?: number } = {};
    const settle = (
      native: HarnessTurnOutcome | "expired",
      /** A compaction left to end on its own, whose charges come when it does. */
      later?: Promise<HarnessTurnOutcome>,
    ): TurnOutcome<string> => {
      const usage = entry.settle(
        {
          ...times,
          settledAt: Math.min(Date.now(), deadline.unixMilliseconds),
        },
        native === "expired" ? [] : native.chargesUsd,
        later,
      );
      if (native === "expired") {
        return { kind: "timed-out", reason: "compaction deadline exceeded", usage };
      }
      if (native.state === "completed") {
        return native.summary === undefined
          ? {
              kind: "failed",
              reason: native.detail ?? "the harness did not confirm a compaction",
              retryable: false,
              usage,
            }
          : { kind: "answered", value: native.summary, usage };
      }
      return reconcile<string>(native, { kind: "closed" }, usage);
    };
    if (Date.now() >= deadline.unixMilliseconds) return settle("expired");
    let turn: HarnessTurn;
    const acquiring = Promise.resolve().then(() =>
      this.options.session.compact(spec.id, spec.prompt, deadline),
    );
    try {
      turn = await waitForDeadline(acquiring, deadline);
    } catch (error) {
      if (error instanceof DeadlineExceededError) {
        // A compaction that starts after all is left to end on its own, as one past its deadline.
        // The agent's next operation waits for it to start, or would race it for the session.
        const late = await waitForDeadline(acquiring, {
          unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS,
        }).catch(() => undefined);
        if (!late) {
          this.abandonTurnAcquisition(acquiring, "compaction deadline exceeded before it started");
          return settle("expired");
        }
        return settle("expired", (await this.leaveFinishing(late)).later);
      }
      return settle({
        state: "failed",
        detail: messageOf(error),
        resultEvidence: { kind: "unavailable" },
        chargesUsd: [],
      });
    }
    times.deliveredAt = Date.now();
    const removeCanceller = scope?.add((reason) => releaseTurn(turn, reason));
    try {
      let cancelTimer: (() => void) | undefined;
      const native = await Promise.race([
        turn.settled,
        new Promise<"expired">((resolve) => {
          cancelTimer = scheduleAt(deadline, () => resolve("expired"));
        }),
      ]).finally(() => cancelTimer?.());
      if (native === "expired") return settle(native, (await this.leaveFinishing(turn)).later);
      return settle(native);
    } finally {
      removeCanceller?.();
    }
  }

  /** Releases a compaction past its deadline to end on its own; its end, when the host left it. */
  private async leaveFinishing(
    turn: HarnessTurn,
  ): Promise<{ later?: Promise<HarnessTurnOutcome> }> {
    const disposition = await releaseTurn(turn, "compaction deadline exceeded", true);
    return disposition?.kind === "finishing" ? { later: turn.settled } : {};
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

  constructor(
    readonly deadline: AbsoluteDeadline,
    readonly stage?: StageProgress,
  ) {}

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
  openStage?: () => StageProgress | undefined,
): Promise<Result[]> {
  assertDeadline(deadline);
  const concurrency = requestedConcurrency ?? Math.max(1, items.length);
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("parallel concurrency must be a positive safe integer");
  }
  const parent = scopes.getStore();
  parent?.assertAccepting();
  if (items.length === 0) return Promise.resolve([]);
  const execution = executeParallel(items, operation, deadline, concurrency, parent, openStage?.());
  parent?.track(execution);
  return execution;
}

async function executeParallel<Item, Result>(
  items: readonly Item[],
  operation: (item: Item, index: number) => Promise<Result>,
  deadline: AbsoluteDeadline,
  concurrency: number,
  parent: ExecutionScope | undefined,
  stage?: StageProgress,
): Promise<Result[]> {
  // An unlabelled parallel inside a stage stays part of it.
  const scope = new ExecutionScope(deadline, stage ?? parent?.stage);
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
        if (stage) stage.started += 1;
        try {
          results[index] = await operation(items[index]!, index);
        } finally {
          if (stage) stage.done += 1;
        }
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
    if (stage) stage.endedAt = Date.now();
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
  if (spec.skills !== undefined && !isDeepStrictEqual(existing.skills, requested.skills)) {
    conflict(key, "skills");
  }
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
