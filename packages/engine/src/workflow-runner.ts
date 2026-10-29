import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  PARTICIPANT,
  participantRef,
  RESERVED_PARTICIPANT_KEYS,
} from "@agentswf/contract/participant";
import type {
  AgentPaneRecord,
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
  type WaitTake,
} from "@agentswf/contract/records";
import {
  formatErrors,
  type JsonSchema,
  parseJsonSchema,
  validate,
} from "@agentswf/contract/schema";
import {
  type AbsoluteDeadline,
  type AgentEndedEvent,
  type AgentExecution,
  type AgentForkSpec,
  type AgentKey,
  type AgentOpenSpec,
  type AgentRef,
  type AgentRunStructuredSpec,
  type AgentRunTextSpec,
  type AgentStartSpec,
  type Branches,
  type CodeParticipantRef,
  type CompactionId,
  type CompactSpec,
  DeadlineExceededError,
  type EmitOutcome,
  type EventAgentOpenSpec,
  type EventAgentRef,
  type HarnessAllowance,
  isEventWorkflow,
  isJsonValue,
  type JsonObject,
  type JsonValue,
  type KeepPane,
  type Matched,
  type MessageAccess,
  type Next,
  nameProblem,
  type OperationRecord,
  type OutputSchema,
  type PaneLayout,
  type ParticipantRef,
  type ParticipantSpec,
  type PlacementChoice,
  placementOf,
  type RaceBranches,
  type ReceiveOptions,
  type RunResult,
  type RuntimeSelection,
  type SelectOptions,
  type SettingsSpec,
  type SkillSource,
  type StageOptions,
  type StageSummary,
  type StartedTurn,
  type Timer,
  type TurnId,
  type TurnOutcome,
  type WaitOptions,
  type When,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "@agentswf/contract/workflow";
import {
  type AgentSkills,
  effortRefusal,
  findHarness,
  HARNESS_NAMES,
  type Harness,
  hostHome,
  settingsRefusal,
  skillsLayout,
} from "@agentswf/harness";
import type {
  AgentRunHost,
  AgentRuntimeConfig,
  AuthoredMessage,
  AuthoredTurn,
  HarnessActivation,
  HarnessReleaseDisposition,
  HarnessSession,
  HarnessTurn,
  HarnessTurnOutcome,
  NativeFork,
  SessionCopy,
  SessionSettings,
} from "@agentswf/harness/adapter";
import { PUBLISHED_PRICES } from "./accounting/prices";
import { summarizeRun } from "./accounting/summary";
import { buildAgentBundle, installAgentLauncher, installSandboxedDoor } from "./agent-launcher";
import {
  type ResultChannel,
  type ResultControlPlane,
  startResultControlPlane,
} from "./control-plane";
import type { CoordinatorPort } from "./coordinator-port";
import {
  assertDeadline,
  assertDeadlineValue,
  deadlineWithin,
  earlierDeadline,
  harnessDeadline,
  runUntilStopped,
  scheduleAt,
  WorkflowCancelledError,
  waitForDeadline,
} from "./deadlines";
import { RunDecisions } from "./decisions/directory";
import type { DecisionInstallation } from "./decisions/seam";
import { parseWhen } from "./duration";
import { emitEvent } from "./emit";
import { messageOf } from "./errors";
import {
  asTimeoutHandler,
  checkedKeepAlive,
  DEFAULT_WINDOW_MS,
  inTimeoutHandler,
  type KeepAlive,
} from "./keep-alive";
import {
  type RestoredTurn,
  RunMailbox,
  RunParked,
  recoverTurns,
  type TurnEnd,
  unrunUsage,
} from "./mailbox";
import { superviseMessageOperation } from "./message-operation";
import { canAwaitReply } from "./messaging/limits";
import type { HolderRequest } from "./messaging/messaging";
import { type AgentView, type Delivery, Messaging, type OperationEnd } from "./messaging/messaging";
import type { Scope as MessagingScope } from "./messaging/routes";
import { createOperationEvents } from "./operation-events";
import {
  type LivenessEvent,
  type LivenessPolicy,
  type OperationMessages,
  type OperationStop,
  type SupervisedOutcome,
  superviseOperation,
} from "./operation-liveness";
import { besideOf, checkPaneOptions, keepsPane, storedLayout } from "./pane-layout";
import { createResultSlotRegistry, type ResultSlotRegistry } from "./result-slots";
import { RunEventLog } from "./run-event-log";
import {
  type AgentProgress,
  type GroupProgress,
  type MessageProgress,
  RunProgress,
} from "./run-progress";
import {
  type AccountedAgent,
  type AgentLedger,
  createRunLedger,
  type OperationTags,
  type RunLedger,
} from "./run-usage";
import { endTurnsLine, readStageRecords, readTurns } from "./runs";
import { type CredentialLocks, placeCarried, seedHome } from "./sandbox-homes";
import {
  RUN_SANDBOX_ONLY,
  RunSandboxes,
  type RunSandboxOptions,
  type SeatedAgent,
} from "./sandboxes";
import { QUOTING_RULE, simpleInput, usageLine } from "./simple-input";
import { placeSkills, RunSkills, readSkillSources } from "./skills/run-skills";
import { asSource, branchOf, branchValue, source, takeOf } from "./sources";
import { StageLedger, type StageProgress } from "./stage-ledger";
import { FromStageUnreached } from "./stopped";
import { inToolHandler, outsideTools, refusedInTool, ToolCalls, toolsLesson } from "./tools";
import type { EventWorkflow } from "./workflow-loader";

export { WorkflowCancelledError } from "./deadlines";

export type RunWorkflowOptions = {
  /** Internal timing policy; workflow authors use the operation deadline. */
  livenessPolicy?: LivenessPolicy;
  /** A `keepAlive` window that gives no `timeoutMs`; absent, an hour. A test's is short. */
  defaultWindowMs?: number;
  /** The run's time, which its timers and `workflow.now()` read; absent, the clock's. A test's is virtual. */
  now?: () => number;
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
    /** A run of a workflow with `events`. */
    events?: true;
    /** With `events`: runs `work` holding the run's lock, as every append to the mailbox is made. */
    locked?<T>(work: () => Promise<T>): Promise<T>;
    /**
     * With `events`: false when the attempt before this one has no ending, its process gone with its
     * agents perhaps still running: its sessions aren't reopened until they are stopped (Q17).
     */
    resumeSessions?: boolean;
    /** With `events`: calls `nudge` whenever awf tells the run its mailbox has a new event. */
    listenNudges?(nudge: () => void): void;
    /**
     * Writes the attempt's `parked` ending, which the run's wait calls holding the run's lock: an
     * event run's, or a test's. Absent, the run never parks and waits in its process.
     */
    park?(wait: { label?: string; until?: string }): Promise<void>;
    /** With `park`: the wait stays live to `until` for an agent's window instead. A test's hook. */
    live?(until: number): Promise<void>;
    /** With `park`: moves a virtual clock to the timer due at `until` rather than parking. A test's hook. */
    skip?(until: number): Promise<boolean>;
  };
  runtime: AgentRuntimeConfig;
  /** The run's deadline; absent, it has none, and only deadlines the workflow sets bound it. */
  deadline?: AbsoluteDeadline;
  cwd?: string;
  onLog?: (message: string, fields?: JsonObject) => void;
  /** The operator hands the session back once agents.stop has released it. */
  onCallerStopped?: (reason: string) => Promise<void>;
  signal?: AbortSignal;
  /** The sandbox providers agents may run in; without them, a sandboxed agent is refused. */
  sandboxes?: RunSandboxOptions;
  /** Where public skills are fetched to, shared by runs; `$XDG_CACHE_HOME/awf/skills` by default. */
  skillCache?: string;
  /** The decision models workflows may ask; without them, `decisions.decide` is refused. */
  decisions?: DecisionInstallation;
  /** How `workflow.allowance` reads a harness's plan; without it, every harness reads `none`. */
  allowance?: (harness: Harness) => Promise<HarnessAllowance>;
  /**
   * Where an agent may `--await-reply`: the engine's list by harness and placement unless given. A
   * workflow's test allows it everywhere, as the fake harness can.
   */
  awaitReply?: (execution: AgentExecution, confirmsDelivery: boolean) => boolean;
  /**
   * Whatever answers for the run's outside participants, each told everything: `awf run`'s prompt,
   * the socket `awf reply` and `awf send` reach, or a test's scripts. Unsupported outside the engine.
   * @internal
   */
  coordinators?: readonly CoordinatorPort[];
  /**
   * Sends `workflow.emit`'s event through the one way in; absent, `emitEvent` on this machine. A
   * test records them instead.
   */
  emit?: Emitter;
};

/** Sends an event from a run to its target. */
export type Emitter = (
  target: EventWorkflow,
  event: { run: string; name: string; data: JsonValue; id?: string },
  from: string,
) => Promise<EmitOutcome>;

