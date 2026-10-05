import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentSkillsRecord,
  RunAccounting,
  SandboxRecord,
  SettledDecision,
  SettledOperation,
} from "@agentswf/contract/records";
import {
  TURN_OPERATION_FIELDS,
  TURN_RECORD_VERSION,
  type TurnRecord,
} from "@agentswf/contract/records";
import {
  formatErrors,
  type JsonSchema,
  parseJsonSchema,
  validate,
} from "@agentswf/contract/schema";
import {
  type AbsoluteDeadline,
  type AgentExecution,
  type AgentForkSpec,
  type AgentKey,
  type AgentOpenSpec,
  type AgentRef,
  type AgentRunStructuredSpec,
  type AgentRunTextSpec,
  type AgentStructuredTurnSpec,
  type AgentTextTurnSpec,
  type CompactionId,
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
  type SettingsSpec,
  type SkillSource,
  type StageOptions,
  type StageSummary,
  type TurnOutcome,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@agentswf/contract/workflow";
import {
  type AgentSkills,
  effortRefusal,
  findHarness,
  hostHome,
  settingsRefusal,
  skillsLayout,
} from "@agentswf/harness";
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
  NativeFork,
  SessionCopy,
  SessionSettings,
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
import { type AgentProgress, type GroupProgress, RunProgress } from "./run-progress";
import {
  type AccountedAgent,
  type AgentLedger,
  createRunLedger,
  type OperationTags,
  type RunLedger,
} from "./run-usage";
import { appendTurn, endTurnsLine, readStageRecords } from "./runs";
import { type CredentialLocks, placeCarried, seedHome } from "./sandbox-homes";
import {
  RUN_SANDBOX_ONLY,
  RunSandboxes,
  type RunSandboxOptions,
  type SeatedAgent,
} from "./sandboxes";
import { placeSkills, RunSkills, readSkillSources } from "./skills/run-skills";
import { StageLedger, type StageProgress } from "./stage-ledger";
import { FromStageUnreached } from "./stopped";

export { WorkflowCancelledError } from "./deadlines";

export type RunWorkflowOptions = {
  runRoot: string;
  /** The run this is an attempt of, whose folder the operator claimed under `runRoot`. */
  run: {
    dir: string;
    id: string;
    attempt: number;
    /** How the attempt is named to a person: its Herdr workspace's label. */
    label?: string;
    /** `--from-stage`: the stage this attempt starts at, reusing those before it. */
    fromStage?: string;
    /** `--values`: the values of stages before `fromStage` that have no record to reuse. */
    values?: ReadonlyMap<string, JsonValue>;
  };
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
  /** The stages entered, in order, each run or reused; absent when none was. */
  stages?: StageSummary[];
  /** The stage a run that didn't complete ended in; absent between stages. */
  endedIn?: string;
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
  readonly stages?: StageSummary[];
  readonly endedIn?: string;
  readonly usage: SettledOperation[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly accounting: RunAccounting;
  readonly sandboxes?: SandboxRecord[];
  readonly skills?: AgentSkillsRecord[];
  readonly decisions?: SettledDecision[];

  constructor(cause: unknown, run: SettledRun) {
    super(messageOf(cause), { cause });
    this.name = "WorkflowRunError";
    this.runId = run.runId;
    if (run.stages) this.stages = run.stages;
    if (run.endedIn !== undefined) this.endedIn = run.endedIn;
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
  groups: readonly GroupProgress[];
  /** The workflow stages this attempt entered, in order. */
  stages: readonly StageProgress[];
  /** Stages an earlier attempt recorded that this one hasn't entered yet. */
  upcoming: readonly string[];
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
  /** How it was opened, which its forks reuse; absent for the calling session. */
  opening?: {
    sessions: AgentSessions;
    accounted: AccountedAgent;
    /** Its skills as placed for its harness; absent when it has the operator's. */
    skills: Promise<PlacedSkills | undefined>;
  };
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
  /** The agent it was forked from, and the spec it was forked with. */
  forkedFrom?: { parent: AgentKey; spec: AgentForkSpec };
};

const CLEANUP_GRACE_MILLISECONDS = 5_000;
/** A fork asks no model: it copies a session file, in seconds (F7). */
const FORK_TIMEOUT_MS = 60_000;
const scopes = new AsyncLocalStorage<ExecutionScope>();

export async function runWorkflow<Args extends JsonValue, Result extends JsonValue>(
  definition: WorkflowDefinition<Args, Result>,
  args: Args,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult<Result>> {
  return (await startWorkflow(definition, args, options)).result;
}

/**
 * Opens the run and starts the workflow's body. It throws only when the run never started: it was
 * cancelled, or its records, host or sandbox did not open; from the body on, every failure is the
 * handle's `result`'s.
 */
export async function startWorkflow<Args extends JsonValue, Result extends JsonValue>(
  definition: WorkflowDefinition<Args, Result>,
  args: Args,
  options: RunWorkflowOptions,
): Promise<WorkflowRunHandle<Result>> {
  assertDeadline(options.deadline);
  if (options.signal?.aborted) throw new WorkflowCancelledError(options.signal.reason);
  const { dir: runDir, id: runId, attempt } = options.run;
  const startedAt = Date.now();
  const cwd = options.cwd ?? process.cwd();
  // Before anything opens: a record this awf can't read refuses the attempt, and a crash may have
  // torn the last line an earlier attempt appended.
  const recorded = await readStageRecords(runDir);
  await endTurnsLine(runDir);
  const slots = createResultSlotRegistry({ runDir });
  const control = await startResultControlPlane({ slots });
  let host: AgentRunHost;
  const openingHost = Promise.resolve().then(() =>
    options.runtime.host.openRun({
      runId,
      ...(options.run.label === undefined ? {} : { label: options.run.label }),
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
  // Each turn as it settles, so an attempt that dies keeps the sessions and times of its turns.
  const turns: TurnRecord[] = [];
  const turnWrites: Promise<void>[] = [];
  const ledger = createRunLedger({ accounting: options.runtime.host.accounting, startedAt });
  const recordTurn: RecordTurn = (outcome, kind) => {
    const turn: TurnRecord = {
      version: TURN_RECORD_VERSION,
      attempt,
      kind,
      outcome: outcome.kind,
      ...pick(outcome.usage, TURN_OPERATION_FIELDS),
    };
    turns.push(turn);
    turnWrites.push(
      appendTurn(runDir, turn).catch((error) =>
        options.onLog?.(`awf: a turn was not recorded in turns.jsonl: ${messageOf(error)}`),
      ),
    );
  };
  const stages = new StageLedger({
    runDir,
    attempt,
    records: recorded,
    ...(options.run.fromStage === undefined ? {} : { fromStage: options.run.fromStage }),
    ...(options.run.values === undefined ? {} : { values: options.run.values }),
    ...(definition.meta.version === undefined ? {} : { workflowVersion: definition.meta.version }),
    turns: () => turns,
  });
  const progress = new RunProgress();
  // Shared by sandboxed agents' homes and a host agent's own: they may copy one credential.
  const locks: CredentialLocks = new Map();
  const environment = options.sandboxes?.environment ?? process.env;
  const sandboxes = new RunSandboxes({
    ...(options.sandboxes ? { sandboxes: options.sandboxes } : {}),
    locks,
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
    recordTurn,
    stages,
    runId,
    attempt,
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
      const caught = stages.caught();
      if (caught) throw caught;
      if (stages.fromStageUnreached !== undefined) {
        throw new FromStageUnreached(stages.fromStageUnreached, stages.recorded);
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    // Past stand-ins, what the body went on to do, a return or a throw, isn't its own: the attempt
    // stops for the values it needs, unless it was cancelled or ran out of time.
    const needed = stages.needed();
    if (needed && !signal.aborted && !(failure instanceof DeadlineExceededError)) {
      failed = true;
      failure = needed;
    }
    bodyEnded = true;
    // What the body left running enters no stage; one left open is failed once its turns settle.
    stages.seal(failed ? messageOf(failure) : "the workflow returned before the stage ended");
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
    await stages
      .close()
      .catch((error) =>
        options.onLog?.(`awf: a stage record was not written: ${messageOf(error)}`),
      );
    await Promise.all(turnWrites);
    const usage = await ledger.settle(reading.signal);
    signal.removeEventListener("abort", cutReading);
    const times = { startedAt: new Date(startedAt).toISOString(), finishedAt };
    const opened = sandboxes.records();
    const given = skills.records();
    const asked = decisions.records();
    const endedIn = failed ? stages.endedIn(failure) : undefined;
    const settled: SettledRun = {
      runId,
      ...(endedIn === undefined ? {} : { endedIn }),
      ...(stages.summaries.length > 0 ? { stages: stages.summaries } : {}),
      usage,
      ...times,
      accounting: summarizeRun(usage, PUBLISHED_PRICES, times, asked, stages.summaries),
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
        groups: known.groups,
        ...stages.progress(),
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

/**
 * An agent's sessions, as its launcher reports them and as its harness session knows them, and its
 * forks', whose copied context may reach its launcher with a fork's own session (ADR 0009).
 */
type AgentSessions = {
  launcher: Set<string>;
  harness?: HarnessSession;
  forks: AgentSessions[];
  /** A fork's parent's, whose session the fork's copied context can name (pi keeps its id). */
  parent?: AgentSessions;
};

/**
 * What the agent reported or its harness saw, less any session one of its forks runs, and less
 * any its parent has: a fork answering under its parent's id is its parent's session, not its own.
 */
function reportedSessions(sessions: AgentSessions): string[] {
  const own = sessions.harness?.sessions?.() ?? [];
  const others = new Set(forkSessions(sessions));
  for (let parent = sessions.parent; parent; parent = parent.parent) {
    for (const id of [...parent.launcher, ...(parent.harness?.sessions?.() ?? [])]) {
      // What its own harness saw is its own, even reported through its parent's channel.
      if (!own.includes(id)) others.add(id);
    }
  }
  return [...new Set([...sessions.launcher, ...own])].filter((id) => !others.has(id));
}

function forkSessions(sessions: AgentSessions): string[] {
  return sessions.forks.flatMap((fork) => [
    ...(fork.harness?.sessions?.() ?? []),
    ...forkSessions(fork),
  ]);
}

type PlacedSkills = { given: AgentSkills; writeBack?: () => Promise<void> };

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
  activation(
    cwd: string,
    occupant?: Occupant,
    skills?: AgentSkills,
    /** Its harness home: a sandbox's, or its own on the host. */
    home?: string,
  ): HarnessActivation;
  /**
   * A fork whose parent has a harness home of its own: the parent's session, copied into `copy` by
   * `forked`, is placed in this agent's home before it is admitted, in the parent's sandbox.
   */
  carried?: { parent: AgentKey; forked: Promise<unknown>; copy: string };
};

class WorkflowOwner {
  readonly context: WorkflowContext;
  readonly #agents = new Map<string, AgentEntry>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<unknown[]> | undefined;
  /** The bundled `wf`'s source, built once, at the first sandboxed agent. */
  #bundle: Promise<string> | undefined;
  /** The calling session, once the workflow has asked for it (ADR 0010). */
  #caller: { key: string; state: Promise<LogicalAgent> } | undefined;

  constructor(
    private readonly options: {
      sandboxes: RunSandboxes;
      skills: RunSkills;
      runDir: string;
      locks: CredentialLocks;
      environment: Readonly<Record<string, string | undefined>>;
      decisions: RunDecisions;
      stages: StageLedger;
      runId: string;
      attempt: number;
      cwd: string;
      deadline: AbsoluteDeadline;
      runtime: AgentRuntimeConfig;
      host: AgentRunHost;
      slots: ResultSlotRegistry;
      control: ResultControlPlane;
      ledger: RunLedger;
      progress: RunProgress;
      recordTurn: RecordTurn;
      onLog?: RunWorkflowOptions["onLog"];
    },
  ) {
    this.context = {
      runId: options.runId,
      attempt: options.attempt,
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
        attach: (key, runtime) => {
          if (this.#caller?.key !== key) return unavailable("agents.attach");
          if (runtime !== undefined) {
            return Promise.reject(
              new Error(`agent ${key} is the calling session, whose runtime is the operator's`),
            );
          }
          return this.#caller.state;
        },
        stop: () => unavailable("agents.stop"),
        caller: (spec) => {
          try {
            return this.caller(spec.key);
          } catch (error) {
            return Promise.reject(error);
          }
        },
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
            this.options.stages.checkOperation();
          } catch (error) {
            return Promise.reject(error);
          }
          const decided = this.track(
            options.decisions.decide(spec, {
              deadline: scope?.deadline ?? options.deadline,
              ...(scope ? { add: (cancel) => scope.add(cancel) } : {}),
              ...(scope?.stage === undefined ? {} : { stage: scope.stage }),
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
          label === undefined ? undefined : options.progress.group(label, items.length),
        );
      },
      stop: (reason: string): never => {
        // The stage it is called in, by scope: not whichever one is open beside it.
        throw this.options.stages.stop(String(reason), scopes.getStore()?.stage);
      },
      stage: ((name: string, ...rest: unknown[]) =>
        this.runStage(name, rest)) as WorkflowContext["stage"],
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

  /**
   * Runs one stage's work in a scope of its own, which cancels what is still open in it when the
   * work fails, then writes the stage's record.
   */
  private async runStage(name: string, rest: unknown[]): Promise<JsonValue | undefined> {
    const [options, work] = (rest.length === 1 ? [undefined, rest[0]] : rest) as [
      StageOptions<JsonValue> | undefined,
      unknown,
    ];
    if (this.#closed) throw new Error("workflow context is closed");
    if (typeof work !== "function") throw new Error(`stage ${name} needs its work as a function`);
    // Before anything is spent on it.
    let result: JsonSchema | undefined;
    if (options) {
      try {
        result = parseJsonSchema(options.result);
      } catch (error) {
        throw new Error(`stage ${name}'s result: ${messageOf(error)}`);
      }
    }
    const parent = scopes.getStore();
    parent?.assertAccepting();
    const entered = await this.options.stages.enter(name, {
      ...(result === undefined ? {} : { result }),
      summary: (value) => summaryOf(name, options, value, this.options.onLog),
    });
    if (entered.kind === "reuse") {
      entered.release();
      return entered.value;
    }
    const open = entered.stage;
    const scope = new ExecutionScope(
      parent?.deadline ?? this.options.deadline,
      parent?.group,
      name,
    );
    const removeFromParent = parent?.add(() => scope.cancel());
    try {
      const returned: unknown = await scopes.run(scope, () => work());
      scope.seal();
      await scope.settleOwned();
      if (this.options.stages.stopped?.stage === name) throw this.options.stages.caught();
      const value = stageValue(name, options, returned);
      await open.succeed(value, summaryOf(name, options, value, this.options.onLog));
      return value;
    } catch (error) {
      // Its turns settle once cancelled, so its record names the sessions they ran on.
      await scope.cancel();
      await waitForDeadline(scope.settleOwned(), {
        unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS,
      }).catch(() => undefined);
      const stopped = this.options.stages.stopped;
      if (stopped && error === stopped && stopped.stage === name) await open.stop(stopped.reason);
      else {
        this.options.stages.failedIn(name, error);
        await open.fail(messageOf(error));
      }
      throw error;
    } finally {
      removeFromParent?.();
    }
  }

  private openAgent(spec: AgentOpenSpec): Promise<AgentRef> {
    if (this.#closed) throw new Error("workflow context is closed");
    scopes.getStore()?.assertAccepting();
    if (this.#caller?.key === spec.key) {
      throw new Error(`agent ${spec.key} is the calling session; it is not opened`);
    }
    const inRunSandbox = this.options.sandboxes.hasRunSandbox;
    if (inRunSandbox && spec.sandbox !== undefined)
      throw new Error(`agent ${spec.key}: ${RUN_SANDBOX_ONLY}`);
    const existing = this.#agents.get(spec.key);
    const execution = existing
      ? constrainExistingExecution(spec.runtime, existing.identity.execution)
      : withKnownEffort(resolveExecution(spec.runtime, this.options.runtime));
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

    this.options.progress.agentOpened(spec.key, scope?.group);
    // Opened before the session so registration below stays synchronous: two concurrent `agent()`
    // calls for one key must not each build an agent.
    const sessions: AgentSessions = { launcher: new Set(), forks: [] };
    const accounted: AccountedAgent = {
      key: spec.key,
      execution,
      cwd: identity.cwd,
      sessions: () => reportedSessions(sessions),
    };
    const opening: AgentOpening = {
      spec,
      execution,
      deadline: effectiveDeadline,
      sessions,
      ledger: this.options.ledger.agent(accounted),
      ...(identity.skills ? { skills: identity.skills } : {}),
      activation: (cwd, occupant, skills, home) => ({
        key: spec.key,
        deadline: effectiveDeadline,
        cwd,
        execution,
        ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
        ...(spec.labels === undefined ? {} : { labels: spec.labels }),
        ...(occupant ? { occupant } : {}),
        ...(skills ? { skills } : {}),
        ...(home ? { home } : {}),
      }),
    };
    let skills: Promise<PlacedSkills | undefined> = Promise.resolve(undefined);
    let opened: { state: Promise<LogicalAgent>; channel: Promise<ResultChannel> };
    if (spec.sandbox === undefined && !inRunSandbox) {
      skills = this.placeHostSkills(spec.key, execution, identity.cwd, identity.skills);
      skills.catch(() => undefined);
      opened = this.openHostAgent(opening, identity.cwd, accounted, skills);
    } else {
      opened = this.openSandboxedAgent(opening, identity.cwd, accounted);
    }
    const { state, channel } = opened;
    const ownedState = this.track(state);
    this.#agents.set(spec.key, {
      identity,
      opening: { sessions, accounted, skills },
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
   * The session the run was started from, under the key the workflow names: `null` when there is
   * none. It is found, not opened: its harness, directory and skills are the operator's, and it
   * answers through a launcher by path as any pane agent does (ADR 0010).
   */
  private caller(key: string): Promise<AgentRef | null> {
    if (this.#closed) throw new Error("workflow context is closed");
    const scope = scopes.getStore();
    scope?.assertAccepting();
    const found = this.options.runtime.host.caller;
    if (!found) return Promise.resolve(null);
    if (this.#caller) {
      if (this.#caller.key !== key) {
        throw new Error(
          `the calling session is already agent ${this.#caller.key}; it cannot also be ${key}`,
        );
      }
      return this.#caller.state;
    }
    if (this.#agents.has(key))
      throw new Error(`agent ${key} is already open; the caller needs a key of its own`);
    const execution: AgentExecution = { harness: found.harness, model: "", caller: true };
    this.options.progress.agentOpened(key, scope?.group);
    const sessions: AgentSessions = { launcher: new Set(), forks: [] };
    const accounted: AccountedAgent = {
      key,
      execution,
      cwd: found.cwd,
      sessions: () => reportedSessions(sessions),
      promptedAt: () => sessions.harness?.promptedAt?.(),
    };
    const ledger = this.options.ledger.agent(accounted);
    this.options.skills.record(key, "operator");
    const opened = this.options.control.openChannel(key, (id) => sessions.launcher.add(id));
    const state = opened.then(async (channel) => {
      try {
        const launcher = await installAgentLauncher(
          dirname(channel.endpoint),
          channel.endpoint,
          findHarness(execution.harness)?.sessionEnv,
        );
        const session = await this.options.host.openAgent({
          key,
          deadline: this.options.deadline,
          cwd: found.cwd,
          execution,
        });
        sessions.harness = session;
        return this.logicalAgent(key, execution, session, channel.endpoint, launcher, ledger);
      } catch (error) {
        await channel.close().catch(() => undefined);
        throw error;
      }
    });
    const owned = this.track(state);
    this.#caller = { key, state: owned };
    this.#agents.set(key, {
      identity: { execution, cwd: found.cwd },
      state: owned,
      channel: opened.then(
        (channel) => channel,
        () => undefined,
      ),
    });
    const ready = this.track(waitForDeadline(owned, scope?.deadline ?? this.options.deadline));
    scope?.track(ready);
    return ready;
  }

  /**
   * An agent on the host: its skills placed first, since a source that will not resolve refuses the
   * agent before it holds anything, then its channel and session together.
   */
  private openHostAgent(
    { spec, execution, sessions, ledger, activation }: AgentOpening,
    cwd: string,
    accounted: AccountedAgent,
    placed: Promise<PlacedSkills | undefined>,
  ): { state: Promise<LogicalAgent>; channel: Promise<ResultChannel> } {
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
      .then((skills) =>
        this.options.host.openAgent(
          activation(cwd, undefined, skills?.given, skills?.given.ownHome),
        ),
      )
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
    /** A forked session's files, placed in the home it is given with its skills. */
    carry?: string,
  ): Promise<PlacedSkills | undefined> {
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
      async (staged) => {
        await placeSkills(resolved, join(staged, relative(ownHome, given.directory)));
        if (carry) await placeCarried(carry, staged);
      },
    );
    return { given, writeBack: () => seeded.writeBack() };
  }

  /**
   * A sandboxed agent opens in order, each step before the next: its sandbox (a private one opened
   * now), its channel, its door, its home, its admission, then its session. Everything refused
   * about where it runs is refused before a channel opens.
   */
  private openSandboxedAgent(
    {
      spec,
      execution,
      deadline,
      sessions,
      ledger,
      activation,
      skills: sources,
      carried,
    }: AgentOpening,
    cwd: string,
    accounted: AccountedAgent,
  ): { state: Promise<LogicalAgent>; channel: Promise<ResultChannel> } {
    const scope = scopes.getStore();
    const opened = (async () => {
      // A fork is seated once its parent's session is copied, in its parent's sandbox.
      await carried?.forked;
      const skills = sources ? await this.options.skills.resolve(sources) : undefined;
      const seat = await this.options.sandboxes.seat({
        key: spec.key,
        sandbox: spec.sandbox,
        cwd,
        execution,
        ...(skills ? { skills } : {}),
        ...(carried ? { joins: carried.parent } : {}),
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
        const seated = await seat.admit(door, carried?.copy);
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
          activation(seat.cwd, seated.occupant, seat.skills, seat.home),
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
      recordTurn: this.options.recordTurn,
      track: (promise) => this.track(promise),
      isRunClosing: () => this.#closed,
      checkOperation: () => this.options.stages.checkOperation(),
      fork: (spec, take, settings) => this.forkAgent(key, spec, take, settings),
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

  /**
   * A new agent on a copy of `parentKey`'s session (ADR 0009). Its key is taken now, so two forks or
   * a fork and an open of one key never build two agents; `take` queues the native fork in the
   * parent's operations, and the child opens after it, so its opening never holds them.
   */
  private forkAgent(
    parentKey: string,
    spec: AgentForkSpec,
    /** Queues the native fork, or its copy `into` another home; or why its host cannot fork. */
    take: ((into?: SessionCopy) => Promise<NativeFork>) | string,
    /** The parent's settings once every `set` queued before the fork has run. */
    parentSettings: AgentExecution,
  ): Promise<AgentRef> {
    if (this.#closed) throw new Error("workflow context is closed");
    const scope = scopes.getStore();
    scope?.assertAccepting();
    if (this.#caller?.key === spec.key) {
      throw new Error(`agent ${spec.key} is the calling session; it is not opened`);
    }
    const forkSpec = structuredClone(spec);
    const deadline = scope?.deadline ?? this.options.deadline;
    assertDeadline(deadline);
    const existing = this.#agents.get(spec.key);
    if (existing) {
      const from = existing.identity.forkedFrom;
      if (from?.parent !== parentKey || !isDeepStrictEqual(from.spec, forkSpec)) {
        throw new Error(`agent ${spec.key} is already open, not as this fork of ${parentKey}`);
      }
      const attached = this.track(waitForDeadline(existing.state, deadline));
      scope?.track(attached);
      return attached;
    }
    const parent = this.#agents.get(parentKey)!;
    const { opening } = parent;
    if (!opening)
      throw new Error(`agent ${parentKey} is the calling session, which a run does not fork`);
    if (typeof take === "string") throw new Error(take);
    const sandboxed = parent.identity.sandbox !== undefined || this.options.sandboxes.hasRunSandbox;
    // A parent with a harness home of its own has its session copied out, and the fork made in the
    // child's home: anything added to the parent's would be read as the parent's.
    const copy =
      sandboxed || opening.accounted.home !== undefined
        ? join(this.options.runDir, "forks", randomUUID())
        : undefined;
    const execution = withKnownEffort(forkExecution(parentSettings, forkSpec));
    const identity: AgentIdentity = {
      execution,
      cwd: parent.identity.cwd,
      ...(forkSpec.instructions === undefined ? {} : { instructions: forkSpec.instructions }),
      ...(forkSpec.labels === undefined ? {} : { labels: forkSpec.labels }),
      ...(parent.identity.skills ? { skills: parent.identity.skills } : {}),
      ...(parent.identity.sandbox === undefined ? {} : { sandbox: parent.identity.sandbox }),
      forkedFrom: { parent: parentKey, spec: forkSpec },
    };

    this.options.progress.agentOpened(spec.key, scope?.group);
    const sessions: AgentSessions = { launcher: new Set(), forks: [], parent: opening.sessions };
    opening.sessions.forks.push(sessions);
    const accounted: AccountedAgent = {
      key: spec.key,
      execution,
      cwd: identity.cwd,
      sessions: () => reportedSessions(sessions),
    };
    let continues: NativeFork | undefined;
    // The fork is asked for now, in the parent's queue; the child opens once it is made. One that
    // was not made leaves nothing behind: its key may be forked again, after the parent's turn.
    const forked = take(copy === undefined ? undefined : { directory: copy })
      .then((fork) => {
        continues = fork;
        this.options.progress.agentForked(spec.key, parentKey);
        return fork;
      })
      .catch((error: unknown) => {
        if (this.#agents.get(spec.key)?.opening?.sessions === sessions) {
          this.#agents.delete(spec.key);
          this.options.progress.agentDropped(spec.key);
        }
        opening.sessions.forks.splice(opening.sessions.forks.indexOf(sessions), 1);
        throw error;
      });
    const sources = parent.identity.skills;
    const forkOpening: AgentOpening = {
      spec: {
        key: spec.key,
        runtime: execution,
        ...(parent.identity.sandbox === undefined
          ? {}
          : { sandbox: parent.identity.sandbox as AgentOpenSpec["sandbox"] }),
      },
      execution,
      deadline,
      sessions,
      ledger: this.options.ledger.agent(accounted),
      ...(sources ? { skills: sources } : {}),
      ...(sandboxed && copy ? { carried: { parent: parentKey, forked, copy } } : {}),
      activation: (cwd, occupant, given, home) => ({
        key: spec.key,
        deadline,
        cwd,
        execution,
        ...(forkSpec.instructions === undefined ? {} : { instructions: forkSpec.instructions }),
        ...(forkSpec.labels === undefined ? {} : { labels: forkSpec.labels }),
        ...(occupant ? { occupant } : {}),
        ...(given ? { skills: given } : {}),
        ...(home ? { home } : {}),
        ...(continues ? { continues } : {}),
      }),
    };
    let skills: Promise<PlacedSkills | undefined> = Promise.resolve(undefined);
    let opened: { state: Promise<LogicalAgent>; channel: Promise<ResultChannel> };
    if (sandboxed) {
      forked.catch(() => undefined);
      opened = this.openSandboxedAgent(forkOpening, identity.cwd, accounted);
    } else {
      // On the host, its parent's copy of its skills, the same files at the same paths: its
      // context is its parent's, skills included, and so is its cache. A home of its own, codex's
      // for skills, holds the same skills and the parent's session copied in.
      skills = forked.then(async () => {
        if (copy) return this.placeHostSkills(spec.key, execution, identity.cwd, sources, copy);
        if (!sources) {
          this.options.skills.record(spec.key, "operator");
          return undefined;
        }
        this.options.skills.record(spec.key, await this.options.skills.resolve(sources));
        const placed = await opening.skills;
        return placed ? { given: placed.given } : undefined;
      });
      skills.catch(() => undefined);
      opened = this.openHostAgent(forkOpening, identity.cwd, accounted, skills);
    }
    const { state, channel } = opened;
    // Once the child's home holds it, or it never will, the copy has served.
    if (copy) {
      void state
        .catch(() => undefined)
        .finally(() => rm(copy, { recursive: true, force: true }).catch(() => undefined));
    }
    const ownedState = this.track(state);
    this.#agents.set(spec.key, {
      identity,
      opening: { sessions, accounted, skills },
      state: ownedState,
      channel: channel.then(
        (opened) => opened,
        () => undefined,
      ),
    });
    const activated = this.track(waitForDeadline(ownedState, deadline));
    scope?.track(activated);
    return activated;
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
  readonly #sets = new Map<string, { spec: SettingsSpec; result: Promise<TurnOutcome<null>> }>();
  /** Its settings now; see `AgentRef.execution`. */
  #execution: AgentExecution;
  /** What each `set` queued and not yet settled changes, in queue order. */
  readonly #pendingSets: SettingsChange[] = [];
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
      recordTurn: RecordTurn;
      track<T>(promise: Promise<T>): Promise<T>;
      isRunClosing(): boolean;
      /** Throws when no turn may start: the attempt is looking on for values it needs. */
      checkOperation(): void;
      /** After each operation settles, whatever its outcome. */
      afterOperation?(): Promise<void>;
      /**
       * Opens `spec`'s agent on the native fork `take` queues in this agent's operations, at
       * `settings`, this agent's once the operations before the fork have run.
       */
      fork(
        spec: AgentForkSpec,
        take: ((into?: SessionCopy) => Promise<NativeFork>) | string,
        settings: AgentExecution,
      ): Promise<AgentRef>;
    },
  ) {
    this.#execution = options.execution;
  }

  get key(): string {
    return this.options.key;
  }

  get execution(): AgentExecution {
    return this.#execution;
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
      this.options.checkOperation();
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
      deadline = this.operationDeadline(spec, scope);
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
      const tags = tagsOf(scope, completeSpec.label);
      this.options.progress.turnStarted(this.key, tags);
      try {
        const settled = await this.executeOperation(completeSpec, scope, deadline, tags);
        this.turnEnded(settled.outcome, "turn");
        return settled;
      } catch (error) {
        this.options.progress.turnSettled(this.key, "failed", messageOf(error));
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
      this.options.checkOperation();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = spec.id ?? randomUUID();
    const completeSpec = structuredClone({ ...spec, id });
    const existing = this.#compactions.get(id);
    if (existing) {
      if (!isDeepStrictEqual(existing.spec, completeSpec)) {
        const rejected = Promise.reject<TurnOutcome<string>>(
          new Error(`compaction id ${id} was reused with a different specification`),
        );
        scope?.track(rejected);
        return rejected;
      }
      scope?.track(existing.result);
      return existing.result;
    }
    let deadline: AbsoluteDeadline;
    try {
      deadline = this.operationDeadline(spec, scope);
    } catch (error) {
      const rejected = Promise.reject<TurnOutcome<string>>(error);
      scope?.track(rejected);
      return rejected;
    }
    const result = this.queue(async () => {
      if (this.#closed || this.options.isRunClosing()) {
        throw new Error("logical agent is closed");
      }
      scope?.assertActive();
      const tags = tagsOf(scope);
      this.options.progress.turnStarted(this.key, tags, "compact");
      try {
        const outcome = await this.executeCompaction(id, spec.prompt, deadline, scope, tags);
        this.turnEnded(outcome, "compact");
        return outcome;
      } catch (error) {
        this.options.progress.turnSettled(this.key, "failed", messageOf(error));
        throw error;
      } finally {
        await this.options.afterOperation?.();
      }
    });
    const tracked = this.options.track(result);
    scope?.track(tracked);
    this.#compactions.set(id, { spec: completeSpec, result: tracked });
    return tracked;
  }

  /** Not a turn: progress counts none for it, and it asks the model nothing. */
  set(spec: SettingsSpec): Promise<TurnOutcome<null>> {
    if (this.#closed) return Promise.reject(new Error("logical agent is closed"));
    const scope = scopes.getStore();
    try {
      scope?.assertAccepting();
    } catch (error) {
      return Promise.reject(error);
    }
    const id = spec.id ?? randomUUID();
    const completeSpec = structuredClone({ ...spec, id });
    const existing = this.#sets.get(id);
    if (existing) {
      if (!isDeepStrictEqual(existing.spec, completeSpec)) {
        const rejected = Promise.reject<TurnOutcome<null>>(
          new Error(`settings id ${id} was reused with a different specification`),
        );
        scope?.track(rejected);
        return rejected;
      }
      scope?.track(existing.result);
      return existing.result;
    }
    let change: SettingsChange;
    let deadline: AbsoluteDeadline;
    try {
      change = this.settingsChange(spec);
      deadline = this.operationDeadline(spec, scope);
    } catch (error) {
      const rejected = Promise.reject<TurnOutcome<null>>(error);
      scope?.track(rejected);
      return rejected;
    }
    this.#pendingSets.push(change);
    const result = this.queue(async () => {
      try {
        if (this.#closed || this.options.isRunClosing()) {
          throw new Error("logical agent is closed");
        }
        scope?.assertActive();
        return await this.executeSet(change, deadline, scope);
      } finally {
        this.#pendingSets.splice(this.#pendingSets.indexOf(change), 1);
      }
    });
    const tracked = this.options.track(result);
    scope?.track(tracked);
    this.#sets.set(id, { spec: completeSpec, result: tracked });
    return tracked;
  }

  /** A turn or compaction that settled, as the view shows it and `turns.jsonl` keeps it. */
  private turnEnded(outcome: TurnOutcome<JsonValue>, kind: TurnRecord["kind"]): void {
    const reason = "reason" in outcome ? outcome.reason : undefined;
    this.options.progress.turnSettled(this.key, outcome.kind, reason);
    this.options.recordTurn(outcome, kind);
  }

  fork(spec: AgentForkSpec): Promise<AgentRef> {
    if (this.#closed) return Promise.reject(new Error("logical agent is closed"));
    const scope = scopes.getStore();
    const deadline = this.deadlineCeiling(scope);
    const { session, execution } = this.options;
    const settings = this.queuedExecution();
    const fork = session.fork?.bind(session);
    if (!fork) {
      try {
        return this.options.fork(
          spec,
          `agent ${this.key} cannot be forked: ${execution.harness} ${placementOf(execution)} agents have no fork yet`,
          settings,
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    // The harness bounds its fork by this deadline and stops it there, so the session is idle again
    // when the fork rejects.
    const take = (into?: SessionCopy) =>
      this.queue(async () => {
        if (this.#closed || this.options.isRunClosing()) {
          throw new Error("logical agent is closed");
        }
        scope?.assertActive();
        // The fork was opened at the settings it would copy; a `set` before it that did not take
        // would leave it recording settings it never ran at.
        if (!isDeepStrictEqual(sessionSettings(this.#execution), sessionSettings(settings))) {
          throw new Error(
            `agent ${this.key} was not at the settings its fork was opened at: a set queued before the fork did not take`,
          );
        }
        return fork(deadlineWithin(FORK_TIMEOUT_MS, deadline), into);
      });
    try {
      return this.options.fork(spec, take, settings);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** `deadline` or `timeoutMs`, never later than the scope's or the run's; else the earlier of those. */
  private operationDeadline(
    spec: { deadline?: AbsoluteDeadline; timeoutMs?: number },
    scope: ExecutionScope | undefined,
  ): AbsoluteDeadline {
    if (spec.deadline && spec.timeoutMs !== undefined) {
      throw new Error("an operation cannot specify both deadline and timeoutMs");
    }
    const ceiling = this.deadlineCeiling(scope);
    if (spec.timeoutMs !== undefined) return deadlineWithin(spec.timeoutMs, ceiling);
    if (!spec.deadline) return ceiling;
    assertDeadlineValue(spec.deadline);
    return earlierDeadline(spec.deadline, ceiling);
  }

  private deadlineCeiling(scope: ExecutionScope | undefined): AbsoluteDeadline {
    return scope ? earlierDeadline(scope.deadline, this.options.deadline) : this.options.deadline;
  }

  /** Its settings once every `set` queued so far has run. */
  private queuedExecution(): AgentExecution {
    return Object.assign({}, this.#execution, ...this.#pendingSets);
  }

  /** What `spec` changes, or why it is refused before it is queued. */
  private settingsChange(spec: SettingsSpec): SettingsChange {
    const { execution, session } = this.options;
    if (execution.caller) {
      throw new Error(
        `agent ${this.key} is the calling session, whose model and effort are the operator's`,
      );
    }
    // A workflow is untyped JavaScript at run time: a harness or placement asked for must not be
    // dropped in silence.
    const others = Object.keys(spec).filter((field) => !SETTINGS_FIELDS.has(field));
    if (others.length > 0) {
      throw new Error(
        `set changes an agent's model and effort, not its ${others.join(", ")}: another harness or placement is another agent`,
      );
    }
    if (spec.model === undefined && spec.effort === undefined) {
      throw new Error("set names neither a model nor an effort");
    }
    if (spec.model !== undefined && (typeof spec.model !== "string" || spec.model === "")) {
      throw new Error(`set names no model: ${JSON.stringify(spec.model)}`);
    }
    if (spec.effort !== undefined && typeof spec.effort !== "string") {
      throw new Error(`an effort is a level's name, not ${JSON.stringify(spec.effort)}`);
    }
    const refused =
      (spec.effort === undefined ? undefined : effortRefusal(execution.harness, spec.effort)) ??
      (session.set
        ? undefined
        : (settingsRefusal(execution) ??
          `${execution.harness} ${placementOf(execution)} agents cannot switch model or effort yet`));
    if (refused) throw new Error(`agent ${this.key}: ${refused}`);
    return {
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    };
  }

  /**
   * Switches the session's settings. Nothing answers through a result slot: the host confirms the
   * switch by resolving. A pane's that did not is in settings nobody knows, so it is closed.
   */
  private async executeSet(
    change: SettingsChange,
    deadline: AbsoluteDeadline,
    scope: ExecutionScope | undefined,
  ): Promise<TurnOutcome<null>> {
    const entry = this.options.ledger.reserve(randomUUID(), () => this.#execution, tagsOf(scope));
    const usage = () =>
      entry.settle({ settledAt: Math.min(Date.now(), deadline.unixMilliseconds) }, []);
    if (Date.now() >= deadline.unixMilliseconds) {
      return { kind: "timed-out", reason: "settings deadline exceeded", usage: usage() };
    }
    const next: AgentExecution = { ...this.#execution, ...change };
    const pane = placementOf(next) === "pane";
    let cancelled: string | undefined;
    // A pane's switch waits on its screen; a scope cancelled meanwhile closes the agent, as a
    // half-made switch leaves it at settings nobody knows. A headless one takes no time.
    const removeCanceller = pane
      ? scope?.add(async (reason) => {
          cancelled = reason;
          await this.close(reason);
        })
      : undefined;
    try {
      await waitForDeadline(
        Promise.resolve().then(() => this.options.session.set!(sessionSettings(next), deadline)),
        deadline,
      );
    } catch (error) {
      const expired = error instanceof DeadlineExceededError;
      const reason = cancelled ?? (expired ? "settings deadline exceeded" : messageOf(error));
      if (pane) this.closeAfterFailure(reason);
      if (cancelled !== undefined) return { kind: "cancelled", reason, usage: usage() };
      return expired
        ? { kind: "timed-out", reason, usage: usage() }
        : { kind: "failed", reason, retryable: false, usage: usage() };
    } finally {
      removeCanceller?.();
    }
    this.#execution = next;
    return { kind: "answered", value: null, usage: usage() };
  }

  /**
   * An operation that failed, was cancelled or timed out ends a session the run owns. The calling
   * session is the operator's and goes on: its next turn waits for it to settle (ADR 0010).
   */
  private closeAfterFailure(reason: string): void {
    if (this.options.execution.caller) return;
    void this.close(reason).catch(() => undefined);
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

  /**
   * The standard recovery, except for a calling session whose harness's interrupt cannot be told
   * from a turn that ended without answering: nudging it could be prompting an operator who just
   * stopped it (ADR 0010).
   */
  private defaultNudge(): Exclude<AgentRunTextSpec["nudge"], false> {
    const { execution } = this.options;
    return execution.caller && !findHarness(execution.harness)?.interrupted ? undefined : {};
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
    operationDeadline: AbsoluteDeadline,
    tags: OperationTags,
  ): Promise<RunResult<JsonValue>> {
    const nudge = spec.nudge === false ? undefined : (spec.nudge ?? this.defaultNudge());
    scope?.assertActive();
    if (nudge?.deadline) assertDeadlineValue(nudge.deadline);
    const ceiling = this.deadlineCeiling(scope);
    const nudgeDeadline = nudge ? earlierDeadline(nudge.deadline ?? ceiling, ceiling) : undefined;
    const operationId = randomUUID();
    const schema = resultSchema(spec.schema);
    if (Date.now() >= operationDeadline.unixMilliseconds) {
      const late = this.options.ledger.reserve(operationId, () => this.#execution, tags);
      const usage = late.settle({ settledAt: operationDeadline.unixMilliseconds }, []);
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
    const entry = this.options.ledger.reserve(operationId, () => this.#execution, tags);
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
        ...(tags.stage === undefined ? {} : { stage: tags.stage }),
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
        this.closeAfterFailure(native.detail ?? "harness operation failed");
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
        this.closeAfterFailure(reason);
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
    id: CompactionId,
    prompt: string,
    deadline: AbsoluteDeadline,
    scope: ExecutionScope | undefined,
    tags: OperationTags,
  ): Promise<TurnOutcome<string>> {
    const entry = this.options.ledger.reserve(randomUUID(), () => this.#execution, tags);
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
      this.options.session.compact(id, prompt, deadline),
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
    this.closeAfterFailure(reason);
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
    /** The labelled `parallel` it runs in, for progress. */
    readonly group?: GroupProgress,
    /** The workflow stage everything in this scope runs in. */
    readonly stage?: string,
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
  openGroup?: () => GroupProgress | undefined,
): Promise<Result[]> {
  assertDeadline(deadline);
  const concurrency = requestedConcurrency ?? Math.max(1, items.length);
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("parallel concurrency must be a positive safe integer");
  }
  const parent = scopes.getStore();
  parent?.assertAccepting();
  if (items.length === 0) return Promise.resolve([]);
  const execution = executeParallel(items, operation, deadline, concurrency, parent, openGroup?.());
  parent?.track(execution);
  return execution;
}

async function executeParallel<Item, Result>(
  items: readonly Item[],
  operation: (item: Item, index: number) => Promise<Result>,
  deadline: AbsoluteDeadline,
  concurrency: number,
  parent: ExecutionScope | undefined,
  group?: GroupProgress,
): Promise<Result[]> {
  // An unlabelled parallel inside a labelled one stays part of it.
  const scope = new ExecutionScope(deadline, group ?? parent?.group, parent?.stage);
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
        if (group) group.started += 1;
        try {
          results[index] = await operation(items[index]!, index);
        } finally {
          if (group) group.done += 1;
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
    if (group) group.endedAt = Date.now();
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

/** A stage's one line, which a summary that throws leaves out rather than failing the stage. */
function summaryOf(
  name: string,
  options: StageOptions<JsonValue> | undefined,
  value: JsonValue | undefined,
  log: RunWorkflowOptions["onLog"],
): string | undefined {
  if (!options?.summary || value === undefined) return undefined;
  try {
    return String(options.summary(value));
  } catch (error) {
    log?.(`awf: stage ${name}'s summary failed: ${messageOf(error)}`);
    return undefined;
  }
}

/** A settled turn or compaction, kept in the run's `turns.jsonl`. */
type RecordTurn = (outcome: TurnOutcome<JsonValue>, kind: TurnRecord["kind"]) => void;

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  ) as Pick<T, K>;
}

function tagsOf(scope: ExecutionScope | undefined, label?: string): OperationTags {
  return {
    ...(scope?.stage === undefined ? {} : { stage: scope.stage }),
    ...(label === undefined ? {} : { label }),
  };
}

/**
 * A stage's value as it is recorded and handed back: through JSON, as a continue reads it, and
 * checked by its `result`. A stage without one returns nothing.
 */
function stageValue(
  name: string,
  options: StageOptions<JsonValue> | undefined,
  value: unknown,
): JsonValue | undefined {
  if (!options) {
    if (value === undefined) return undefined;
    throw new Error(
      `stage ${name} has no result schema, so it returns nothing, and it returned a value`,
    );
  }
  let text: string | undefined;
  try {
    text = value === undefined ? undefined : JSON.stringify(value);
  } catch (error) {
    throw new Error(`stage ${name}'s value is not JSON: ${messageOf(error)}`);
  }
  if (text === undefined) {
    throw new Error(`stage ${name} returned nothing; its result expects a value`);
  }
  const recorded = JSON.parse(text) as JsonValue;
  const errors = validate(parseJsonSchema(options.result), recorded);
  if (errors.length > 0) {
    throw new Error(`stage ${name}'s value does not fit its result: ${formatErrors(errors)}`);
  }
  return recorded;
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
    return {
      ...resolved,
      ...(selection.effort === undefined ? {} : { effort: selection.effort }),
      ...storedPlacement(selection),
    };
  }
  const { harness, model, effort } = selection;
  return {
    harness,
    model,
    ...(effort === undefined ? {} : { effort }),
    ...storedPlacement(selection),
  };
}

/** An agent at an effort its harness does not list is refused before anything runs. */
function withKnownEffort(execution: AgentExecution): AgentExecution {
  if (execution.effort === undefined) return execution;
  if (typeof execution.effort !== "string") {
    throw new Error(`an effort is a level's name, not ${JSON.stringify(execution.effort)}`);
  }
  const refused = effortRefusal(execution.harness, execution.effort);
  if (refused) throw new Error(refused);
  return execution;
}

/** What `set` changes. */
type SettingsChange = Partial<Pick<AgentExecution, "model" | "effort">>;

const SETTINGS_FIELDS = new Set(["id", "model", "effort", "deadline", "timeoutMs"]);

function sessionSettings({ model, effort }: AgentExecution): SessionSettings {
  return { model, ...(effort === undefined ? {} : { effort }) };
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

/**
 * The parent's harness, model and effort, in the placement and at the effort the fork names, else
 * its parent's.
 */
function forkExecution(parent: AgentExecution, spec: AgentForkSpec): AgentExecution {
  const { placement: _placement, metered: _metered, ...target } = parent;
  const choice = spec.placement === undefined && spec.metered === undefined ? parent : spec;
  return {
    ...target,
    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
    ...storedPlacement(choice),
  };
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
  // As opened: a `set` since does not change what reopening it compares with.
  if (selection.effort !== undefined && selection.effort !== existing.effort) {
    throw new Error("existing agent was opened at a different effort");
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
  return {
    harness: selected.harness,
    model: selected.model,
    ...(selected.effort === undefined ? {} : { effort: selected.effort }),
    alias,
  };
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