const machineEmitter: Emitter = async (target, event, from) =>
  (await emitEvent(target, event, { from, home: homedir(), environment: process.env })).outcome;

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
  /** Where each pane agent's pane went; absent when the run placed none. */
  panes?: AgentPaneRecord[];
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
  readonly panes?: AgentPaneRecord[];
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
    if (run.panes) this.panes = run.panes;
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
  /** Messages admitted this attempt, in order. */
  messages: readonly MessageProgress[];
  agents: readonly (Partial<AgentProgress> & {
    key: AgentKey;
    /** Messages held for it and not yet shown; absent when none are. */
    queued?: number;
    /** Idle with `keepAlive`, the end of its window: the run stays live to it. */
    liveUntil?: number;
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
  /** Why `agents.stop` ended it; its key is not opened again. */
  stopped?: string;
  stopping?: Promise<boolean>;
  stopComplete?: boolean;
  releasedAt?: number;
  /** As the open last gave it: a reopen that gives one replaces it. */
  keepAlive?: KeepAlive;
  /** How it was opened, or found for the calling session, which its forks reuse. */
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
  /** As written; a reopen compares them so, never where the pane ended up. */
  layout?: PaneLayout;
  keepPane?: KeepPane;
};

const CLEANUP_GRACE_MILLISECONDS = 5_000;
/** How long after a pane's turn ends its receipt may still be read from the session's file. */
const RECEIPT_GRACE_MS = 10_000;
/** What a fork of the session the run was started from names as its parent. */
const CALLING = "the calling session";
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
  // Before anything opens, so a refusal leaves nothing to close.
  const withEvents = isEventWorkflow(definition);
  const locked = options.run.locked ?? (<T>(work: () => Promise<T>) => work());
  if (withEvents && (options.run.fromStage !== undefined || options.run.values))
    throw new Error("a run of a workflow with events takes no --from-stage or --values");
  const { dir: runDir, id: runId, attempt } = options.run;
  const startedAt = Date.now();
  const cwd = options.cwd ?? process.cwd();
  // Before anything opens: a record this awf can't read refuses the attempt, and a crash may have
  // torn the last line an earlier attempt appended.
  const recorded = await readStageRecords(runDir);
  // The log is observation: one that cannot be written says so as it is, and fails nothing.
  await endTurnsLine(runDir).catch(() => undefined);
  const slots = createResultSlotRegistry({
    runDir,
    ...(options.livenessPolicy
      ? {
          waitMinimumMs: options.livenessPolicy.quietMs,
          waitDefaultMs: Math.max(1, options.livenessPolicy.quietMs * 4),
        }
      : {}),
  });
  const control = await startResultControlPlane({ slots });
  let host: AgentRunHost;
  const openingHost = Promise.resolve().then(() =>
    options.runtime.host.openRun({
      runId,
      ...(options.run.label === undefined ? {} : { label: options.run.label }),
      cwd,
      deadline: harnessDeadline(options.deadline),
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
  // A failed write is said on stderr only: as a warning, it would be written to the log again.
  const events = new RunEventLog({
    runDir,
    attempt,
    failed: (message) => options.onLog?.(message),
  });
  const say =
    (kind: "log" | "warning") =>
    (text: string, fields?: JsonObject, stage = scopes.getStore()?.stage): void => {
      options.onLog?.(text, fields);
      events.event({
        kind,
        text,
        ...(fields === undefined ? {} : { fields }),
        ...(stage === undefined ? {} : { stage }),
      });
    };
  const warn = say("warning");
  // Each turn as it settles, so an attempt that dies keeps the sessions and times of its turns.
  const turns: TurnRecord[] = [];
  const ledger = createRunLedger({ accounting: options.runtime.host.accounting, startedAt });
  const recordTurn: RecordTurn = (outcome, kind) => {
    const turn: TurnRecord = {
      version: TURN_RECORD_VERSION,
      attempt,
      kind,
      outcome: outcome.kind,
      callPath: outcome.usage.callPath,
      ...pick(outcome.usage, TURN_OPERATION_FIELDS),
    };
    turns.push(turn);
    events.turn(turn);
  };
  const stages = new StageLedger({
    runDir,
    attempt,
    records: recorded,
    ...(options.run.fromStage === undefined ? {} : { fromStage: options.run.fromStage }),
    ...(options.run.values === undefined ? {} : { values: options.run.values }),
    ...(definition.meta.version === undefined ? {} : { workflowVersion: definition.meta.version }),
    ...(withEvents ? { byContent: true } : {}),
    turns: () => turns,
    event: (body, at) => events.event(body, at),
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
    log: (message) => warn(message),
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
    event: (body) => events.event(body),
  });
  const skills = new RunSkills({
    runDir,
    ...(options.skillCache === undefined ? {} : { cacheRoot: options.skillCache }),
    environment,
  });
  const fatal = Promise.withResolvers<never>();
  void fatal.promise.catch(() => undefined);
  const now = options.now ?? Date.now;
  // A turn an earlier attempt started and never ended, its process gone, ends failed before the code
  // runs again (Q6); the turns whose ends no wait took are their agents' turns again.
  const restoredTurns = withEvents ? await recoverTurns(runDir, attempt, locked, now) : undefined;
  // An event run's agents reopen on the sessions its earlier attempts' turns ran on.
  const keptSessions =
    withEvents && options.run.resumeSessions !== false
      ? keptSessionsOf(await readTurns(runDir))
      : undefined;
  // Every run's timers live in a mailbox; a run of a workflow with events takes its events there too.
  // A plain run without `park` waits for its timers in its process.
  const waits = new RunMailbox({
    runDir,
    attempt,
    locked,
    now,
    ...(options.run.park
      ? {
          parking: {
            idle: (stage) => owner.idle(stage),
            timeout: (signal) => owner.timeout(signal),
            liveUntil: () => owner.liveUntil(),
            park: options.run.park,
            ...(options.run.live ? { live: options.run.live } : {}),
            ...(options.run.skip ? { skip: options.run.skip } : {}),
          },
        }
      : {}),
  });
  await waits.open();
  const mailbox = withEvents ? waits : undefined;
  if (mailbox) options.run.listenNudges?.(() => mailbox.nudge());
  // The mailbox's parking asks the owner, made after it: by then it is.
  const owner: WorkflowOwner = new WorkflowOwner({
    ...(mailbox ? { mailbox } : {}),
    waits,
    ...(keptSessions ? { keptSessions } : {}),
    ...(restoredTurns ? { restoredTurns } : {}),
    failRun: (error) => fatal.reject(error),
    decisions,
    ...(options.allowance ? { allowance: options.allowance } : {}),
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
    now,
    deadline: options.deadline,
    runtime: options.runtime,
    host,
    slots,
    control,
    ledger,
    onLog: warn,
    log: say("log"),
    events,
    onCallerStopped: options.onCallerStopped,
    livenessPolicy: options.livenessPolicy,
    ...(options.defaultWindowMs === undefined ? {} : { defaultWindowMs: options.defaultWindowMs }),
    awaitReply: options.awaitReply ?? ((execution, confirms) => canAwaitReply(execution, confirms)),
    coordinators: options.coordinators ?? [],
    emit: options.emit ?? machineEmitter,
    workflow: definition.meta.name,
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
        () =>
          Promise.race([
            // Its value waits for the message operations its routes outside any stage opened.
            definition.run(owner.context, args).then(async (returned) => {
              await owner.settleMessages();
              return returned;
            }),
            fatal.promise,
            // A park ends the body, even code that caught it.
            waits.whenParked,
          ]),
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
    if (mailbox && !mailbox.parked)
      await owner.endStartedTurns(failed ? "the workflow failed" : "the workflow returned");
    // Once `parked` is written, the attempt is parked, whatever the code did after.
    if (waits.parked) {
      failed = true;
      failure = waits.parked;
    }
    const ending = stages.settle(
      failed ? failure : undefined,
      signal.aborted || failure instanceof DeadlineExceededError,
    );
    if (ending !== undefined) {
      failed = true;
      failure = ending;
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
      .catch((error) => warn(`awf: a stage record was not written: ${messageOf(error)}`));
    await events.close();
    const usage = await ledger.settle(reading.signal);
    signal.removeEventListener("abort", cutReading);
    const times = { startedAt: new Date(startedAt).toISOString(), finishedAt };
    const opened = sandboxes.records();
    const given = skills.records();
    const placed = owner.panes();
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
      ...(placed.length > 0 ? { panes: placed } : {}),
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
        messages: known.messages,
        agents: agents.map((agent) => {
          const queued = owner.held(agent.key);
          const liveUntil = owner.liveUntilOf(agent.key);
          return {
            ...known.agents.get(agent.key),
            ...agent,
            ...(queued > 0 ? { queued } : {}),
            ...(liveUntil === undefined ? {} : { liveUntil }),
          };
        }),
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
  deadline: AbsoluteDeadline | undefined;
  sessions: AgentSessions;
  ledger: AgentLedger;
  /** Its skills' sources, resolved when it opens; absent when it has the operator's. */
  skills?: SkillSource[];
  /** The host's activation for the agent, working in `cwd`, inside its seat's occupant if sandboxed. */
  activation(
    cwd: string,
    seated?: Pick<SeatedAgent, "occupant" | "webSearch">,
    skills?: AgentSkills,
    /** Its harness home: a sandbox's, or its own on the host. */
    home?: string,
  ): HarnessActivation;
  /**
   * A fork whose parent has a harness home of its own: the parent's session, copied into `copy` by
   * `forked`, is placed in this agent's home before it is admitted, in the parent's sandbox.
   */
  carried?: { parent: AgentKey; forked: Promise<unknown>; copy: string };
  /**
   * Settles before the host places the pane: once a `beside` target has opened, with why the
   * layout can't be used where the engine knows already.
   */
  layoutFallback?: Promise<string | undefined>;
};

class WorkflowOwner {
  readonly #cleanupFailures: Error[] = [];
  readonly context: WorkflowContext;
  readonly #agents = new Map<string, AgentEntry>();
  /** Each agent once it has opened, by key: what messaging asks about, and what a ref must be. */
  readonly #logical = new Map<string, LogicalAgent>();
  readonly #messaging: Messaging;
  readonly #tools: ToolCalls<ExecutionScope>;
  /** A stage's execution scope, by its messaging scope: what owns the operations its routes open. */
  readonly #stageScopes = new Map<MessagingScope, ExecutionScope>();
  /** Message operations routes outside any stage opened, which the attempt owns. */
  readonly #attemptOwned = new Set<Promise<unknown>>();
  /** Resolves on any change to messaging, for a drain waiting on it. */
  #messagingChange = Promise.withResolvers<void>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<unknown[]> | undefined;
  /** The bundled `wf`'s source, built once, at the first sandboxed agent. */
  #bundle: Promise<string> | undefined;
  /** The calling session, once the workflow has asked for it (ADR 0010). */
  #caller: { key: string; state: Promise<LogicalAgent> } | undefined;
  /** Stops a fork of the session the run was started from, whose process is not an agent's. */
  readonly #closingRun = new AbortController();
  /** Outside participants the workflow connected, by key: the refs a route's ends must be. */
  readonly #outsideRefs = new Map<string, ParticipantRef>();

  constructor(
    private readonly options: {
      sandboxes: RunSandboxes;
      skills: RunSkills;
      failRun(error: Error): void;
      runDir: string;
      livenessPolicy?: LivenessPolicy;
      defaultWindowMs?: number;
      locks: CredentialLocks;
      environment: Readonly<Record<string, string | undefined>>;
      decisions: RunDecisions;
      allowance?: (harness: Harness) => Promise<HarnessAllowance>;
      stages: StageLedger;
      runId: string;
      attempt: number;
      cwd: string;
      deadline: AbsoluteDeadline | undefined;
      runtime: AgentRuntimeConfig;
      host: AgentRunHost;
      slots: ResultSlotRegistry;
      control: ResultControlPlane;
      ledger: RunLedger;
      progress: RunProgress;
      recordTurn: RecordTurn;
      /** Engine warnings, written to the event log as well, under `stage` or the scope's. */
      onLog?: Warn;
      /** The workflow's own log lines. */
      log(message: string, fields?: JsonObject): void;
      events: RunEventLog;
      onCallerStopped?: RunWorkflowOptions["onCallerStopped"];
      awaitReply: NonNullable<RunWorkflowOptions["awaitReply"]>;
      coordinators: readonly CoordinatorPort[];
      /** A run of a workflow with `events`: its mailbox, which its waits take from. */
      mailbox?: RunMailbox;
      /** The run's time. */
      now: () => number;
      /** Its timers: the mailbox for a run with `events`, one of its own for a plain run. */
      waits: RunMailbox;
      /** With `mailbox`: each root agent's last session in earlier attempts, which it reopens on. */
      keptSessions?: ReadonlyMap<string, NativeFork>;
      /** With `mailbox`: each agent's turn an earlier attempt started whose end no wait took. */
      restoredTurns?: ReadonlyMap<string, RestoredTurn>;
      emit: Emitter;
      /** The workflow's name, which with the run's id is the ref its events are `from`. */
      workflow: string;
    },
  ) {
    this.#restored = new Map(options.restoredTurns ?? []);
    this.#messaging = new Messaging({
      agent: (key) => this.#agentView(key),
      canAwait: (key) => {
        const agent = this.#logical.get(key);
        // One with a started turn takes messages only once a wait has its end: a reply awaited from
        // it could wait on code that is itself waiting.
        if (!agent || agent.hasStartedTurn) return false;
        return options.awaitReply(agent.execution, agent.confirmsDelivery);
      },
      launcher: (key) => this.#logical.get(key)?.launcher ?? "wf",
      changed: (key) => {
        this.#messagesChanged();
        this.#logical.get(key)?.messagesChanged();
      },
      schedule: (at, action) => scheduleAt({ unixMilliseconds: at }, action),
      now: Date.now,
      record: async (event) => {
        this.#messagesChanged();
        if (event.kind === "message-sent") {
          options.progress.messageSent({
            from: event.from,
            to: event.to,
            bytes: event.bytes,
            at: Date.now(),
            ...(event.awaitsReply ? { asks: true as const } : {}),
            ...(event.replyTo === undefined ? {} : { answers: true as const }),
          });
        }
        if (!(await options.events.event({ ...event, callPath: [] }))) {
          throw new Error("the run's event log was not written");
        }
        for (const port of options.coordinators) {
          try {
            port.recorded(event);
          } catch (error) {
            options.onLog?.(`awf: a coordinator did not take an event: ${messageOf(error)}`);
          }
        }
      },
    });
    options.control.attach(this.#messaging);
    this.#tools = new ToolCalls<ExecutionScope>({
      record: (event) => options.events.event(event),
      runIn: (scope, fn) => (scope ? scopes.run(scope, fn) : scopes.exit(fn)),
    });
    options.control.attachTools(this.#tools);
    const holder = {
      reply: (request: HolderRequest) => this.#messaging.holderReply(request),
      send: (request: HolderRequest) => this.#messaging.holderSend(request),
      open: () => this.#messaging.openQuestions(),
    };
    for (const port of options.coordinators) port.attach(holder);
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
          const stopped = this.#agents.get(key)?.stopped;
          if (stopped !== undefined) return Promise.reject(stoppedError(key, stopped));
          if (runtime !== undefined) {
            return Promise.reject(
              new Error(`agent ${key} is the calling session, whose runtime is the operator's`),
            );
          }
          return this.#caller.state;
        },
        stop: (key, reason) => {
          try {
            return this.stopAgent(key, reason);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        caller: (spec) => {
          try {
            return this.caller(spec.key);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        forkCaller: (spec) => {
          if ((spec as AgentForkSpec).tools !== undefined)
            return Promise.reject(new Error("a fork of the calling session takes no tools"));
          try {
            return this.forkCaller(spec);
          } catch (error) {
            return Promise.reject(error);
          }
        },
      },
      sandboxes: {
        open: (spec) => {
          if (this.#closed || this.#cleanupFailures.length)
            return Promise.reject(new Error("workflow context is closed"));
          try {
            this.options.stages.checkOperation();
          } catch (error) {
            return Promise.reject(error);
          }
          return this.track(options.sandboxes.open(spec));
        },
      },
      decisions: {
        decide: (spec) => {
          if (this.#closed || this.#cleanupFailures.length)
            return Promise.reject(new Error("workflow context is closed"));
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
              ...(scope ? { add: (cancel) => scope.add((stop) => cancel(stop.reason)) } : {}),
              ...(scope?.stage === undefined ? {} : { stage: scope.stage }),
            }),
          );
          scope?.track(decided);
          return decided;
        },
      },
      participants: {
        connect: async (spec) => this.connectParticipant(spec),
        get: async (key) =>
          (this.#messaging.connected().includes(key) ? this.#outsideRefs.get(key) : undefined) ??
          (this.#logical.get(key) as AgentRef | undefined) ??
          null,
      },
      messages: { allow: async (access) => this.allowRoute(access) },
      steps: {
        run: () => unavailable("steps.run"),
        sleep: () => unavailable("steps.sleep"),
      },
      emit: async (target, run, name, data, emitOptions) => {
        if (this.#closed || this.#cleanupFailures.length)
          throw new Error("workflow context is closed");
        scopes.getStore()?.assertAccepting();
        if (!isEventWorkflow(target))
          throw new Error("emit's target is a workflow with events, as its file exports it");
        return this.track(
          options.emit(
            target,
            {
              run,
              name,
              data: data as JsonValue,
              ...(emitOptions?.eventId === undefined ? {} : { id: emitOptions.eventId }),
            },
            `${options.workflow}/${options.runId}`,
          ),
        );
      },
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
      allowance: async (harness) => {
        if (this.#closed || this.#cleanupFailures.length)
          throw new Error("workflow context is closed");
        if (!(HARNESS_NAMES as readonly string[]).includes(harness))
          throw new Error(`allowance: no harness ${harness}; awf has ${HARNESS_NAMES.join(", ")}`);
        if (!options.allowance)
          return { harness, read: "none", reason: "this run has no allowance reader" };
        return this.track(options.allowance(harness as Harness));
      },
      log: (message, fields) => options.log(message, fields),
      now: () => new Date(options.now()),
      sleep: async (name, when) => {
        await this.race(
          options.waits,
          name,
          { sleep: checkedWhen(when) } as RaceBranches,
          undefined,
        );
      },
    };
    const { mailbox } = options;
    Object.assign(
      this.context,
      mailbox
        ? {
            receive: (spec?: ReceiveOptions) => this.receive(mailbox, spec),
            race: (name: string, branches: RaceBranches, raceOptions?: WaitOptions) =>
              this.race(mailbox, name, branches, raceOptions),
            select: (branches: Branches, selectOptions?: SelectOptions) =>
              this.select(mailbox, branches, selectOptions),
            timer: (name: string, when: When) => this.timer(mailbox, name, when),
            timers: () => source({}, { name: "timer:due" }),
            signal: (name: string) => signalSource(name),
            ...(mailbox.started ? { started: mailbox.started } : {}),
          }
        : { receive: () => Promise.reject(new Error("receive needs a workflow with events")) },
    );
  }

  /** Checks a wait may begin here: one at a time, outside a tool's handler, in an open scope. */
  #beginWait(what: string): ExecutionScope | undefined {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    if (inToolHandler())
      throw new Error(`${what} is refused in a tool's handler: it would take the run's events`);
    const scope = scopes.getStore();
    scope?.assertAccepting();
    if (this.#waiting)
      throw new Error(`${what} was called while another wait is waiting; one wait at a time`);
    return scope;
  }

  /** Runs a wait, which ends with the run, as its owner closes, or with the scope it waits in. */
  async #holdingWait(
    scope: ExecutionScope | undefined,
    wait: (signal: AbortSignal) => Promise<WorkflowEvent<string, JsonValue>[]>,
  ): Promise<WorkflowEvent<string, JsonValue>[]> {
    this.#waiting = true;
    const cancelled = new AbortController();
    const removeFromScope = scope?.add(async (stop) =>
      cancelled.abort(new Error(String(stop.reason ?? "the wait's scope was cancelled"))),
    );
    try {
      const taken = await wait(AbortSignal.any([this.#closingRun.signal, cancelled.signal]));
      // A turn's end taken: its agent takes other work again.
      for (const event of taken) {
        if (event.name !== "agent:ended") continue;
        const { turn } = event.data as unknown as TurnEnd;
        if (this.#restored.get(event.from)?.turn === turn) this.#restored.delete(event.from);
        this.#logical.get(event.from)?.endTaken(turn);
      }
      return taken;
    } finally {
      removeFromScope?.();
      this.#waiting = false;
    }
  }

  /** A timer, by name: the recorded one, or set now. A race's own are named `{race}@{branch}`. */
  private timer(mailbox: RunMailbox, name: string, when: When, own = false): Timer {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    if (typeof name !== "string") throw new Error("a timer's name is a string");
    if (!own) {
      const problem = name.includes("@")
        ? "without @, which a race's own timers use"
        : nameProblem(name);
      if (problem) throw new Error(`timer ${name}: its name is ${problem}`);
    }
    const given = parseWhen(when, this.options.now());
    const { timer, asked } = mailbox.setTimer(name, given.due, given.when);
    if (timer.cancelled)
      this.options.onLog?.(
        `awf: timer ${name} was cancelled; a name stays cancelled, so it won't fire`,
      );
    else if (asked !== undefined)
      this.options.onLog?.(
        `awf: timer ${name} is due ${timer.due}, as first set (${timer.when}); ${asked} is ignored`,
      );
    return timerSource(mailbox, name, timer.due);
  }

  /** Waits for the first of `branches`, recorded under `name`. */
  private async race(
    mailbox: RunMailbox,
    name: string,
    branches: RaceBranches,
    raceOptions: WaitOptions | undefined,
  ): Promise<Next<RaceBranches>> {
    const scope = this.#beginWait(`race ${name}`);
    if (typeof name !== "string" || nameProblem(name))
      throw new Error(
        `a race's name is ${typeof name === "string" ? nameProblem(name) : "a string"}`,
      );
    if (scope?.stage !== undefined)
      throw new Error(`race ${name} is in stage ${scope.stage}: a race is recorded on its own`);
    if (this.#raced.has(name))
      throw new Error(
        `race ${name} has answered in this attempt; a wait in a loop is named per round, as approval-\${round}`,
      );
    this.#raced.add(name);
    const label = checkedLabel(raceOptions?.label);
    const given = branchesOf(`race ${name}`, branches, true);
    // A sleep's time may be a Date, its own timer as a duration is.
    const own = (source: unknown) => typeof source === "string" || source instanceof Date;
    // Every branch checked before a timer is set, so a refused race leaves none behind.
    const takes = new Map(
      given.flatMap(([branch, source]) =>
        own(source) ? [] : [[branch, sourceTake(`race ${name}`, branch, source)] as const],
      ),
    );
    const owned = new Map<string, string>();
    const pairs: (readonly [string, WaitTake])[] = given.map(([branch, source]) => {
      if (!own(source)) return [branch, takes.get(branch) as WaitTake] as const;
      const timer = this.timer(mailbox, `${name}@${branch}`, source as When, true);
      owned.set(branch, timer.name);
      return [branch, { name: "timer:due", from: timer.name }] as const;
    });
    let won: { branch: string; event: WorkflowEvent<string, JsonValue> } | undefined;
    try {
      await this.#holdingWait(scope, async (signal) => {
        won = await mailbox.race(name, pairs, owned, label, signal);
        return [won.event];
      });
    } catch (error) {
      // Cut short, not parked: its own timers would fire into a later wait. A park's rerun races again.
      if (!(error instanceof RunParked))
        await Promise.all([...owned.values()].map((timer) => mailbox.cancelTimer(timer))).catch(
          () => undefined,
        );
      throw error;
    }
    const { branch, event } = won as { branch: string; event: WorkflowEvent<string, JsonValue> };
    return { key: branch, [branch]: branchValue(event) } as Next<RaceBranches>;
  }

  /** A loop over the events `branches` take, one at a time. */
  private select(
    mailbox: RunMailbox,
    branches: Branches,
    selectOptions: SelectOptions | undefined,
  ): AsyncIterable<Next<Branches>> {
    const pairs = branchesOf("select", branches, false).map(
      ([branch, source]) => [branch, sourceTake("select", branch, source)] as const,
    );
    const takes = pairs.map(([, take]) => take);
    const labelOf = () => {
      const given = selectOptions?.label;
      return checkedLabel(typeof given === "function" ? given() : given);
    };
    const next = async (): Promise<Next<Branches>> => {
      const scope = this.#beginWait("select");
      if (scope?.stage !== undefined)
        throw new Error(`select is in stage ${scope.stage}: a loop's wait is not a stage's`);
      const [event] = await this.#holdingWait(scope, async (signal) => [
        await mailbox.select(takes, labelOf(), signal),
      ]);
      const taken = event as WorkflowEvent<string, JsonValue>;
      const branch = branchOf(pairs, taken) as string;
      return { key: branch, [branch]: branchValue(taken) } as Next<Branches>;
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: await next() }),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  }

  #waiting = false;
  /** The races and sleeps this attempt has run, each by its name once. */
  readonly #raced = new Set<string>();
  /** Each agent's turn an earlier attempt started whose end no wait has taken yet. */
  readonly #restored: Map<string, RestoredTurn>;

  /** How an agent of an event run records its started turns in the mailbox. */
  #turnsOf(key: string, mailbox: RunMailbox): LogicalAgentTurns {
    return {
      begin: (turn, meta, execution) => mailbox.beginTurn(key, turn, meta, execution),
      end: (turn, meta, outcome) => mailbox.endTurn(key, { turn, meta, outcome }),
      // Read when the agent opens: a wait before then may have taken the end.
      restored: () => this.#restored.get(key),
    };
  }

  /**
   * The code returned or threw: each started turn still running is cancelled, and its end written,
   * before the attempt's ending.
   */
  async endStartedTurns(reason: string): Promise<void> {
    // Bounded as cleanup is: what is cut, a continue's recovery ends.
    await waitForDeadline(
      Promise.all([...this.#logical.values()].map((agent) => agent.endStarted(reason))),
      { unixMilliseconds: Date.now() + CLEANUP_GRACE_MILLISECONDS },
    ).catch((error: unknown) =>
      this.options.onLog?.(`awf: a started turn's end was not written: ${messageOf(error)}`),
    );
  }

  /**
   * Nothing of the run is working but its wait: no agent's turn, message or compaction, and no
   * decision, sandbox or agent opening in flight.
   */
  idle(waitStage?: string): boolean {
    const open = this.options.stages.openStage;
    return (
      (open === undefined || open === waitStage) &&
      this.#inFlight.size === 0 &&
      [...this.#logical.values()].every((agent) => !agent.busy)
    );
  }

  /** The end of an idle agent's open window. */
  liveUntilOf(key: AgentKey): number | undefined {
    const agent = this.#logical.get(key);
    return agent && !agent.busy ? agent.liveUntil() : undefined;
  }

  /** The end of the earliest window an agent holds open: the run stays live to it. */
  liveUntil(): number | undefined {
    const ends = [...this.#logical.values()].flatMap((agent) => agent.liveUntil() ?? []);
    return ends.length > 0 ? Math.min(...ends) : undefined;
  }

  /**
   * Calls one agent's due `onTimeout`, in the scope of the wait that calls this, and says whether
   * it did. A stop or the scope's cancellation stops waiting on it.
   */
  async timeout(signal?: AbortSignal): Promise<boolean> {
    for (const agent of this.#logical.values()) {
      const onTimeout = agent.takeTimeout();
      if (!onTimeout) continue;
      try {
        await runUntilStopped(
          async () => asTimeoutHandler(() => onTimeout(agent as unknown as EventAgentRef)),
          signal,
          undefined,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        this.options.onLog?.(`awf: agent ${agent.key}'s onTimeout threw: ${messageOf(error)}`);
      }
      return true;
    }
    return false;
  }
  /** The batch a wait in a stage took, by stage, until the stage ends: what it must return. */
  readonly #stageBatches = new Map<string, WorkflowEvent<string, JsonValue>[]>();
  /** Stages around a wait this attempt entered: each is entered once, as a loop over one spins. */
  readonly #waitedStages = new Set<string>();

  /** A wait: one at a time, and in a stage, the stage's batch. */
  private async receive(
    mailbox: RunMailbox,
    spec: ReceiveOptions | undefined,
  ): Promise<WorkflowEvent<string, JsonValue>[]> {
    const scope = this.#beginWait("receive()");
    if (scope?.stage !== undefined && this.#stageBatches.has(scope.stage))
      throw new Error(`stage ${scope.stage} has waited once; a stage holds one wait`);
    try {
      const taken = await this.#holdingWait(scope, (signal) =>
        mailbox.receive(spec, scope?.stage, signal),
      );
      if (scope?.stage !== undefined) {
        this.#stageBatches.set(scope.stage, taken);
        this.#waitedStages.add(scope.stage);
      }
      return taken;
    } catch (error) {
      // Parked in a stage: left unended now, before anything closes it, for the next attempt.
      if (error instanceof RunParked && scope?.stage !== undefined)
        this.options.stages.abandon(scope.stage);
      throw error;
    }
  }

  /** An agent as messaging sees it, from its entry and its operations. */
  #agentView(key: string): AgentView | undefined {
    const agent = this.#logical.get(key);
    if (!agent) return undefined;
    const caller = agent.execution.caller ? { caller: true as const } : {};
    const stopped = this.#agents.get(key)?.stopped ?? agent.closedReason;
    if (stopped !== undefined) return { state: "stopped", reason: stopped, ...caller };
    return { state: agent.busy ? "working" : agent.hasRun ? "idle" : "not-started", ...caller };
  }

  /** Connects a participant outside the run under a key no agent holds and none reserved. */
  private connectParticipant(spec: ParticipantSpec): ParticipantRef {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    scopes.getStore()?.assertAccepting();
    if (typeof spec !== "object" || spec === null || typeof spec.key !== "string" || !spec.key)
      throw new Error("a participant is connected as { key, labels? }");
    const { key, labels } = spec;
    this.#assertFreeKey(key, "a participant");
    if (this.#agents.has(key) || this.#logical.has(key) || this.#caller?.key === key)
      throw new Error(`${key} is an agent's key; a participant takes a key of its own`);
    if (
      labels !== undefined &&
      (typeof labels !== "object" ||
        labels === null ||
        Array.isArray(labels) ||
        !isJsonValue(labels))
    )
      throw new Error("a participant's labels are a JSON object");
    const to = (spec as { to?: unknown }).to;
    if (to !== undefined && to !== "code")
      throw new Error(`a participant's messages go to agents, or to: "code"; not ${String(to)}`);
    if (to === "code" && !this.options.mailbox)
      throw new Error(
        "a participant routed to the code needs a workflow with events, whose waits take its replies",
      );
    this.#messaging.connect(
      key,
      labels === undefined ? undefined : structuredClone(labels),
      to === "code" ? "code" : undefined,
    );
    const ref: ParticipantRef = {
      ...participantRef(key),
      release: async (reason) => {
        if (reason !== undefined && typeof reason !== "string")
          throw new Error("a release's reason is a string");
        return this.#messaging.release(key, reason);
      },
    };
    if (to === "code") {
      const routed = source(
        {
          ...ref,
          post: async (text: string) => {
            if (typeof text !== "string" || text.trim() === "")
              throw new Error("post takes the text to write");
            await this.#messaging.post(key, text);
          },
        },
        { name: "participant:reply", from: key },
      ) as unknown as CodeParticipantRef;
      this.#outsideRefs.set(key, routed);
      return routed;
    }
    this.#outsideRefs.set(key, ref);
    return ref;
  }

  /** A key an agent may not take: a reserved one, or an outside participant's. */
  #assertFreeKey(key: string, who: string): void {
    if ((RESERVED_PARTICIPANT_KEYS as readonly string[]).includes(key.toLowerCase()))
      throw new Error(
        `${key} is reserved: an agent could read a message from it as authority; ${who} takes another key`,
      );
    if (this.#messaging.isOutside(key))
      throw new Error(`${key} is a participant outside the run; ${who} takes another key`);
  }

  #messagesChanged(): void {
    const change = this.#messagingChange;
    this.#messagingChange = Promise.withResolvers<void>();
    change.resolve();
  }

  /**
   * Grants a route in the current stage, or for the attempt outside any. Its ends must be the refs
   * this run issued: a spread or cast of one names an agent it did not hand out.
   */
  private allowRoute(access: MessageAccess): void {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    const scope = scopes.getStore();
    scope?.assertAccepting();
    const end = (ref: unknown): string => {
      const key =
        typeof ref === "object" && ref !== null ? (ref as { key?: unknown }).key : undefined;
      const issued =
        typeof key === "string"
          ? (this.#logical.get(key) ?? this.#outsideRefs.get(key))
          : undefined;
      if (!issued || issued !== ref) {
        throw new Error(
          `a route's ends are agents this workflow opened or participants it connected; ${typeof key === "string" ? key : "this"} is not one`,
        );
      }
      return issued.key;
    };
    if (typeof access !== "object" || access === null)
      throw new Error("a route is { from, to } or { between }, with a purpose");
    const shape = access as { from?: unknown; to?: unknown; between?: unknown };
    let ends: { from: string; to: string } | { between: [string, string] };
    if (shape.between !== undefined) {
      if (shape.from !== undefined || shape.to !== undefined)
        throw new Error("a route is between two agents, or from one to another, not both");
      if (!Array.isArray(shape.between) || shape.between.length !== 2)
        throw new Error("a route between agents names two of them");
      ends = { between: [end(shape.between[0]), end(shape.between[1])] };
    } else ends = { from: end(shape.from), to: end(shape.to) };
    this.#messaging.grant(ends, {
      purpose: access.purpose,
      maxMessages: access.maxMessages,
      timeoutMs: access.timeoutMs,
      scope: scope?.messages ?? this.#messaging.attempt,
    });
  }

  /** Who owns a message operation a route in `scope` opens: its stage, or the attempt. */
  #messageOwner(
    scope: MessagingScope,
  ): { stage?: ExecutionScope; adopt(operation: Promise<unknown>): void } | undefined {
    if (scope.state === "closed") return undefined;
    const stage = this.#stageScopes.get(scope);
    if (stage) {
      return {
        stage,
        adopt: (operation) => {
          stage.adopt(operation);
          this.#messagesChanged();
        },
      };
    }
    if (scope !== this.#messaging.attempt) return undefined;
    return {
      adopt: (operation) => {
        this.#attemptOwned.add(operation);
        this.#messagesChanged();
        // The attempt owns it: one that times out or whose harness fails ends the run, even after
        // the workflow returned a value.
        operation.catch((error: unknown) => this.options.failRun(error as Error));
      },
    };
  }

  /**
   * Until nothing a scope owns is in flight: its operations settled, and no answer owed or message
   * held on its routes. A message held for an idle agent opens an operation meanwhile, which the
   * scope then owns too.
   */
  private async drainMessages(scope: MessagingScope, settle: () => Promise<void>): Promise<void> {
    for (;;) {
      const change = this.#messagingChange.promise;
      await settle();
      if (!this.#messaging.busy(scope)) {
        await settle();
        if (!this.#messaging.busy(scope)) return;
      }
      await change;
    }
  }

  /** Messages held for `key` and not yet shown. */
  held(key: AgentKey): number {
    return this.#messaging.held(key);
  }

  /**
   * The workflow returned: its routes outside any stage take nothing new, and the message
   * operations they opened are waited for, as a stage waits for its own. A question open to an
   * outside participant keeps it waiting too; once none is, each one still connected is released.
   */
  async settleMessages(): Promise<void> {
    const attempt = this.#messaging.attempt;
    this.#messaging.finishing(attempt);
    await this.drainMessages(attempt, async () => {
      const settled = await Promise.allSettled([...this.#attemptOwned]);
      const failed = settled.find((each) => each.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    for (const key of this.#messaging.connected()) {
      this.#messaging.release(key, "the workflow returned");
    }
  }

  async close(deadline: AbsoluteDeadline): Promise<unknown[]> {
    this.#closing ??= (async (): Promise<unknown[]> => {
      this.#closed = true;
      // Nothing more is delivered; what was held is recorded undelivered.
      this.#messaging.close();
      this.#closingRun.abort();
      // Each agent is closed by itself first, which knows whether its pane stays; then the host,
      // which closes whatever is left.
      const stopping = [...this.#agents.values()].map((agent) =>
        agent.state.then(
          (state) =>
            state
              .stopOperations({
                kind:
                  this.options.deadline && Date.now() >= this.options.deadline.unixMilliseconds
                    ? "timed-out"
                    : "cancelled",
                reason: "workflow closing",
              })
              .then(() => state.close("workflow complete")),
          () => undefined,
        ),
      );
      const cleanup = Promise.all([
        Promise.allSettled(stopping).then(async (stopped) => [
          ...stopped,
          ...(await Promise.allSettled([this.options.host.close("workflow complete")])),
        ]),
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
          ...this.#cleanupFailures,
        ];
      });
      try {
        return await waitForDeadline(cleanup, deadline);
      } catch (error) {
        if (error instanceof DeadlineExceededError) {
          // A session that would not close still must not outlive its sandbox: its agents are
          // released and the sandboxes closed, which ends everything inside, on a grace of their own.
          const sandboxes = this.options.sandboxes;
          // A slow agent close may be what overran: the host still closes what it made, though
          // nothing waits on it here, as an agent that never closes would hold it too.
          void this.options.host.close("workflow complete").catch(() => undefined);
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
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
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
      // A stage around a wait returns the batch it took, which its record doesn't hold.
      const batch =
        entered.value === undefined && !options
          ? await this.options.mailbox?.batchOf(name)
          : undefined;
      if (batch) {
        if (this.#waitedStages.has(name))
          throw new Error(
            `stage ${name} around a wait was entered again in this attempt, and would return the same batch forever; name it by what it waits for`,
          );
        this.#waitedStages.add(name);
      }
      return (batch as JsonValue | undefined) ?? entered.value;
    }
    const open = entered.stage;
    const messages = this.#messaging.scope(name);
    const scope = new ExecutionScope(
      parent?.deadline ?? this.options.deadline,
      parent?.group,
      name,
      messages,
    );
    this.#stageScopes.set(messages, scope);
    const removeFromParent = parent?.add((stop) => scope.cancel(stop));
    try {
      const returned: unknown = await scopes.run(scope, () => work());
      // Its routes take nothing new; what they carry still goes before the stage ends.
      this.#messaging.finishing(messages);
      scope.seal();
      await this.drainMessages(messages, () => scope.settleOwned());
      // A timer it set is written before its record, which a rerun reuses without its work.
      await this.options.waits.flush();
      if (this.options.stages.stopped?.stage === name) throw this.options.stages.caught();
      const batch = this.#stageBatches.get(name);
      if (batch && !options) {
        const same =
          Array.isArray(returned) &&
          returned.length === batch.length &&
          returned.every((event, i) => (event as { id?: unknown })?.id === batch[i]?.id);
        if (!same)
          throw new Error(
            `stage ${name} returned other events than its wait took; its work is the wait alone`,
          );
        await open.succeed(undefined);
        return batch as JsonValue;
      }
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
      // Parked at a wait in it: not ended, so the next attempt runs it again.
      else if (error instanceof RunParked) this.options.stages.abandon(name);
      else {
        this.options.stages.failedIn(name, error);
        await open.fail(messageOf(error));
      }
      throw error;
    } finally {
      this.#stageBatches.delete(name);
      this.#messaging.closeScope(messages);
      this.#stageScopes.delete(messages);
      removeFromParent?.();
    }
  }

  private openAgent(spec: AgentOpenSpec): Promise<AgentRef> {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    scopes.getStore()?.assertAccepting();
    this.#assertFreeKey(spec.key, "an agent");
    if (this.#caller?.key === spec.key) {
      throw new Error(`agent ${spec.key} is the calling session; it is not opened`);
    }
    const inRunSandbox = this.options.sandboxes.hasRunSandbox;
    if (inRunSandbox && spec.sandbox !== undefined)
      throw new Error(`agent ${spec.key}: ${RUN_SANDBOX_ONLY}`);
    const existing = this.#agents.get(spec.key);
    if (existing?.stopped !== undefined) throw stoppedError(spec.key, existing.stopped);
    const given = (spec as EventAgentOpenSpec).keepAlive;
    if (given !== undefined && !this.options.mailbox)
      throw new Error(
        `agent ${spec.key}: keepAlive is for a workflow with events, whose runs park; this one's never do`,
      );
    const keepAlive = given === undefined ? undefined : checkedKeepAlive(spec.key, given);
    const execution = existing
      ? constrainExistingExecution(spec.runtime, existing.identity.execution)
      : withKnownEffort(resolveExecution(spec.runtime, this.options.runtime));
    checkPaneOptions(spec.key, spec, {
      headless: placementOf(execution) === "headless",
      sandboxed:
        spec.sandbox !== undefined || existing?.identity.sandbox !== undefined || inRunSandbox,
    });
    const identity: AgentIdentity = {
      execution,
      cwd: spec.cwd ?? this.options.cwd,
      ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
      ...(spec.labels === undefined ? {} : { labels: structuredClone(spec.labels) }),
      ...(spec.sandbox === undefined ? {} : { sandbox: spec.sandbox }),
      ...(spec.skills === undefined ? {} : { skills: readSkillSources(spec.skills) }),
      ...(spec.layout === undefined ? {} : { layout: storedLayout(spec.layout) }),
      ...(spec.keepPane === undefined ? {} : { keepPane: spec.keepPane }),
    };
    const scope = scopes.getStore();
    const inheritedDeadline = scope?.deadline ?? this.options.deadline;
    const effectiveDeadline = spec.deadline
      ? earlierDeadline(spec.deadline, inheritedDeadline)
      : inheritedDeadline;
    assertDeadline(effectiveDeadline);
    if (existing) {
      assertCompatibleAgent(spec.key, existing.identity, identity, spec);
      this.#tools.reopen(spec.key, spec.tools);
      if (keepAlive) existing.keepAlive = keepAlive;
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

    this.#tools.give(spec.key, spec.tools ?? {});
    this.options.progress.agentOpened(spec.key, scope?.group);
    const found = this.options.keptSessions?.get(spec.key);
    // Reopened only where it can be: a key the code now opens on another harness starts afresh, and
    // so does an agent with a home of its own, skills or a sandbox, made anew at every open, which
    // its kept session isn't in. Either is given its instructions again.
    const homeOfItsOwn = spec.skills !== undefined || spec.sandbox !== undefined || inRunSandbox;
    const kept = found?.harness === execution.harness && !homeOfItsOwn ? found : undefined;
    if (found && !kept)
      this.options.onLog?.(
        homeOfItsOwn
          ? `agent ${spec.key} has skills or a sandbox, whose home is made anew; it starts a new session`
          : `agent ${spec.key} now runs ${execution.harness}, not the ${found.harness} its session was kept on; it starts a new session`,
      );
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
      activation: (cwd, seated, skills, home) => ({
        key: spec.key,
        deadline: harnessDeadline(effectiveDeadline),
        cwd,
        execution,
        // A kept session already holds the instructions; they are not sent again.
        ...(kept ? { continues: kept } : {}),
        ...(spec.instructions === undefined || kept ? {} : { instructions: spec.instructions }),
        ...(this.options.mailbox ? { paneAtFirstTurn: true as const } : {}),
        ...(spec.labels === undefined ? {} : { labels: spec.labels }),
        ...(seated ? { occupant: seated.occupant } : {}),
        ...(seated?.webSearch ? { webSearch: true } : {}),
        ...(skills ? { skills } : {}),
        ...(home ? { home } : {}),
        ...paneOptions(identity),
      }),
      layoutFallback: this.besideFallback(identity.layout, effectiveDeadline)(),
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
    this.agentOpened(ownedState, accounted);
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
      ...(keepAlive ? { keepAlive } : {}),
    });
    const activated = this.track(waitForDeadline(ownedState, effectiveDeadline));
    scope?.track(activated);
    return activated;
  }

  /**
   * Ends an agent the workflow has no more use for, as an operation that fails ends it: what it
   * is running is cancelled, and its pane closed or, where `keepPane` says, kept and released.
   */
  private stopAgent(key: string, reason?: string): Promise<boolean> {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    const inTool = refusedInTool(key, "agents.stop");
    if (inTool) throw inTool;
    const scope = scopes.getStore();
    scope?.assertAccepting();
    this.options.stages.checkOperation();
    const deadline = scope?.deadline ?? this.options.deadline;
    assertDeadline(deadline);
    const wait = (pending: Promise<boolean>) => {
      const bounded = this.track(waitForDeadline(pending, deadline));
      scope?.track(bounded);
      return bounded;
    };
    const entry = this.#agents.get(key);
    if (!entry || entry.stopComplete) return Promise.resolve(false);
    if (entry.stopping) return wait(entry.stopping);
    entry.stopped ??= reason ?? "stopped by the workflow";
    const stopping = this.track(
      (async () => {
        const state = await entry.state.catch(() => undefined);
        if (!state) {
          delete entry.stopped;
          return false;
        }
        this.options.progress.agentStopped(key, entry.stopped!);
        try {
          await state.close(entry.stopped);
        } finally {
          await entry.channel.then((channel) => channel?.close());
        }
        if (this.#caller?.key === key) {
          entry.releasedAt = Date.now();
          try {
            await this.options.onCallerStopped?.(entry.stopped!);
          } catch (error) {
            this.options.onLog?.(
              `awf: the calling session was not handed back: ${messageOf(error)}`,
            );
          }
        }
        entry.stopComplete = true;
        return true;
      })(),
    );
    entry.stopping = stopping;
    stopping
      .finally(() => {
        if (entry.stopping === stopping) delete entry.stopping;
      })
      .catch(() => undefined);
    return wait(stopping);
  }

  /**
   * The session the run was started from, under the key the workflow names: `null` when there is
   * none. It is found, not opened: its harness, directory and skills are the operator's, and it
   * answers through a launcher by path as any pane agent does (ADR 0010).
   */
  private caller(key: string): Promise<AgentRef | null> {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    const scope = scopes.getStore();
    scope?.assertAccepting();
    this.#assertFreeKey(key, "an agent");
    const found = this.options.runtime.host.caller;
    if (!found) return Promise.resolve(null);
    if (this.#caller) {
      if (this.#caller.key !== key) {
        throw new Error(
          `the calling session is already agent ${this.#caller.key}; it cannot also be ${key}`,
        );
      }
      const stopped = this.#agents.get(key)?.stopped;
      if (stopped !== undefined) throw stoppedError(key, stopped);
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
      releasedAt: () => this.#agents.get(key)?.releasedAt,
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
          deadline: harnessDeadline(this.options.deadline),
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
    this.agentOpened(owned, accounted, { caller: true });
    this.#caller = { key, state: owned };
    this.#agents.set(key, {
      identity: { execution, cwd: found.cwd },
      opening: { sessions, accounted, skills: Promise.resolve(undefined) },
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
   * A fork of the session the run was started from (story 027). Handed over and held as the caller,
   * it is that agent's own fork, taken in its queue; otherwise it is taken now, from a parent the
   * run never opened. `null`, and the reason logged, where there is none to fork.
   */
  private forkCaller(spec: AgentForkSpec): Promise<AgentRef | null> {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    const scope = scopes.getStore();
    scope?.assertAccepting();
    this.options.stages.checkOperation();
    if (this.#caller) {
      const stopped = this.#agents.get(this.#caller.key)?.stopped;
      if (stopped !== undefined) throw stoppedError(this.#caller.key, stopped);
    }
    const calling = this.options.runtime.host.calling;
    if (calling === undefined || typeof calling === "string") {
      this.options.onLog?.(
        `awf: forkCaller: no session to fork${calling === undefined ? "" : `: ${calling}`}`,
      );
      return Promise.resolve(null);
    }
    if (this.#caller) return this.#caller.state.then((caller) => caller.fork(spec));
    const execution: AgentExecution = { harness: calling.harness, model: "", caller: true };
    const parent: AgentEntry = {
      identity: { execution, cwd: calling.cwd },
      opening: {
        sessions: { launcher: new Set(), forks: [] },
        accounted: { key: CALLING, execution, cwd: calling.cwd, sessions: () => [calling.session] },
        skills: Promise.resolve(undefined),
      },
      state: Promise.reject(new Error("the calling session is not an agent of this run")),
      channel: Promise.resolve(undefined),
    };
    parent.state.catch(() => undefined);
    const deadline = scope?.deadline ?? this.options.deadline;
    return this.forkAgent(
      CALLING,
      spec,
      (into) =>
        calling
          .fork(deadlineWithin(FORK_TIMEOUT_MS, deadline), into, this.#closingRun.signal)
          .then((native) => ({ native, after: null })),
      execution,
      parent,
    );
  }

  /**
   * An agent on the host: its skills placed first, since a source that will not resolve refuses the
   * agent before it holds anything, then its channel and session together.
   */
  private openHostAgent(
    { spec, execution, sessions, ledger, activation, layoutFallback }: AgentOpening,
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
      .then(async (skills) => {
        const fallback = await layoutFallback;
        return this.options.host.openAgent({
          ...activation(cwd, undefined, skills?.given, skills?.given.ownHome),
          ...(fallback === undefined ? {} : { layoutFallback: fallback }),
        });
      })
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
          activation(seat.cwd, seated, seat.skills, seat.home),
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
    const agent = new LogicalAgent({
      key,
      runDir: this.options.runDir,
      messaging: this.#messaging,
      tools: this.#tools,
      messageOwner: (scope) => this.#messageOwner(scope),
      execution,
      session,
      slots: this.options.slots,
      endpoint,
      launcher,
      deadline: this.options.deadline,
      ledger,
      progress: this.options.progress,
      recordTurn: this.options.recordTurn,
      events: this.options.events,
      track: (promise) => this.track(promise),
      isRunClosing: () => this.#closed || this.#cleanupFailures.length > 0,
      checkOperation: () => this.options.stages.checkOperation(),
      cleanupUnresolved: (reason) => {
        const error = new Error(reason);
        this.#cleanupFailures.push(error);
        this.options.failRun(error);
      },
      livenessPolicy: this.options.livenessPolicy,
      ...(this.options.mailbox ? { turns: this.#turnsOf(key, this.options.mailbox) } : {}),
      fork: (spec, take, settings) => this.forkAgent(key, spec, take, settings),
      keepPane: () => this.#agents.get(key)?.identity.keepPane,
      keepAlive: () => this.#agents.get(key)?.keepAlive,
      defaultWindowMs: this.options.defaultWindowMs ?? DEFAULT_WINDOW_MS,
      now: this.options.now,
      // Its socket is its authority: a kept agent's harness lives on, and must not answer.
      revoke: () =>
        this.#agents
          .get(key)
          ?.channel.then((channel) => channel?.close())
          .catch(() => undefined),
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
    this.#logical.set(key, agent);
    return agent;
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
    take: ((into?: SessionCopy) => Promise<TakenFork>) | string,
    /** The parent's settings once every `set` queued before the fork has run. */
    parentSettings: AgentExecution,
    /** A parent the run never opened: the session it was started from. */
    unopened?: AgentEntry,
  ): Promise<AgentRef> {
    if (this.#closed || this.#cleanupFailures.length) throw new Error("workflow context is closed");
    const scope = scopes.getStore();
    scope?.assertAccepting();
    this.options.stages.checkOperation();
    if (this.#caller?.key === spec.key) {
      throw new Error(`agent ${spec.key} is the calling session; it is not opened`);
    }
    this.#assertFreeKey(spec.key, "an agent");
    // Out before the clone, which throws on a handler, and out of the spec a repeat is compared by.
    const { tools, ...cloned } = spec;
    const forkSpec = structuredClone(cloned);
    if (forkSpec.layout !== undefined) forkSpec.layout = storedLayout(forkSpec.layout);
    const deadline = scope?.deadline ?? this.options.deadline;
    assertDeadline(deadline);
    // A fork of the calling session is one whichever way it was asked for.
    const from = unopened || this.#caller?.key === parentKey ? CALLING : parentKey;
    if (from === CALLING && tools !== undefined)
      throw new Error(`agent ${spec.key}: a fork of the calling session takes no tools`);
    const existing = this.#agents.get(spec.key);
    if (existing) {
      if (existing.stopped !== undefined) throw stoppedError(spec.key, existing.stopped);
      const forked = existing.identity.forkedFrom;
      if (forked?.parent !== from || !isDeepStrictEqual(forked.spec, forkSpec)) {
        throw new Error(`agent ${spec.key} is already open, not as this fork of ${from}`);
      }
      this.#tools.reopen(spec.key, tools);
      const attached = this.track(waitForDeadline(existing.state, deadline));
      scope?.track(attached);
      return attached;
    }
    const parent = unopened ?? this.#agents.get(parentKey)!;
    const opening = parent.opening!;
    if (typeof take === "string") throw new Error(take);
    // The parent's tools, with the handlers they have now, unless it gives its own.
    this.#tools.give(spec.key, tools ?? this.#tools.of(parentKey));
    const sandboxed = parent.identity.sandbox !== undefined || this.options.sandboxes.hasRunSandbox;
    // A parent with a harness home of its own has its session copied out, and the fork made in the
    // child's home: anything added to the parent's would be read as the parent's.
    const copy =
      sandboxed || opening.accounted.home !== undefined
        ? join(this.options.runDir, "forks", randomUUID())
        : undefined;
    const execution = withKnownEffort(forkExecution(parentSettings, forkSpec));
    // A fork of the calling session is an agent the run opened, on the model the session's files
    // show, which the fork reads: `""` until then (ADR 0010).
    const ofCaller = execution.caller === true;
    delete execution.caller;
    checkPaneOptions(spec.key, forkSpec, {
      headless: placementOf(execution) === "headless",
      sandboxed,
    });
    const identity: AgentIdentity = {
      execution,
      cwd: parent.identity.cwd,
      ...(forkSpec.instructions === undefined ? {} : { instructions: forkSpec.instructions }),
      ...(forkSpec.labels === undefined ? {} : { labels: forkSpec.labels }),
      ...(parent.identity.skills ? { skills: parent.identity.skills } : {}),
      ...(parent.identity.sandbox === undefined ? {} : { sandbox: parent.identity.sandbox }),
      forkedFrom: { parent: from, spec: forkSpec },
      ...(forkSpec.layout === undefined ? {} : { layout: forkSpec.layout }),
      ...(forkSpec.keepPane === undefined ? {} : { keepPane: forkSpec.keepPane }),
    };

    this.options.progress.agentOpened(spec.key, scope?.group);
    const sessions: AgentSessions = { launcher: new Set(), forks: [], parent: opening.sessions };
    opening.sessions.forks.push(sessions);
    let forkedAt: number | undefined;
    const accounted: AccountedAgent = {
      key: spec.key,
      execution,
      cwd: identity.cwd,
      sessions: () => reportedSessions(sessions),
      forkedAt: () => forkedAt,
    };
    const besideAtFork = this.besideFallback(identity.layout, deadline);
    let continues: NativeFork | undefined;
    // The fork is asked for now, in the parent's queue; the child opens once it is made. One that
    // was not made leaves nothing behind: its key may be forked again, after the parent's turn.
    const forked = take(copy === undefined ? undefined : { directory: copy })
      .then(({ native: fork, after }) => {
        if (ofCaller) {
          if (!fork.model) throw new Error(`agent ${parentKey}'s fork named no model to run on`);
          // The one object its identity, ledger and activation all hold, before it activates.
          execution.model = fork.model;
        }
        continues = fork;
        forkedAt = Date.now();
        this.options.progress.agentForked(spec.key, from);
        this.options.events.event({
          kind: "agent-forked",
          agent: spec.key,
          from: from === CALLING ? (this.#caller?.key ?? null) : from,
          after,
        });
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
      activation: (cwd, seated, given, home) => ({
        key: spec.key,
        deadline: harnessDeadline(deadline),
        cwd,
        execution,
        ...(forkSpec.instructions === undefined ? {} : { instructions: forkSpec.instructions }),
        ...(forkSpec.labels === undefined ? {} : { labels: forkSpec.labels }),
        ...(seated ? { occupant: seated.occupant } : {}),
        ...(seated?.webSearch ? { webSearch: true } : {}),
        ...(given ? { skills: given } : {}),
        ...(home ? { home } : {}),
        ...(continues ? { continues } : {}),
        ...paneOptions(identity),
      }),
      // The target as it stands when `fork` is called, waited for once the fork is made.
      layoutFallback: forked.then(besideAtFork, () => undefined),
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
    this.agentOpened(ownedState, accounted, { fork: true });
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

  /** Once it is open, where its native files are: a sandboxed agent's are known only then. */
  private agentOpened(
    state: Promise<LogicalAgent>,
    accounted: AccountedAgent,
    as?: { caller: true } | { fork: true },
  ): void {
    state.then(
      () => {
        this.options.events.event({
          kind: "agent-opened",
          agent: accounted.key,
          callPath: [],
          harness: accounted.execution.harness,
          cwd: accounted.cwd,
          ...(accounted.home === undefined ? {} : { home: accounted.home }),
          ...(as && "caller" in as ? { caller: true } : {}),
        });
        // A fork's session is made before its first operation names it.
        if (!as || !("fork" in as)) return;
        for (const id of accounted.sessions()) {
          this.options.events.event({
            kind: "session-known",
            session: { harness: accounted.execution.harness, id },
            agent: accounted.key,
          });
        }
      },
      () => undefined,
    );
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

  /**
   * Why a pane can't go beside the agent `layout` names, where the engine knows: that agent
   * is not open now, or has no pane awf places. The wait it returns waits for a target still
   * opening, so its pane is there to split.
   */
  private besideFallback(
    layout: PaneLayout | undefined,
    deadline: AbsoluteDeadline | undefined,
  ): () => Promise<string | undefined> {
    const known = (reason: string | undefined) => () => Promise.resolve(reason);
    const target = besideOf(layout);
    if (target === undefined) return known(undefined);
    if (this.#caller?.key === target) {
      return known(`${target} is the calling session, whose pane is the operator's`);
    }
    const entry = this.#agents.get(target);
    if (!entry) return known(`${target} is not open`);
    if (entry.stopped !== undefined) return known(`${target} was stopped`);
    if (placementOf(entry.identity.execution) === "headless") return known(`${target} is headless`);
    if (entry.identity.sandbox !== undefined) {
      return known(`${target} runs in a sandbox, whose panes are in its own Herdr`);
    }
    // Registered before this agent, so it can't be waiting on this one in turn.
    return () =>
      waitForDeadline(entry.state, deadline).then(
        () => (entry.stopped === undefined ? undefined : `${target} was stopped`),
        () => `${target} did not open`,
      );
  }

  /** Where each pane agent's pane went, as its host reported it, in the order opened. */
  panes(): AgentPaneRecord[] {
    return [...this.#agents].flatMap(([agent, entry]) => {
      const placed = entry.opening?.sessions.harness?.pane?.();
      if (!placed) return [];
      const { layout, keepPane } = entry.identity;
      return [
        {
          callPath: [],
          agent,
          ...(layout === undefined ? {} : { layout }),
          ...(keepPane === undefined ? {} : { keepPane }),
          placed,
        },
      ];
    });
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
  readonly [PARTICIPANT] = true as const;
  readonly #operationStops = new Set<(stop: OperationStop) => Promise<void>>();
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
  /** How its last operation ended, which `keepPane: "on-failure"` reads. */
  #last: TurnOutcome<never>["kind"] | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  /** Why it closed, once it has. */
  #closedReason: string | undefined;
  /** The operation delivered last, which a fork taken now is copied after. */
  #lastOperation: string | undefined;
  /** Operations queued or running: a message waits for them rather than waking it. */
  #queued = 0;
  /** An operation of its own has been delivered: a message to it continues its session. */
  #hasRun = false;
  /** Supervisors of its open operation, woken when something arrives for it. */
  readonly #watchers = new Set<() => void>();
  /** When its last turn this attempt that opens a window ended. */
  #lastEnd: number | undefined;
  /** A turn that opens a window ended since its `onTimeout` was last called. */
  #timeoutOwed = false;

  constructor(
    private readonly options: {
      key: string;
      runDir: string;
      messaging: Messaging;
      tools: ToolCalls<ExecutionScope>;
      /**
       * What owns a message operation a route in `scope` opens: its stage, or the attempt outside
       * any stage. Undefined once that scope has closed: nothing opens for it then.
       */
      messageOwner(
        scope: MessagingScope,
      ): { stage?: ExecutionScope; adopt(operation: Promise<unknown>): void } | undefined;
      execution: AgentExecution;
      session: HarnessSession;
      slots: ResultSlotRegistry;
      endpoint: string;
      /** The path this agent is told to run; see `installAgentLauncher`. */
      launcher: string;
      deadline: AbsoluteDeadline | undefined;
      ledger: AgentLedger;
      progress: RunProgress;
      recordTurn: RecordTurn;
      events: RunEventLog;
      track<T>(promise: Promise<T>): Promise<T>;
      isRunClosing(): boolean;
      /** Throws when no turn may start: the attempt is looking on for values it needs. */
      checkOperation(): void;
      cleanupUnresolved(reason: string): void;
      livenessPolicy?: LivenessPolicy;
      /** After each operation settles, whatever its outcome. */
      afterOperation?(): Promise<void>;
      turns?: LogicalAgentTurns;
      /**
       * Opens `spec`'s agent on the native fork `take` queues in this agent's operations, at
       * `settings`, this agent's once the operations before the fork have run.
       */
      fork(
        spec: AgentForkSpec,
        take: ((into?: SessionCopy) => Promise<TakenFork>) | string,
        settings: AgentExecution,
      ): Promise<AgentRef>;
      /** As the workflow wrote it; decides, at close, whether its pane stays. */
      keepPane(): KeepPane | undefined;
      /** As the workflow's last open of it gave it. */
      keepAlive(): KeepAlive | undefined;
      /** Its window when `keepAlive` gives no `timeoutMs`. */
      defaultWindowMs: number;
      /** The run's time, which its window is measured on. */
      now: () => number;
      /** Closes its result channel, once its pane is kept. */
      revoke(): Promise<void> | undefined;
    },
  ) {
    this.#execution = options.execution;
    asSource(this, { name: "agent:ended", from: options.key });
    // A turn an earlier attempt started whose end no wait took is this agent's turn again.
    const restored = options.turns?.restored();
    if (restored)
      this.#started = {
        ref: turnRef(options.key, restored.turn, async () => false),
        meta: restored.meta,
        ended: true,
        done: Promise.resolve(),
      };
  }

  get key(): string {
    return this.options.key;
  }

  get execution(): AgentExecution {
    return this.#execution;
  }

  get launcher(): string {
    return this.options.launcher;
  }

  /** It can confirm what a pane was sent, as waiting in a pane needs. */
  get confirmsDelivery(): boolean {
    return this.options.session.supportsWaiting === true;
  }

  get busy(): boolean {
    return this.#queued > 0;
  }

  get hasRun(): boolean {
    return this.#hasRun;
  }

  get closedReason(): string | undefined {
    return this.#closed ? (this.#closedReason ?? "closed") : undefined;
  }

  /** The end of its window while one is open; a closed agent holds none. */
  liveUntil(now = this.options.now()): number | undefined {
    const keepAlive = this.options.keepAlive();
    if (this.#closed || !keepAlive || this.#lastEnd === undefined) return undefined;
    const until = this.#lastEnd + (keepAlive.timeoutMs ?? this.options.defaultWindowMs);
    return until > now ? until : undefined;
  }

  /**
   * Its `onTimeout`, once its window has passed with it idle and a turn owed it, taken: it isn't
   * due again until another turn ends.
   */
  takeTimeout(now = this.options.now()): KeepAlive["onTimeout"] {
    const onTimeout = this.options.keepAlive()?.onTimeout;
    if (!onTimeout || !this.#timeoutOwed || this.#closed || this.busy || this.#started)
      return undefined;
    if (this.liveUntil(now) !== undefined) return undefined;
    this.#timeoutOwed = false;
    return onTimeout;
  }

  /**
   * Something arrived for it: its open operation's supervisor looks again, and an agent with
   * nothing queued wakes for a held message, in a message operation.
   */
  messagesChanged(): void {
    for (const wake of this.#watchers) wake();
    // A started turn holds messages until a wait has taken its end.
    if (this.#queued > 0 || this.#started || this.#closed || this.options.isRunClosing()) return;
    const opening = this.options.messaging.opening(this.key);
    if (opening) this.startMessageOperation(opening.scope);
  }

  /** The turn `start()` began, until a wait takes its end. */
  #started: { ref: StartedTurn; meta: JsonValue; ended: boolean; done: Promise<void> } | undefined;
  /** While `start()` hands its turn to `run()`, which refuses one otherwise. */
  #launching = false;
  /** Each running turn's own stop, by its id: what a started turn's `cancel()` stops. */
  readonly #stopsByTurn = new Map<string, (stop: OperationStop) => Promise<void>>();
  /** Started turns cancelled while still queued behind other work: they settle cancelled. */
  readonly #cancelledTurns = new Map<string, string>();

  get turn(): StartedTurn | null {
    return this.#started?.ref ?? null;
  }

  /** Whether a started turn is set: messages wait, and awaited replies are refused. */
  get hasStartedTurn(): boolean {
    return this.#started !== undefined;
  }

  /** A wait took this turn's end: the agent takes other work again. */
  endTaken(turn: TurnId): void {
    if (this.#started?.ref.id !== turn) return;
    this.#started = undefined;
    this.messagesChanged();
  }

  /** Cancels a started turn still running and waits for its end: the code returned or threw. */
  async endStarted(reason: string): Promise<void> {
    const started = this.#started;
    if (!started || started.ended) return;
    await started.ref.cancel(reason);
  }

  async start(spec: AgentStartSpec): Promise<StartedTurn> {
    const { turns } = this.options;
    if (!turns) return unavailable("AgentRef.start");
    if (this.#closed) throw new Error("logical agent is closed");
    const inTool = refusedInTool(this.key, "start()");
    if (inTool) throw inTool;
    const scope = scopes.getStore();
    if (scope !== undefined)
      throw new Error(
        `agent ${this.key}: start() is called at the run's root, as a turn not awaited would outlive a stage or a parallel`,
      );
    const refused = this.#refusedWhileStarted("start");
    if (refused) throw refused;
    const { meta = null, ...run } = spec;
    const id = run.id ?? randomUUID();
    if (!isJsonValue(meta)) throw new Error("a turn's meta is a JSON value");
    const ended = Promise.withResolvers<void>();
    let written: TurnOutcome<JsonValue>["kind"] | undefined;
    const started = {
      ref: turnRef(this.key, id, async (reason?: string) => {
        if (started.ended) return false;
        // Its turn waits for the handler, which would wait for the turn's end.
        const inTool = refusedInTool(this.key, "cancel()");
        if (inTool) throw inTool;
        const stop = { kind: "cancelled" as const, reason: reason ?? "the turn was cancelled" };
        // Its own operation only: one queued behind a message settles cancelled when it is reached.
        const own = this.#stopsByTurn.get(id);
        if (own) await own(stop);
        else this.#cancelledTurns.set(id, stop.reason);
        await started.done;
        return written === "cancelled";
      }),
      meta,
      ended: false,
      done: ended.promise,
    };
    // Claimed before anything is awaited, so a second start() at once is refused.
    this.#started = started;
    try {
      // Recorded before the agent is launched: a crash between leaves a turn a continue ends.
      await turns.begin(id, meta, this.options.execution);
    } catch (error) {
      this.#started = undefined;
      // A message held while it began is taken now.
      this.messagesChanged();
      throw error;
    }
    this.#launching = true;
    let launched: Promise<RunResult<JsonValue>>;
    try {
      launched = outsideTools(() => this.run({ ...run, id } as AgentRunStructuredSpec<JsonValue>));
    } catch (error) {
      launched = Promise.reject(error);
    } finally {
      this.#launching = false;
    }
    // Tracked until the end is in the mailbox, so the run doesn't park with a turn's end on its way.
    this.options.track(
      launched
        .then(
          ({ outcome }) => outcome,
          (error: unknown): TurnOutcome<JsonValue> => ({
            kind: "failed",
            reason: messageOf(error),
            retryable: false,
            usage: unrunUsage(this.key, id, this.options.execution),
          }),
        )
        .then(async (outcome) => {
          await turns.end(id, meta, outcome);
          written = outcome.kind;
        })
        // An end that can't be written leaves the turn set for good: the run can't go on.
        .catch((error: unknown) =>
          this.options.cleanupUnresolved(
            `agent ${this.key}'s turn ${id} ended, and its end was not written: ${messageOf(error)}`,
          ),
        )
        .finally(() => {
          started.ended = true;
          ended.resolve();
        }),
    );
    return started.ref;
  }

  #refusedWhileStarted(what: string): Error | undefined {
    // First: from a handler this agent is in, its turn waits for the handler, started or not.
    const inTool = refusedInTool(this.key, `${what}()`);
    if (inTool) return inTool;
    if (this.#started && !this.#launching)
      return new Error(
        `agent ${this.key} has a turn started (${this.#started.ref.id}) whose end no wait has taken; ${what}() waits for it`,
      );
  }

  is<Meta extends JsonValue = JsonValue, T extends JsonValue = JsonValue>(event: {
    readonly name: string;
    readonly from: string;
  }): event is AgentEndedEvent<Meta, T> & Matched {
    return event.name === "agent:ended" && event.from === this.key;
  }

  run(spec: AgentRunTextSpec): Promise<RunResult<string>>;
  run<T extends JsonValue>(spec: AgentRunStructuredSpec<T>): Promise<RunResult<T>>;
  run<T extends JsonValue>(
    spec: AgentRunTextSpec | AgentRunStructuredSpec<T>,
  ): Promise<RunResult<string | T>> {
    if (this.#closed) return Promise.reject(new Error("logical agent is closed"));
    const refused = this.#refusedWhileStarted("run");
    if (refused) return Promise.reject(refused);
    const scope = scopes.getStore();
    try {
      scope?.assertAccepting();
      this.options.checkOperation();
    } catch (error) {
      return Promise.reject(error);
    }
    const opensWindow = !inTimeoutHandler();
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
    let deadline: AbsoluteDeadline | undefined;
    try {
      deadline = this.operationDeadline(spec, scope);
      const recoveryDeadline = spec.nudge ? spec.nudge.deadline : undefined;
      if (recoveryDeadline) {
        assertDeadlineValue(recoveryDeadline);
        deadline = earlierDeadline(deadline, recoveryDeadline);
      }
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
      const cancelled = this.#cancelledTurns.get(id);
      if (cancelled !== undefined) {
        this.#cancelledTurns.delete(id);
        return {
          outcome: {
            kind: "cancelled",
            reason: cancelled,
            usage: unrunUsage(this.key, id, this.options.execution),
          },
        } as RunResult<JsonValue>;
      }
      const tags = tagsOf(scope, completeSpec.label);
      // Drawn here, so a turn that throws before it is delivered is still written as failed.
      const operation = this.operationLog(randomUUID(), "turn", tags);
      this.options.progress.turnStarted(this.key, tags);
      try {
        const settled = await this.executeOperation(completeSpec, scope, deadline, operation);
        this.turnEnded(settled.outcome, "turn", opensWindow);
        return settled;
      } catch (error) {
        operation.failed(error);
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
    const refused = this.#refusedWhileStarted("compact");
    if (refused) return Promise.reject(refused);
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
      deadline = harnessDeadline(this.operationDeadline(spec, scope));
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
      const operation = this.operationLog(randomUUID(), "compact", tags);
      this.options.progress.turnStarted(this.key, tags, "compact");
      try {
        const outcome = await this.executeCompaction(id, spec.prompt, deadline, scope, operation);
        this.turnEnded(outcome, "compact");
        return outcome;
      } catch (error) {
        operation.failed(error);
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
    const refused = this.#refusedWhileStarted("set");
    if (refused) return Promise.reject(refused);
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
      deadline = harnessDeadline(this.operationDeadline(spec, scope));
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
        const outcome = await this.executeSet(change, deadline, scope);
        this.#last = outcome.kind;
        return outcome;
      } finally {
        this.#pendingSets.splice(this.#pendingSets.indexOf(change), 1);
      }
    });
    const tracked = this.options.track(result);
    scope?.track(tracked);
    this.#sets.set(id, { spec: completeSpec, result: tracked });
    return tracked;
  }

  /**
   * An operation's start and failure in the run's event log, under the id its record keeps. Its
   * settling is the turn line `recordTurn` writes.
   */
  private operationLog(
    operationId: string,
    of: TurnRecord["kind"],
    tags: OperationTags,
  ): OperationLog {
    let deliveredAt: number | undefined;
    /** Named by its host before delivery, for its start to carry. */
    const named: string[] = [];
    const fields = () => {
      const { callPath, sessions, ...record } = this.options.ledger.unsettled(
        operationId,
        this.#execution,
        tags,
        deliveredAt,
      );
      const harness = this.#execution.harness;
      const fresh = named.filter((id) => !sessions.some((known) => known.id === id));
      return {
        of,
        callPath,
        ...record,
        sessions: [...sessions, ...fresh.map((id) => ({ harness, id }))],
      };
    };
    return {
      operationId,
      tags,
      delivered: (at: number) => {
        deliveredAt = at;
        this.#hasRun = true;
        this.#lastOperation = operationId;
        this.options.events.event({ kind: "operation-started", ...fields() }, at);
      },
      session: (id: string) => {
        if (deliveredAt === undefined) {
          named.push(id);
          return;
        }
        this.options.events.event({
          kind: "session-known",
          session: { harness: this.#execution.harness, id },
          operationId,
        });
      },
      failed: (error: unknown) =>
        this.options.events.event({
          kind: "operation-failed",
          ...fields(),
          error: messageOf(error),
        }),
    };
  }

  /** A turn or compaction that settled, as the view shows it and `turns.jsonl` keeps it. */
  private turnEnded(
    outcome: TurnOutcome<JsonValue>,
    kind: TurnRecord["kind"],
    opensWindow = false,
  ): void {
    // A failure has closed it by now, and a closed agent holds no window.
    if (opensWindow && !this.#closed) {
      this.#lastEnd = this.options.now();
      this.#timeoutOwed = true;
    }
    this.#last = outcome.kind;
    const reason = "reason" in outcome ? outcome.reason : undefined;
    this.options.progress.turnSettled(this.key, outcome.kind, reason);
    this.options.recordTurn(outcome, kind);
  }

  fork(spec: AgentForkSpec): Promise<AgentRef> {
    if (this.#closed) return Promise.reject(new Error("logical agent is closed"));
    const refused = this.#refusedWhileStarted("fork");
    if (refused) return Promise.reject(refused);
    const scope = scopes.getStore();
    const deadline = this.deadlineCeiling(scope);
    const { session, execution } = this.options;
    const settings = this.queuedExecution();
    const fork = session.fork?.bind(session);
    if (!fork) {
      try {
        return this.options.fork(
          spec,
          execution.caller
            ? `agent ${this.key} is the calling session, which this run cannot fork; forkCaller answers null and the run's output says why`
            : `agent ${this.key} cannot be forked: ${execution.harness} ${placementOf(execution)} agents have no fork yet`,
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
        const after = this.#lastOperation ?? null;
        return { native: await fork(deadlineWithin(FORK_TIMEOUT_MS, deadline), into), after };
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
  ): AbsoluteDeadline | undefined {
    if (spec.deadline && spec.timeoutMs !== undefined) {
      throw new Error("an operation cannot specify both deadline and timeoutMs");
    }
    const ceiling = this.deadlineCeiling(scope);
    if (spec.timeoutMs !== undefined) return deadlineWithin(spec.timeoutMs, ceiling);
    if (!spec.deadline) return ceiling;
    assertDeadlineValue(spec.deadline);
    return earlierDeadline(spec.deadline, ceiling);
  }

  /** The deadlines around an operation: its scope's and the run's, if either has one. */
  private deadlineCeiling(scope: ExecutionScope | undefined): AbsoluteDeadline | undefined {
    return earlierDeadline(scope?.deadline, this.options.deadline);
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
      ? scope?.add(async (stop) => {
          cancelled = stop.reason;
          this.#last = "cancelled";
          await this.close(stop.reason);
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
      if (pane) {
        this.closeAfterFailure(
          reason,
          cancelled !== undefined ? "cancelled" : expired ? "timed-out" : "failed",
        );
      }
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
  private closeAfterFailure(reason: string, ended: TurnOutcome<never>["kind"] = "failed"): void {
    if (this.options.execution.caller) return;
    // Before its outcome is recorded: whether its pane stays turns on how this one ended.
    this.#last = ended;
    void this.close(reason).catch(() => undefined);
  }

  close(reason?: string): Promise<void> {
    const first = !this.#closed;
    this.#closed = true;
    if (first) {
      this.#closedReason = reason ?? "closed";
      // Its routes close, what it asked is dropped and what it owed fails, before the operation it
      // is running ends, so an answer it asked back on still reaches its asker.
      this.options.messaging.agentStopped(this.key, this.#closedReason);
    }
    // An operation still going is cancelled by this close.
    const keep = keepsPane(
      this.options.keepPane(),
      this.#operationStops.size > 0 ? "cancelled" : this.#last,
    );
    const stopped = this.stopOperations({ kind: "cancelled", reason: reason ?? "agent closed" });
    if (!this.#closePromise) {
      let attempt: Promise<void>;
      try {
        attempt = Promise.resolve(
          this.options.session.close(reason, keep ? { keep: true } : undefined),
        ).then(() => (keep ? this.options.revoke() : undefined));
      } catch (error) {
        attempt = Promise.reject(error);
      }
      this.#closePromise = attempt;
      void attempt.catch(() => {
        if (this.#closePromise === attempt) this.#closePromise = undefined;
      });
    }
    const closed = Promise.all([this.#closePromise, stopped]).then(() => undefined);
    // Once what it was running has ended, so its last operation's line comes first.
    if (first) {
      const { key, execution } = this.options;
      const stoppedLine = () =>
        this.options.events.event({
          kind: "agent-stopped",
          agent: key,
          callPath: [],
          harness: execution.harness,
        });
      closed.then(stoppedLine, stoppedLine);
    }
    return closed;
  }

  /**
   * The standard recovery, except for a calling session whose harness's interrupt cannot be told
   * from a turn that ended without answering: nudging it could be prompting an operator who just
   * stopped it (ADR 0010).
   */
  async stopOperations(request: OperationStop): Promise<void> {
    // Before they settle, which records it later than a close that follows reads it.
    if (this.#operationStops.size > 0 || this.#pendingSets.length > 0) this.#last = request.kind;
    await Promise.all([...this.#operationStops].map((stop) => stop(request)));
  }

  private defaultNudge(): Exclude<AgentRunTextSpec["nudge"], false> {
    const { execution } = this.options;
    return execution.caller && !findHarness(execution.harness)?.interrupted ? undefined : {};
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    this.#queued += 1;
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    void this.#tail.then(() => {
      this.#queued -= 1;
      // With nothing queued, a message held meanwhile opens the next operation.
      if (this.#queued === 0) this.messagesChanged();
    });
    return result;
  }

  private async executeOperation(
    spec: AgentRunTextSpec | AgentRunStructuredSpec<JsonValue>,
    scope: ExecutionScope | undefined,
    operationDeadline: AbsoluteDeadline | undefined,
    operation: OperationLog,
  ): Promise<RunResult<JsonValue>> {
    const nudge = spec.nudge === false ? undefined : (spec.nudge ?? this.defaultNudge());
    scope?.assertActive();
    if (nudge?.deadline) assertDeadlineValue(nudge.deadline);
    return this.executeWaitingOperation(spec, scope, operationDeadline, operation, nudge);
  }

  private async executeWaitingOperation(
    spec: AgentRunTextSpec | AgentRunStructuredSpec<JsonValue>,
    scope: ExecutionScope | undefined,
    initial: AbsoluteDeadline | undefined,
    { operationId, tags, delivered, session }: OperationLog,
    nudge: Exclude<AgentRunTextSpec["nudge"], false>,
  ): Promise<RunResult<JsonValue>> {
    const schema = resultSchema(spec.schema);
    const binding = { endpoint: this.options.endpoint, operationId };
    const entry = this.options.ledger.reserve(operationId, () => this.#execution, tags);
    const { messaging } = this.options;
    // Moves out by any wait on an outside participant, within the deadlines around it.
    let deadline = initial;
    const ceiling = this.deadlineCeiling(scope);
    messaging.opened({
      id: operationId,
      agent: this.key,
      kind: "workflow",
      ...(deadline ? { deadline: deadline.unixMilliseconds } : {}),
      ...(ceiling ? { ceiling: ceiling.unixMilliseconds } : {}),
      scope: scope?.messages ?? messaging.attempt,
    });
    this.options.tools.opened({
      id: operationId,
      agent: this.key,
      callPath: [],
      ...(scope?.stage === undefined ? {} : { stage: scope.stage }),
      scope,
      deadline: () => deadline?.unixMilliseconds,
    });
    // After its prompt: how to use its routes, then each message held for it, wrapped.
    const joined = messaging.take(operationId, "joins");
    const prompt = [spec.prompt, messaging.lesson(this.key), joined?.text]
      .filter(Boolean)
      .join("\n\n");
    const authored: AuthoredTurn = {
      prompt: spec.prompt,
      ...(spec.label === undefined ? {} : { label: spec.label }),
      ...(tags.stage === undefined ? {} : { stage: tags.stage }),
      ...(spec.schema ? { schema: spec.schema } : {}),
      ...(joined ? { messages: joined.messages } : {}),
    };
    const waitingSupported = this.options.session.supportsWaiting === true;
    const recoveryPrompt =
      nudge?.prompt ??
      (waitingSupported
        ? "Report the result now, or use wf waiting with a reason if you still need time."
        : "You finished without reporting the requested result. Report it now.");
    // The first prompt carries only the result command; waiting is rare, so it is offered only
    // once a check-in finds the agent idle without an answer.
    const checkInPrompt = (text: string) =>
      operationPrompt(text, schema, this.options.launcher, operationId) +
      (waitingSupported
        ? [
            "",
            "Finish or stop work needed for this answer before submitting the result.",
            `If waiting for work to finish, report it now using: ${this.options.launcher} waiting ${operationId} --reason 'what you are waiting for' [--timeout 2m]`,
            "Omit the square brackets when running the optional timeout flag. This command acknowledges your wait immediately; it does not sleep.",
            ...(deadline
              ? [
                  `The answer deadline is ${new Date(deadline.unixMilliseconds).toISOString()}. ${this.options.launcher} waiting never extends it.`,
                ]
              : []),
          ].join("\n")
        : "");
    const events = createOperationEvents(this.options.runDir, operationId);
    const messages = this.operationMessages(operationId, `${spec.id!}:message`, {
      deadline: () => harnessDeadline(deadline),
      authored,
      session,
      record: events.record,
    });
    const outcome = await superviseOperation({
      messages,
      event: events.record,
      operationId,
      agentId: this.key,
      question: spec.prompt,
      schema,
      ...(deadline ? { deadline } : {}),
      ...(ceiling ? { ceiling: ceiling.unixMilliseconds } : {}),
      extended: (moved, waiting) => {
        const next = moved === undefined ? undefined : { unixMilliseconds: moved };
        this.options.slots.extend(operationId, next);
        if (waiting || moved === undefined || moved <= (deadline?.unixMilliseconds ?? Infinity))
          return;
        deadline = next;
        messaging.extended(operationId, moved);
        events.record({ kind: "deadline-extended", at: Date.now(), sequence: 0, until: moved });
      },
      slots: this.options.slots,
      waitingSupported,
      nudge: nudge !== undefined,
      policy: this.options.livenessPolicy,
      start: () =>
        this.options.session
          .start(
            {
              id: spec.id!,
              prompt: [
                operationPrompt(prompt, schema, this.options.launcher, operationId),
                toolsLesson(
                  this.options.tools.taught(this.key),
                  this.options.launcher,
                  simpleInput(schema) !== undefined,
                ),
              ]
                .filter(Boolean)
                .join("\n\n"),
              deadline: harnessDeadline(deadline),
              authored,
              onSession: session,
            },
            binding,
          )
          .then((turn) => this.confirmed(operationId, joined?.numbers ?? [], turn)),
      successor: (turn, sequence, deliverySignal) =>
        turn.nudge({
          id: `${spec.id!}:check-in:${sequence}`,
          deadline: harnessDeadline(deadline),
          deliverySignal,
          prompt: checkInPrompt(recoveryPrompt),
          // A check-in delivers no messages: those its first prompt carried are not its own.
          authored: { ...withoutMessages(authored), prompt: recoveryPrompt },
        }),
      onStop: (settle) => {
        // A cancel or stop reaches a running tool call at once: the turn may be waiting on it.
        const stop = (request: OperationStop) => {
          this.options.tools.abort(operationId, request.kind);
          return settle(request);
        };
        this.#operationStops.add(stop);
        this.#stopsByTurn.set(spec.id!, stop);
        const remove = scope?.add(stop);
        return () => {
          this.#operationStops.delete(stop);
          if (this.#stopsByTurn.get(spec.id!) === stop) this.#stopsByTurn.delete(spec.id!);
          remove?.();
        };
      },
      phase: (phase, reason, until) =>
        this.options.progress.turnPhase(this.key, phase, reason, until),
      delivered,
    })
      .catch(
        (error: unknown): SupervisedOutcome => ({
          kind: "failed",
          reason: messageOf(error),
          cleanupUnresolved: true,
          charges: [],
          settledAt: Date.now(),
        }),
      )
      .finally(() => events.close());
    // A call still running is stopped and waited for: run() resolves once its calls have settled.
    await this.options.tools.ended(operationId);
    // Its wait is dropped and what it still owed fails, before a failure closes the agent.
    messaging.ended(operationId, operationEnd(outcome.kind));
    if (outcome.cleanupUnresolved) {
      this.options.cleanupUnresolved(`cleanup-unresolved: ${this.key} operation ${operationId}`);
      this.closeAfterFailure("cleanup-unresolved");
    }
    if (outcome.kind === "timed-out" || outcome.kind === "failed")
      this.closeAfterFailure(outcome.reason, outcome.kind);
    const usage = entry.settle(
      {
        ...(outcome.deliveredAt === undefined ? {} : { deliveredAt: outcome.deliveredAt }),
        settledAt: outcome.settledAt,
      },
      outcome.charges,
    );
    if (outcome.kind === "answered")
      return { outcome: { kind: "answered", value: outcome.value as JsonValue, usage } };
    if (outcome.kind === "failed") {
      const login = outcome.login ? { login: outcome.login } : {};
      return {
        outcome: { kind: "failed", reason: outcome.reason, retryable: false, ...login, usage },
      };
    }
    return { outcome: { kind: outcome.kind, reason: outcome.reason, usage } };
  }

  /**
   * What an operation's supervisor asks of its messages: what is held, what it awaits, where its
   * turn's end goes, and the turn that carries a delivery or the reminder.
   */
  private operationMessages(
    operationId: string,
    turnIds: string,
    turn: {
      deadline: () => AbsoluteDeadline;
      authored: AuthoredTurn;
      session: (id: string) => void;
      record: (event: LivenessEvent) => void;
      /** A message operation's deadline moved later, for the askers it now answers. */
      extended?: (deadline: number) => void;
    },
  ): OperationMessages {
    const { messaging } = this.options;
    return {
      pending: () => messaging.pending(operationId),
      awaiting: () => messaging.awaiting(operationId),
      turnEnded: () => messaging.turnEnded(operationId),
      reminderExpired: () => messaging.reminderExpired(operationId),
      continueWith: async (previous, sequence, signal, reminder) => {
        const delivery =
          reminder === undefined ? messaging.take(operationId, "continues") : undefined;
        if (reminder === undefined && !delivery) {
          throw new Error("nothing was held to continue the operation with");
        }
        if (delivery?.deadline !== undefined) turn.extended?.(delivery.deadline);
        const prompt = reminder ?? delivery!.text;
        const messages = delivery?.messages ?? [];
        if (reminder === undefined) {
          turn.record({
            kind: "continued",
            at: Date.now(),
            sequence,
            reason: continuedBy(messages),
          });
        }
        const next = await previous.deliver({
          id: `${turnIds}:${sequence}`,
          prompt,
          deadline: turn.deadline(),
          deliverySignal: signal,
          authored: {
            ...withoutMessages(turn.authored),
            prompt,
            ...(messages.length ? { messages } : {}),
          },
          onSession: turn.session,
        });
        return this.confirmed(operationId, delivery?.numbers ?? [], next);
      },
      onChange: (wake) => {
        this.#watchers.add(wake);
        return () => this.#watchers.delete(wake);
      },
    };
  }

  /**
   * What the harness confirms of a delivery: received, or a session record showing the prompt, is
   * `observed`; a failure, or no evidence by the turn's end, `unconfirmed`.
   */
  private confirmed(
    operationId: string,
    numbers: readonly number[],
    turn: HarnessTurn,
  ): HarnessTurn {
    if (numbers.length === 0) return turn;
    const { messaging } = this.options;
    let said = false;
    const say = (state: "observed" | "unconfirmed") => {
      if (said) return;
      said = true;
      messaging.confirmed(operationId, numbers, state);
    };
    if (turn.delivery) {
      const { received, failed } = turn.delivery;
      void received.then(() => say("observed"));
      void failed.then(() => say("unconfirmed"));
      // A receipt read from the session's file may come just after the turn has ended.
      void turn.settled.then(() =>
        Promise.race([
          received,
          failed,
          new Promise((resolve) => setTimeout(resolve, RECEIPT_GRACE_MS).unref()),
        ]).then(() => say("unconfirmed")),
      );
      return turn;
    }
    // Headless, the resumed session's own record is the evidence, read as the turn ends.
    void turn.settled.then((outcome) => say(outcome.observed ? "observed" : "unconfirmed"));
    return turn;
  }

  /**
   * Wakes this idle agent in a message operation: its route's stage owns it, or the attempt outside
   * any stage. Queued as any operation is, so nothing else runs beside it.
   */
  private startMessageOperation(scope: MessagingScope): void {
    const owner = this.options.messageOwner(scope);
    if (!owner) return;
    // Whatever code made the message due, a handler included, nothing waits for its operation.
    const result = outsideTools(() =>
      this.queue(async () => {
        if (this.#closed || this.options.isRunClosing()) return;
        // What is first now: a message dropped since this was queued leaves another route's, which
        // waits for an operation of its own scope.
        const opening = this.options.messaging.opening(this.key);
        if (opening?.scope !== scope) return;
        await this.executeMessageOperation(opening.from, scope, owner.stage);
      }),
    );
    this.options.track(result).catch(() => undefined);
    owner.adopt(result);
  }

  private async executeMessageOperation(
    from: AgentKey,
    scope: MessagingScope,
    stage: ExecutionScope | undefined,
  ): Promise<void> {
    const { messaging } = this.options;
    const operationId = randomUUID();
    const ceiling = this.deadlineCeiling(stage)?.unixMilliseconds;
    let deadline = Math.min(Date.now() + messaging.limits.operationMs, ceiling ?? Infinity);
    messaging.opened({
      id: operationId,
      agent: this.key,
      kind: "message",
      deadline,
      ceiling,
      scope,
    });
    this.options.tools.opened({
      id: operationId,
      agent: this.key,
      callPath: [],
      ...(stage?.stage === undefined ? {} : { stage: stage.stage }),
      scope: stage,
      deadline: () => deadline,
    });
    /** How it ended; unset until its supervisor says, or if it never opened. */
    let end: SupervisedOutcome["kind"] | undefined;
    try {
      const opening = messaging.take(operationId, "opens");
      // Withdrawn before it could be shown: nothing to wake it for.
      if (!opening) return;
      if (opening.deadline !== undefined) deadline = opening.deadline;
      const cause = { message: { from } };
      const tags: OperationTags = {
        ...(stage?.stage === undefined ? {} : { stage: stage.stage }),
        cause,
      };
      const operation = this.operationLog(operationId, "turn", tags);
      this.options.progress.turnStarted(this.key, tags);
      try {
        const outcome = await this.superviseMessage(operationId, deadline, opening, {
          cause,
          tags,
          stage,
          operation,
        });
        end = outcome.kind;
        if (outcome.kind === "timed-out" || outcome.kind === "failed") {
          throw new Error(
            `agent ${this.key}'s message operation ${outcome.kind}: ${outcome.reason}`,
          );
        }
      } catch (error) {
        if (end === undefined) {
          end = "failed";
          operation.failed(error);
          this.options.progress.turnSettled(this.key, "failed", messageOf(error));
        }
        throw error;
      } finally {
        // Its agent ended its turn with a call running, say: the call is stopped and waited for, so
        // nothing after it, nor the next operation, runs with this one's call still running.
        await this.options.tools.ended(operationId);
        await this.options.afterOperation?.();
      }
    } finally {
      await this.options.tools.ended(operationId);
      // A message operation that simply ends settles; its wait is dropped and what it owed fails.
      messaging.ended(
        operationId,
        end === undefined ? "cancelled" : end === "answered" ? "settled" : operationEnd(end),
      );
    }
  }

  /** Supervises a message operation's turns, records its turn and usage, and says how it ended. */
  private async superviseMessage(
    operationId: string,
    initial: number,
    opening: Delivery,
    context: {
      cause: { message: { from: AgentKey } };
      tags: OperationTags;
      stage: ExecutionScope | undefined;
      operation: OperationLog;
    },
  ): Promise<SupervisedOutcome> {
    const { messaging } = this.options;
    const { cause, tags, stage, operation } = context;
    let deadline = initial;
    const entry = this.options.ledger.reserve(operationId, () => this.#execution, tags);
    const events = createOperationEvents(this.options.runDir, operationId);
    const authored: AuthoredTurn = {
      prompt: opening.text,
      ...(tags.stage === undefined ? {} : { stage: tags.stage }),
      cause,
      messages: opening.messages,
    };
    const extended = (later: number) => {
      if (later <= deadline) return;
      deadline = later;
      messaging.extended(operationId, later);
      this.options.tools.extended(operationId, later);
      events.record({ kind: "deadline-extended", at: Date.now(), sequence: 0, until: later });
    };
    const ceiling = this.deadlineCeiling(stage)?.unixMilliseconds;
    let outcome: SupervisedOutcome;
    try {
      outcome = await superviseMessageOperation({
        deadline: () => deadline,
        ...(ceiling === undefined ? {} : { ceiling }),
        extended,
        start: () =>
          this.options.session
            .start(
              {
                id: operationId,
                // A message turn's tools block, as a workflow turn's: after what it opens on.
                prompt: [
                  opening.text,
                  toolsLesson(this.options.tools.taught(this.key), this.options.launcher, false),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                deadline: { unixMilliseconds: deadline },
                authored,
                onSession: operation.session,
              },
              { endpoint: this.options.endpoint, operationId },
            )
            .then((turn) => this.confirmed(operationId, opening.numbers, turn)),
        messages: this.operationMessages(operationId, `${operationId}:message`, {
          deadline: () => ({ unixMilliseconds: deadline }),
          authored,
          session: operation.session,
          record: events.record,
          extended,
        }),
        onStop: (settle) => {
          const stop = (request: OperationStop) => {
            this.options.tools.abort(operationId, request.kind);
            return settle(request);
          };
          this.#operationStops.add(stop);
          const remove = stage?.add(stop);
          return () => {
            this.#operationStops.delete(stop);
            remove?.();
          };
        },
        event: events.record,
        phase: (phase, reason, until) =>
          this.options.progress.turnPhase(this.key, phase, reason, until),
        delivered: operation.delivered,
        ...(this.options.livenessPolicy ? { policy: this.options.livenessPolicy } : {}),
      });
    } finally {
      await events.close();
    }
    if (outcome.cleanupUnresolved) {
      this.options.cleanupUnresolved(`cleanup-unresolved: ${this.key} operation ${operationId}`);
    }
    // A timeout or a harness failure stops the agent, as any operation's does (Q10).
    if (outcome.kind === "timed-out" || outcome.kind === "failed")
      this.closeAfterFailure(outcome.reason, outcome.kind);
    const usage = entry.settle(
      {
        ...(outcome.deliveredAt === undefined ? {} : { deliveredAt: outcome.deliveredAt }),
        settledAt: outcome.settledAt,
      },
      outcome.charges,
    );
    // Recorded `answered` with no value: it did what it was woken for, and takes no result.
    this.turnEnded(
      outcome.kind === "answered"
        ? { kind: "answered", value: null, usage }
        : outcome.kind === "failed"
          ? { kind: "failed", reason: outcome.reason, retryable: false, usage }
          : { kind: outcome.kind, reason: outcome.reason, usage },
      "turn",
      true,
    );
    return outcome;
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
    { operationId, tags, delivered }: OperationLog,
  ): Promise<TurnOutcome<string>> {
    const entry = this.options.ledger.reserve(operationId, () => this.#execution, tags);
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
      return reconcile<string>(native, usage);
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
    delivered(times.deliveredAt);
    const removeCanceller = scope?.add((stop) => releaseTurn(turn, stop.reason));
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

  private abandonTurnAcquisition(acquiring: Promise<HarnessTurn>, reason: string): void {
    const lateRelease = acquiring.then(
      (turn) => releaseTurn(turn, reason),
      () => undefined,
    );
    this.options.track(lateRelease);
    this.closeAfterFailure(reason);
  }
}

/** A sleep's time, checked where it is given. */
function checkedWhen(when: unknown): string | Date {
  if (when instanceof Date || typeof when === "string") return when;
  throw new Error('sleep is for a duration, "2h", or until a Date');
}

function checkedLabel(label: unknown): string | undefined {
  if (label !== undefined && typeof label !== "string")
    throw new Error("a wait's label is a string");
  return label;
}

/** A wait's branches, by name, checked: a race may give a duration where a select may not. */
function branchesOf(what: string, branches: unknown, durations: boolean): [string, unknown][] {
  if (typeof branches !== "object" || branches === null || Array.isArray(branches))
    throw new Error(`${what} takes its branches as an object, { name: source }`);
  const entries = Object.entries(branches);
  if (entries.length === 0) throw new Error(`${what} has no branches: it would never return`);
  if ("key" in branches) throw new Error(`${what}: no branch is named key, which the answer uses`);
  for (const [branch, source] of entries)
    if (typeof source === "string" && !durations)
      throw new Error(`${what}'s ${branch} is a duration: a timer in a loop is workflow.timer()'s`);
  return entries;
}

/** What `source` takes, as a branch gives it. */
function sourceTake(what: string, branch: string, source: unknown): WaitTake {
  const take = takeOf(source);
  if (take) return take;
  throw new Error(
    `${what}'s ${branch} is not a source: a timer, a signal, a participant routed to the code, an agent, or a started turn`,
  );
}

/** One of the workflow's own events, by name, as a source. */
function signalSource(name: string): unknown {
  if (typeof name !== "string" || name.includes(":"))
    throw new Error(`a signal is one of the workflow's own events, by name; not ${String(name)}`);
  return source({ name }, { name });
}

/** Timer `name`'s source. */
function timerSource(mailbox: RunMailbox, name: string, due: string): Timer {
  return source(
    { name, due, cancel: () => mailbox.cancelTimer(name) },
    { name: "timer:due", from: name },
  ) as unknown as Timer;
}

/** A started turn, as the code holds it: its id, its cancel, and a source of its end. */
function turnRef(
  agent: string,
  id: string,
  cancel: (reason?: string) => Promise<boolean>,
): StartedTurn {
  return source(
    { id, cancel },
    { name: "agent:ended", from: agent, turn: id },
  ) as unknown as StartedTurn;
}

class ExecutionScope {
  readonly #cancellers = new Set<(stop: OperationStop) => Promise<unknown>>();
  readonly #owned = new Set<Promise<unknown>>();
  #cancelled = false;
  #stop: OperationStop | undefined;
  #sealed = false;
  #cancellation: Promise<void> | undefined;

  constructor(
    readonly deadline: AbsoluteDeadline | undefined,
    /** The labelled `parallel` it runs in, for progress. */
    readonly group?: GroupProgress,
    /** The workflow stage everything in this scope runs in. */
    readonly stage?: string,
    /** The stage's messaging scope, where routes granted in it live and close. */
    readonly messages?: MessagingScope,
  ) {}

  get cancelled(): boolean {
    return this.#cancelled;
  }

  assertActive(): void {
    if (this.#cancelled || (this.deadline && Date.now() >= this.deadline.unixMilliseconds)) {
      throw new DeadlineExceededError(this.deadline ?? { unixMilliseconds: Date.now() });
    }
  }

  assertAccepting(): void {
    this.assertActive();
    if (this.#sealed) throw new Error("parallel execution scope is closed");
  }

  add(cancel: (stop: OperationStop) => Promise<unknown>): () => void {
    if (this.#cancelled) {
      try {
        void cancel(this.#stop!).catch(() => undefined);
      } catch {
        // Late registration keeps the stop fence synchronous, including a throwing canceller.
      }
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

  /**
   * Owns a message operation one of the stage's routes opened, even once the stage's function has
   * returned: a message held before then can open one after.
   */
  adopt(promise: Promise<unknown>): void {
    this.#owned.add(promise);
    promise.catch(() => undefined);
  }

  /** Until everything it owns has settled, what was adopted meanwhile included. */
  async settleOwned(): Promise<void> {
    let seen = 0;
    while (this.#owned.size > seen) {
      seen = this.#owned.size;
      const settled = await Promise.allSettled([...this.#owned]);
      const rejected = settled.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    }
  }

  seal(): void {
    this.#sealed = true;
  }

  cancel(
    stop: OperationStop = { kind: "cancelled", reason: "parallel execution cancelled" },
  ): Promise<void> {
    if (this.#cancellation) return this.#cancellation;
    this.#cancelled = true;
    this.#stop = stop;
    this.#cancellation = Promise.allSettled(
      [...this.#cancellers].map((cancel) => Promise.resolve().then(() => cancel(stop))),
    ).then(() => undefined);
    return this.#cancellation;
  }
}

function runParallel<Item, Result>(
  items: readonly Item[],
  operation: (item: Item, index: number) => Promise<Result>,
  deadline: AbsoluteDeadline | undefined,
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
  deadline: AbsoluteDeadline | undefined,
  concurrency: number,
  parent: ExecutionScope | undefined,
  group?: GroupProgress,
): Promise<Result[]> {
  // An unlabelled parallel inside a labelled one stays part of it.
  const scope = new ExecutionScope(
    deadline,
    group ?? parent?.group,
    parent?.stage,
    parent?.messages,
  );
  const removeFromParent = parent?.add((stop) => scope.cancel(stop));
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
    if (!deadline) return;
    cancelTimer = scheduleAt(deadline, () => {
      void scope
        .cancel({ kind: "timed-out", reason: "parallel deadline exceeded" })
        .then(() => reject(new DeadlineExceededError(deadline)));
    });
  });
  try {
    await Promise.race([completion, expiry]);
    if (scope.cancelled || (deadline && Date.now() >= deadline.unixMilliseconds)) {
      await scope.cancel({ kind: "timed-out", reason: "parallel deadline exceeded" });
      throw new DeadlineExceededError(deadline ?? { unixMilliseconds: Date.now() });
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

/**
 * Compaction keeps its existing bounded release behavior. Structured operations use the
 * supervisor, which requires confirmed native completion before returning an answer.
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

function reconcile<T extends JsonValue>(
  native: HarnessTurnOutcome,
  usage: OperationRecord,
): TurnOutcome<T> {
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
  log: Warn | undefined,
): string | undefined {
  if (!options?.summary || value === undefined) return undefined;
  try {
    return String(options.summary(value));
  } catch (error) {
    log?.(`awf: stage ${name}'s summary failed: ${messageOf(error)}`, undefined, name);
    return undefined;
  }
}

type Warn = (message: string, fields?: JsonObject, stage?: string) => void;

/** An operation's start and failure, written under the id its record keeps. */
type OperationLog = {
  operationId: string;
  tags: OperationTags;
  delivered(at: number): void;
  /** A session its host named while it ran: on its start if that is still to come. */
  session(id: string): void;
  failed(error: unknown): void;
};

/** A native fork, and the parent's operation it was copied after: null when it ran none. */
type TakenFork = { native: NativeFork; after: string | null };

/** A settled turn or compaction, kept in the run's `turns.jsonl`. */
type RecordTurn = (outcome: TurnOutcome<JsonValue>, kind: TurnRecord["kind"]) => void;

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  ) as Pick<T, K>;
}

/** How an operation's end reads to messaging: a result, or a turn that simply ended, or worse. */
function operationEnd(kind: SupervisedOutcome["kind"]): OperationEnd {
  switch (kind) {
    case "answered":
      return "result";
    case "unanswered":
    case "blocked":
      return "settled";
    default:
      return kind;
  }
}

/** A turn as the workflow wrote it, without the messages an earlier turn of it delivered. */
function withoutMessages(authored: AuthoredTurn): AuthoredTurn {
  const { messages: _messages, ...rest } = authored;
  return rest;
}

/** What continued an operation, as its liveness record says. */
function continuedBy(messages: readonly AuthoredMessage[]): string {
  if (messages.some((each) => each.kind === "no-reply")) return "no-reply";
  if (messages.some((each) => each.kind === "message" && each.answers)) return "reply";
  if (messages.some((each) => each.kind === "message" && each.asks)) return "request";
  return "messages";
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
  // (E5). `wf` says what to do about a rejection, so the prompt does not. A simple schema is taught
  // as flags instead, its usage line carrying every bound, which held them as well (story 035, M1).
  const simple = simpleInput(schema);
  if (simple) {
    return [
      prompt,
      "",
      "When the answer is ready, return it by running:",
      "",
      `${launcher} result ${callId} ${usageLine(simple)}`,
      "",
      QUOTING_RULE,
    ].join("\n");
  }
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
  for (const field of ["instructions", "labels", "layout", "keepPane"] as const) {
    if (spec[field] !== undefined && !isDeepStrictEqual(existing[field], requested[field])) {
      conflict(key, field);
    }
  }
}

function paneOptions({
  layout,
  keepPane,
}: AgentIdentity): Pick<HarnessActivation, "layout" | "keepPane"> {
  return {
    ...(layout === undefined ? {} : { layout }),
    ...(keepPane === undefined ? {} : { keepPane }),
  };
}

function conflict(key: string, field: string): never {
  throw new Error(`agent ${key} is already open with different ${field}`);
}

function stoppedError(key: string, reason: string): Error {
  return new Error(`agent ${key} was stopped (${reason}); its key is not opened again`);
}

function unavailable(name: string): Promise<never> {
  return Promise.reject(new Error(`${name} is not implemented by the minimum workflow runner`));
}

/**
 * Each root agent's last native session in a run's turns, where its harness can resume it: what a
 * event run's continue reopens it on.
 */
export function keptSessionsOf(turns: readonly TurnRecord[]): Map<string, NativeFork> {
  const kept = new Map<string, NativeFork>();
  for (const turn of turns) {
    if ((turn.callPath?.length ?? 0) > 0) continue;
    const session = turn.sessions.at(-1);
    if (session) kept.set(turn.agent, { harness: session.harness, sessionRef: session.id });
  }
  return kept;
}

/**
 * In a run of a workflow with `events`: how an agent records a turn `start()` begins and its end,
 * and the turn an earlier attempt started whose end no wait took, which `turn` is from the start.
 */
type LogicalAgentTurns = {
  begin(turn: TurnId, meta: JsonValue, execution: AgentExecution): Promise<void>;
  end(turn: TurnId, meta: JsonValue, outcome: TurnOutcome<JsonValue>): Promise<void>;
  restored(): RestoredTurn | undefined;
};
