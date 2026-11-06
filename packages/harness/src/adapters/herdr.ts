import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { type PaneHerdr, type PaneTerminal, shellQuote } from "@agentswf/sandbox";
import type {
  AgentRunHostFactory,
  AgentSessionAdapter,
  NativeFork,
  PanePlacement,
  SessionCopy,
  SessionSettings,
} from "../adapter";
import { skillsLaunch } from "../capabilities/skills";
import { type RunProcess, runProcess, withholding } from "../command";
import { failedOnLogin, thisTurn } from "../harnesses/login";
import { launchSettings } from "../harnesses/shared";
import { parseRow, record } from "../json";
import { launchArgs } from "../sandbox-needs";
import { readable } from "../screen";
import {
  type ActivatedSessionBackend,
  activeOperation,
  createSessionAdapter,
  deadlineExceeded,
  instructOnce,
  localOutcome,
  type NativeTurnOutcome,
  reasonOf,
} from "../session-core";
import { createSingleSessionHostFactory } from "../single-session-host";
import {
  findHarness,
  HARNESS_NAMES,
  harnessSpec,
  knownHarness,
  PLACEMENT_HARNESSES,
} from "../spec";
import { harnessState } from "../state";
import { prepareTurnRecord, watchSessionEnd } from "../turns/record";
import type { Harness } from "../types";
import { createSessionAccounting } from "../usage/accounting";
import {
  FORK_ACTIVATION_MS,
  forkDeadline,
  forkOrCopy,
  refuseSandboxedFork,
  runForkPlan,
} from "./fork";
import {
  createPaneLayout,
  createPaneScreen,
  type MadePane,
  type PaneLayoutHost,
  type PaneRequest,
  type PaneScreen,
  type PlacedPane,
} from "./herdr-layout";
import {
  abortableDelay,
  blockedBy,
  emptyEnvironmentArgs,
  HERDR_REPORT_GRACE_MS,
  type HerdrCommand,
  type HerdrResult,
  hasHerdrErrorCode,
  herdrFailure,
  observeRelease,
  paneCancelled,
  readId,
  readPaneId,
  readSessionRef,
  releaseDeadlineExceeded,
  releasedOutcome,
  reportedAgent,
  safeAgentName,
  settleAgent,
  settledOutcome,
  submitPrompt,
  waitForTurnEnd,
  waitOutStalledPrompt,
} from "./herdr-protocol";
import { answerStartupBlocks } from "./herdr-startup";

export type HerdrConfig = {
  /** The Herdr session agents open in; `awf run` picks the one it runs in. */
  session: string;
  /** Names the workspace each operation of a pane adapter opens; a run's is named by the run. */
  workspaceLabel: string;
  commandTimeoutMs: number;
  /** Names forced to an empty value in every workspace. Values never cross the Herdr argv. */
  emptyEnvironment?: readonly string[];
  /** `agent start` refuses a pane that has not reached its shell prompt, so it is retried. */
  startAttempts?: number;
  startRetryMs?: number;
  /** Answer the known startup blocks — trust gates included — for a workspace the caller vetted. */
  acceptWorkspaceTrust?: boolean;
  /** How long an agent is left alone after each startup block; see `answerStartupBlocks`. */
  trustSettleMs?: number;
  /** How long a pane's turn is waited on and looked at, shortened by tests; see `PANE_TIMINGS`. */
  timings?: Partial<PaneTimings>;
  /**
   * At a sandbox's first TUI agent, open a tab in the run's workspace attached to the sandbox's
   * own Herdr, so its panes show beside the run's.
   */
  watchSandboxes?: boolean;
  /**
   * Told the run's workspace id once it exists, before any agent opens in it, so an engine can
   * tell its workspace from another of the same label.
   */
  onRunWorkspace?: (workspaceId: string) => Promise<void>;
  /** The workspace `awf run` was typed in, and its session; why not, where it can't be used. */
  origin?: () => Promise<{ session: string; workspaceId: string } | string | undefined>;
  /** Held while a named workspace is looked for and made, so two runs make one. */
  lockWorkspace?: (session: string, name: string) => Promise<() => Promise<void>>;
  /** Told every pane the run has made in a session and not closed, kept ones marked. */
  onPanes?: (session: string, panes: readonly MadePane[]) => void;
};

const AGENT_START_WAIT_MS = 120_000;
/**
 * How long an interrupted harness may take to settle before its pane is closed, not kept (M1): well
 * inside the engine's grace for closing a run.
 */
const KEEP_SETTLE_MS = 3_000;
/** How long a pane's turn is waited on and looked at. */
type PaneTimings = {
  /** How often a prompt its harness's record has not taken in is looked at, past `untakenMs`. */
  turnPollMs: number;
  /**
   * How long a prompt may go untaken by its harness's record before its screen is read: for a
   * login it lacks, or a claude that dropped the Enter after the paste.
   */
  untakenMs: number;
  /** How long after Herdr shows a dialog it is looked for again: one shown a moment is none. */
  dialogConfirmMs: number;
  /** How long apart Herdr is asked again for an agent it did not find. */
  lostAgentMs: number;
  /**
   * How long a compaction's record may show it not begun, then not ended, before the screen says:
   * a loaded codex began a turn 70 s late.
   */
  compactionGraceMs: number;
};

const PANE_TIMINGS: PaneTimings = {
  turnPollMs: 2_000,
  untakenMs: 5_000,
  dialogConfirmMs: 5_000,
  lostAgentMs: 5_000,
  compactionGraceMs: 90_000,
};
/** How many times running, `lostAgentMs` apart, Herdr must not find an agent for it to be gone. */
const MISSING_CHECKS = 3;
/** How long one wait on Herdr for a dialog runs before it is asked again. */
const DIALOG_WAIT_MS = 30 * 60_000;
/** How long a record, read every `RECORD_POLL_MS` while its turn runs, is given to catch up. */
const RECORD_CATCH_UP_MS = 600;
/**
 * How often a turn's record is read once its harness has taken the prompt in: an end shown this
 * late is still well inside any release. Untaken, it is read as often as the watch reads.
 */
const RECORD_POLL_MS = 500;
/** How often it is read while the prompt is untaken, which a dropped Enter is caught by. */
const UNTAKEN_POLL_MS = 100;

/** How a recorded turn settled: how it ended and its session, or the outcome that ends it. */
type TurnSettled =
  | { settled: Pick<NativeTurnOutcome, "state" | "detail">; session?: string }
  | { outcome: NativeTurnOutcome };

/** How a turn its harness records ended, as read there: its end and session, or why not. */
type TurnEnd =
  | { how: "completed" | "interrupted"; session?: string }
  | { failed: string }
  | { stopped: true };

/**
 * A pane's turn, read from its harness's record as it runs, until the record shows it ended or the
 * watch failed or was stopped, after which the record says nothing more of it.
 */
type RecordedTurn = {
  ended: Promise<TurnEnd>;
  /** How it ended, once the record said, or the watch stopped; absent while it is read. */
  end?: TurnEnd;
  /** Its harness took the prompt in. */
  accepted: boolean;
  /** The delivery marker its prompt carried. */
  marker: string;
  /**
   * One wait on Herdr, for as long as the turn is read, for a dialog blocking it or its harness
   * gone, shared by everything waiting on the turn. Never settles otherwise.
   */
  dialog(): Promise<NativeTurnOutcome>;
  /** Reads its record now, rather than at the watch's next poll. */
  readNow(): void;
  stop(): void;
};

/**
 * Whether `turn`'s record speaks for the pane: its harness took the prompt in and the watch on it
 * neither failed nor was stopped. Otherwise Herdr does, as for a harness with no record.
 */
function recordSpeaks(turn: RecordedTurn | undefined): turn is RecordedTurn {
  return turn?.accepted === true && (turn.end === undefined || "how" in turn.end);
}

/** The outcome of a turn whose record stopped being readable once its harness took it in. */
const unreadable = (reason: string) =>
  localOutcome("failed", `its harness's record could not be read: ${reason}`);

/**
 * What `look` sees on two looks `gapMs` apart, the second's; undefined where either sees nothing,
 * or `signal` ends the gap. A loaded screen lags its record, and a dialog can show a moment.
 */
async function lookTwice<T>(
  look: () => Promise<T | undefined>,
  gapMs: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  if (!(await look())) return undefined;
  if (!(await abortableDelay(gapMs, signal))) return undefined;
  return look();
}

/** How often a pane parent's session is read, while its last turn is still being written. */
const FORK_SETTLE_POLL_MS = 500;

/**
 * The Herdr this adapter drives, as `herdr --version` answers: the run's, checked by the evals'
 * preflight, and a box's, checked before its first pane, as the default image pins it.
 */
export const HERDR_VERSION = "herdr 0.9.1";

export type HerdrCommands = ReturnType<typeof createHerdrCommands>;

/** How starting an agent in a pane ended, after how many attempts. */
type StartResult = {
  ok: boolean;
  attempts: number;
  error: string;
  timedOut: boolean;
  cancelled: boolean;
};

const startedAfter = (attempts: number): StartResult => ({
  ok: true,
  attempts,
  error: "",
  timedOut: false,
  cancelled: false,
});

const stopped = (
  attempts: number,
  error: string,
  how: { timedOut?: boolean; cancelled?: boolean } = {},
): StartResult => ({
  ok: false,
  attempts,
  error,
  timedOut: how.timedOut ?? false,
  cancelled: how.cancelled ?? false,
});

/**
 * The commands that drive one Herdr: the run's own session, or, `via` a sandbox, the Herdr in its
 * box, whose every command is the sandbox's to run and reap.
 */
export function createHerdrCommands(
  config: HerdrConfig,
  run: RunProcess,
  via?: Exclude<PaneHerdr, "run">,
) {
  const startAttempts = config.startAttempts ?? 5;
  const startRetryMs = config.startRetryMs ?? 2_000;
  const command = (args: string[], timeoutMs: number, signal?: AbortSignal) => {
    if (!via) {
      return { argv: ["herdr", "--session", config.session, ...args], timeoutMs, signal };
    }
    const boxed = via.run(args, timeoutMs);
    return signal ? { ...boxed, signal } : boxed;
  };
  const herdr: HerdrCommand = async (args, timeoutMs, signal) => {
    const result = await run(command(args, timeoutMs ?? config.commandTimeoutMs, signal));
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: readable(result.stderr || result.stdout || "herdr command failed")
          .trim()
          .slice(0, 400),
        timedOut: result.timedOut,
        cancelled: result.cancelled === true,
      };
    }
    const line = result.stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
    const answer = line === undefined ? undefined : parseRow(line);
    return { ok: true, result: record(answer?.result) ?? {}, stdout: result.stdout };
  };
  const startAgent = async (
    name: string,
    kind: string,
    paneId: string,
    args: string[],
    deadlineUnixMs: number,
    signal?: AbortSignal,
  ): Promise<StartResult> => {
    let error = "agent start never ran";
    let timedOut = false;
    for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
      if (signal?.aborted) return stopped(attempt - 1, "operation cancelled", { cancelled: true });
      const remaining = deadlineUnixMs - Date.now();
      if (remaining <= 0) {
        return stopped(attempt - 1, "operation deadline exceeded", { timedOut: true });
      }
      const started = await herdr(
        [
          "agent",
          "start",
          name,
          "--kind",
          kind,
          "--pane",
          paneId,
          "--timeout",
          String(AGENT_START_WAIT_MS),
          ...(args.length > 0 ? ["--", ...args] : []),
        ],
        Math.min(AGENT_START_WAIT_MS + HERDR_REPORT_GRACE_MS, remaining),
        signal,
      );
      if (started.ok) {
        const drawn = await untilDrawn(herdr, kind, paneId, deadlineUnixMs, signal);
        return drawn ? stopped(attempt, drawn.error, drawn) : startedAfter(attempt);
      }
      error = started.error;
      timedOut = started.timedOut;
      if (started.cancelled) return stopped(attempt, error, { cancelled: true });
      if (config.acceptWorkspaceTrust && hasHerdrErrorCode(error, "agent_not_ready")) {
        const trusted = await answerStartupBlocks(
          herdr,
          name,
          kind,
          config.trustSettleMs,
          deadlineUnixMs,
          signal,
        );
        return trusted.ok ? startedAfter(attempt) : stopped(attempt, trusted.error, trusted);
      }
      if (!hasHerdrErrorCode(error, "agent_pane_busy")) {
        return stopped(attempt, error, { timedOut });
      }
      if (attempt === startAttempts) break;
      const retryRemaining = deadlineUnixMs - Date.now();
      if (retryRemaining <= 0) {
        return stopped(attempt, "operation deadline exceeded", { timedOut: true });
      }
      if (!(await abortableDelay(Math.min(startRetryMs, retryRemaining), signal))) {
        return stopped(attempt, "operation cancelled", { cancelled: true });
      }
    }
    return stopped(startAttempts, error, { timedOut });
  };

  /**
   * Waits until `by` for the screen to show something and stop changing. The login shell draws
   * whatever the operator's rc files make of its prompt, so no prompt is looked for, and text typed
   * before it settles may be swallowed. False once cancelled.
   */
  const settle = async (screen: () => Promise<string>, by: number, signal?: AbortSignal) => {
    let shown = "";
    while (Date.now() < by) {
      const now = await screen();
      if (now.trim() !== "" && now === shown) break;
      shown = now;
      if (!(await abortableDelay(TYPED_START_POLL_MS, signal))) return false;
    }
    return true;
  };

  /** Herdr commands that each end by `by`, and `paneId`'s screen read through them. */
  const paneCalls = (paneId: string, by: number, signal?: AbortSignal) => {
    const call = (args: string[]) =>
      herdr(args, Math.max(1, Math.min(config.commandTimeoutMs, by - Date.now())), signal);
    const screen = async () => {
      const read = await call(["pane", "read", paneId]);
      return read.ok ? read.stdout : "";
    };
    return { call, screen };
  };

  /**
   * Types `text` into a fresh pane's login shell once it has settled, every call ending by `by`.
   * Undefined once cancelled.
   */
  const typeInto = async (paneId: string, text: string, by: number, signal?: AbortSignal) => {
    const { call, screen } = paneCalls(paneId, by, signal);
    // If the text is swallowed nonetheless, what it should show never does.
    if (!(await settle(screen, Math.min(by, Date.now() + TYPED_START_SETTLE_MS), signal))) {
      return undefined;
    }
    return call(["pane", "run", paneId, text]);
  };

  /** Types `argv`, quoted, into a fresh pane's login shell. */
  const typeCommand = (paneId: string, argv: readonly string[], by: number, signal: AbortSignal) =>
    typeInto(paneId, argv.map(shellQuote).join(" "), by, signal);

  /**
   * Starts a harness in a sandbox's pane by typing it, then adopts it (story 004, H4, H6): `agent
   * start` refuses a pane whose root is srt rather than a shell. The pane's shell takes the
   * prelude, which becomes the confined shell; the harness is typed only once that shell's prompt
   * shows `ready`, which nothing typed can show, so it never runs in the operator's shell; and
   * `agent rename` names it once Herdr has detected it. A prompt sent before the agent is idle is
   * lost (H6).
   */
  const adoptAgent = async (
    name: string,
    kind: string,
    paneId: string,
    terminal: { prelude: string; ready: string; harness: string },
    args: readonly string[],
    deadlineUnixMs: number,
    signal?: AbortSignal,
  ): Promise<StartResult> => {
    // One attempt: typing twice into a shell would run what the first left.
    const failed = (error: string, how: { timedOut?: boolean; cancelled?: boolean } = {}) =>
      stopped(1, error, how);
    const cancelled = () => failed("operation cancelled", { cancelled: true });
    const step = () => Math.min(deadlineUnixMs, Date.now() + TYPED_START_WAIT_MS);
    const { call, screen } = paneCalls(paneId, deadlineUnixMs, signal);
    const type = async (text: string) => {
      const typed = await call(["pane", "run", paneId, text]);
      return typed.ok ? undefined : failed(`typing into the pane failed: ${typed.error}`, typed);
    };
    const prelude = await typeInto(paneId, terminal.prelude, deadlineUnixMs, signal);
    if (!prelude) return cancelled();
    if (!prelude.ok) return failed(`typing into the pane failed: ${prelude.error}`, prelude);
    const ready = terminal.ready.trimEnd();
    let confined = false;
    for (const limit = step(); !confined && Date.now() < limit; ) {
      const last =
        (await screen())
          .split("\n")
          .filter((line) => line.trim() !== "")
          .at(-1) ?? "";
      confined = last.trimEnd().endsWith(ready);
      if (!confined && !(await abortableDelay(TYPED_START_POLL_MS, signal))) return cancelled();
    }
    if (!confined) {
      return failed(
        `the sandbox's shell never showed its prompt: ${readable(await screen()).slice(-300)}`,
        { timedOut: true },
      );
    }
    const typedHarness = await type([terminal.harness, ...args].map(shellQuote).join(" "));
    if (typedHarness) return typedHarness;
    let adopted = false;
    for (const limit = step(); !adopted && Date.now() < limit; ) {
      const renamed = await call(["agent", "rename", paneId, name]);
      if (renamed.ok) adopted = true;
      else if (renamed.cancelled) return cancelled();
      else if (!hasHerdrErrorCode(renamed.error, "agent_not_found")) {
        return failed(`adopting the agent failed: ${renamed.error}`, renamed);
      } else if (!(await abortableDelay(TYPED_START_POLL_MS, signal))) {
        return cancelled();
      }
    }
    if (!adopted) {
      return failed(`Herdr never detected ${kind}: ${readable(await screen()).slice(-300)}`, {
        timedOut: true,
      });
    }
    const idleWait = Math.max(1, step() - Date.now());
    const waited = await herdr(
      ["agent", "wait", name, "--until", "idle", "--timeout", String(idleWait)],
      idleWait + HERDR_REPORT_GRACE_MS,
      signal,
    );
    const status = waited.ok ? record(waited.result.agent)?.agent_status : undefined;
    if (status === "blocked") {
      if (!config.acceptWorkspaceTrust) {
        return failed(`${kind} is blocked at startup, and workspace trust is not accepted`);
      }
      const answered = await answerStartupBlocks(
        herdr,
        name,
        kind,
        config.trustSettleMs,
        deadlineUnixMs,
        signal,
      );
      if (!answered.ok) return failed(answered.error, answered);
    } else if (!waited.ok) {
      return failed(`the agent never became idle: ${waited.error}`, waited);
    }
    const drawn = await untilDrawn(herdr, kind, paneId, step(), signal);
    return drawn ? failed(drawn.error, drawn) : startedAfter(1);
  };
  /** `herdr --version`'s answer, which names no session. */
  const version = async () => {
    const answered = await run(
      via
        ? via.run(["--version"], config.commandTimeoutMs)
        : { argv: ["herdr", "--version"], timeoutMs: config.commandTimeoutMs },
    );
    return answered.exitCode === 0 ? answered.stdout.trim() : undefined;
  };
  return { herdr, startAgent, adoptAgent, typeCommand, version };
}

/**
 * Waits for `kind`'s pane to show it takes input, where its spec says how; undefined once it does,
 * or has nothing to show, else why not. Herdr reports cursor ready about 3.5 s after it starts,
 * drawn or not: with many panes starting, a prompt pasted sooner went to the shell and sat unsent
 * in cursor's input once it drew.
 */
async function untilDrawn(
  herdr: HerdrCommand,
  kind: string,
  paneId: string,
  by: number,
  signal?: AbortSignal,
): Promise<{ error: string; timedOut: boolean; cancelled: boolean } | undefined> {
  const spec = findHarness(kind);
  const drawn = spec?.paneReady;
  if (!drawn) return undefined;
  const limit = Math.min(by, Date.now() + AGENT_START_WAIT_MS);
  const read = async () => {
    const screen = await herdr(["pane", "read", paneId, "--source", "recent-unwrapped"]);
    return screen.ok ? readable(screen.stdout) : "";
  };
  for (;;) {
    // In steps, so a login it shows instead ends the wait, for its start to say so.
    const waitMs = Math.max(1, Math.min(limit - Date.now(), DRAWN_STEP_MS));
    const shown = await herdr(
      ["pane", "wait-output", paneId, "--match", drawn, "--timeout", String(waitMs)],
      waitMs + HERDR_REPORT_GRACE_MS,
      signal,
    );
    if (shown.ok) return undefined;
    if (shown.cancelled || signal?.aborted) {
      return { error: "operation cancelled", timedOut: false, cancelled: true };
    }
    // Herdr's own timeout comes back as its `timeout` error, not as awf's kill: that is waited
    // on to the limit; any other error, a pane gone, ends it.
    const screen = await read();
    const login = spec.login?.screen(screen) !== undefined;
    const waiting = !shown.ok && hasHerdrErrorCode(shown.error, "timeout");
    if (login || !waiting || Date.now() >= limit) {
      return {
        error: `${kind} never showed it was ready: ${screen.trim().slice(-300) || shown.error}`,
        timedOut: !login && waiting,
        cancelled: false,
      };
    }
  }
}

/** How long reading a pane's screen as evidence may take: it holds up a failed start's close. */
const SCREEN_READ_MS = 5_000;

/** How long each wait for a pane to draw runs before its screen is looked at for a login. */
const DRAWN_STEP_MS = 5_000;

/** How long each step of a typed start may take: detection took about a second (H6). */
const TYPED_START_WAIT_MS = 60_000;
/** How long the login shell has to draw its first prompt before the prelude is typed anyway. */
const TYPED_START_SETTLE_MS = 10_000;
const TYPED_START_POLL_MS = 300;
/** How often a pane whose harness looks idle while it compacts is read for the compaction's end. */
const COMPACTION_POLL_MS = 500;

export function createPaneAdapter(
  config: HerdrConfig,
  run: RunProcess = runProcess,
): AgentSessionAdapter {
  const emptyEnvironment = emptyEnvironmentArgs(config.emptyEnvironment);
  const { herdr, startAgent } = createHerdrCommands(config, run);
  return createSessionAdapter({
    harnesses: HARNESS_NAMES,
    async activate(request) {
      const harness = knownHarness(request.execution.harness);
      const spec = harnessSpec(harness);
      const identity: { sessionId: string; cwd: string } = {
        sessionId: randomUUID(),
        cwd: request.cwd,
      };
      const openWorkspaces = new Set<string>();
      let executed = false;
      let closed = false;
      let activeController: AbortController | undefined;
      let activeCompletion: Promise<void> | undefined;

      const closeWorkspace = async (workspaceId: string): Promise<void> => {
        const result = await herdr(["workspace", "close", workspaceId]);
        if (result.ok) {
          openWorkspaces.delete(workspaceId);
          return;
        }
        throw new Error(`workspace close failed: ${result.error}`);
      };
      const closeOpenWorkspaces = async (): Promise<void> => {
        const results = await Promise.allSettled([...openWorkspaces].map(closeWorkspace));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      };

      return {
        identity,
        async execute(operation) {
          if (closed) throw new Error("pane session is closed");
          if (executed || operation.previousSessionRef) {
            return localOutcome(
              "failed",
              "safe pane continuation is unavailable without a measured " +
                "interactive-resume primitive",
            );
          }
          executed = true;
          const remaining = () => operation.deadline.unixMilliseconds - Date.now();
          if (remaining() <= 0) return deadlineExceeded();
          const controller = new AbortController();
          activeController = controller;
          let finish!: () => void;
          activeCompletion = new Promise<void>((resolve) => {
            finish = resolve;
          });
          let workspaceId: string | undefined;
          try {
            const prompt = request.instructions
              ? `${request.instructions}\n\n${operation.prompt}`
              : operation.prompt;
            const name = safeAgentName(
              `wf-${request.key}`,
              operation.binding?.operationId ?? `${request.key}-${operation.id}`,
            );
            const created = await herdr(
              [
                "workspace",
                "create",
                "--label",
                `${config.workspaceLabel} ${request.key} ${operation.id}`,
                ...emptyEnvironment,
                "--cwd",
                request.cwd,
                "--no-focus",
              ],
              Math.max(1, remaining()),
              controller.signal,
            );
            if (!created.ok) return herdrFailure(created, remaining());
            const paneId = readPaneId(created.result);
            workspaceId = readId(created.result.workspace, "workspace_id");
            if (workspaceId) openWorkspaces.add(workspaceId);
            if (!paneId || !workspaceId) {
              throw new Error("workspace create returned incomplete identity");
            }
            const launch = spec.interactive(launchSettings(request.execution));
            const started = await startAgent(
              name,
              harness,
              paneId,
              launch.argv.slice(1),
              operation.deadline.unixMilliseconds,
              controller.signal,
            );
            if (!started.ok) {
              const login = started.cancelled
                ? undefined
                : await loginShown(
                    herdr,
                    harness,
                    paneId,
                    config.commandTimeoutMs,
                    controller.signal,
                  );
              if (controller.signal.aborted || started.cancelled) {
                return paneCancelled();
              }
              return (
                login ??
                localOutcome(
                  started.timedOut || remaining() <= 0 ? "timed-out" : "failed",
                  `agent start failed after ${started.attempts}: ${started.error}`,
                )
              );
            }
            if (remaining() <= 0) return deadlineExceeded();
            const waitMs = Math.max(1, remaining());
            const sent = await herdr(
              ["agent", "prompt", name, prompt, "--wait", "--timeout", String(waitMs)],
              waitMs + HERDR_REPORT_GRACE_MS,
              controller.signal,
            );
            if (!sent.ok) {
              const login = sent.cancelled
                ? undefined
                : await loginShown(
                    herdr,
                    harness,
                    paneId,
                    config.commandTimeoutMs,
                    controller.signal,
                    operation.binding?.operationId,
                  );
              if (sent.cancelled || controller.signal.aborted) {
                return paneCancelled();
              }
              return login ?? herdrFailure(sent, remaining());
            }
            if (remaining() <= 0) return deadlineExceeded();
            const read = await herdr(
              ["agent", "read", name, "--source", "detection"],
              Math.max(1, remaining()),
              controller.signal,
            );
            if (!read.ok && read.cancelled) {
              return paneCancelled();
            }
            const herdrSaid = herdrSettled(harness, sent);
            const outcome = paneOutcome(
              harness,
              herdrSaid.settled,
              herdrSaid.session,
              read,
              await loginShown(
                herdr,
                harness,
                paneId,
                config.commandTimeoutMs,
                controller.signal,
                operation.binding?.operationId,
                read.ok ? read.stdout : "",
              ),
            );
            if (outcome.sessionRef) identity.sessionId = outcome.sessionRef;
            return outcome;
          } finally {
            try {
              if (workspaceId && openWorkspaces.has(workspaceId)) await closeWorkspace(workspaceId);
            } catch {
              // A failed close leaves the workspace in `openWorkspaces` for `close()` to retry and
              // report; it must not overwrite the outcome this operation already produced.
            } finally {
              if (activeController === controller) activeController = undefined;
              finish();
            }
          }
        },
        async close() {
          if (closed) return;
          activeController?.abort();
          await activeCompletion;
          await closeOpenWorkspaces();
          closed = true;
        },
        async cancel() {
          if (!activeController) return false;
          activeController.abort();
          await activeCompletion;
          return true;
        },
      };
    },
  });
}

/** The production host: a pane for each agent, placed as its layout says. */
export function createHerdrRunHostFactory(
  config: HerdrConfig,
  run: RunProcess = runProcess,
): AgentRunHostFactory {
  /**
   * Every pane launches its own process, so the workspace's environment does not reach it and the
   * metered credentials this run promises to withhold would survive in an agent pane. Nothing the
   * return channel needs is repeated here: a pane inherits its `PATH` from the login shell Herdr
   * starts, and the launcher the agent is told to run is named by absolute path regardless.
   */
  const paneEnvironment = emptyEnvironmentArgs(config.emptyEnvironment);
  const runCommands = createHerdrCommands(config, run);
  /** A fork runs beside its pane, without the credentials a pane is kept from. */
  const forkRun = withholding(run, config.emptyEnvironment ?? []);

  return {
    // A pane's agent never sees the emptied variables, so its status command must not either.
    accounting: createSessionAccounting(withholding(run, config.emptyEnvironment ?? [])),
    async openRun(runSpec) {
      const remaining = () => runSpec.deadline.unixMilliseconds - Date.now();
      const label = runSpec.label ?? runSpec.runId;
      // Its workspace is made at the first tab it needs, so a run whose panes are all in boxes,
      // unwatched, leaves no empty workspace in the run's Herdr.
      const screenIn = (session: string, commands: HerdrCommands) =>
        createPaneScreen({
          commands,
          session,
          label,
          cwd: runSpec.cwd,
          environment: paneEnvironment,
          commandTimeoutMs: config.commandTimeoutMs,
          remaining,
          ...(config.onRunWorkspace && session === config.session
            ? { onRunWorkspace: config.onRunWorkspace }
            : {}),
          ...(config.onPanes
            ? { onPanes: (panes: readonly MadePane[]) => config.onPanes!(session, panes) }
            : {}),
          ...(config.lockWorkspace
            ? { lockWorkspace: (name: string) => config.lockWorkspace!(session, name) }
            : {}),
        });
      const runScreen = screenIn(config.session, runCommands);
      /** The other sessions this run's panes open in, by name: `"origin"`'s. */
      const screens = new Map<string, PaneScreen>();
      const sessionScreen = (session: string) => {
        if (session === config.session) return runScreen;
        let screen = screens.get(session);
        if (!screen) {
          screen = screenIn(session, createHerdrCommands({ ...config, session }, run));
          screens.set(session, screen);
        }
        return screen;
      };
      let origin: Promise<{ screen: PaneScreen; workspaceId: string } | string> | undefined;
      const runLayout = createPaneLayout({
        run: runScreen,
        runId: runSpec.runId,
        origin: () => {
          origin ??= (async () => {
            const found = await config.origin?.().catch((error: unknown) => asError(error).message);
            if (found === undefined) return "this run was not started in a Herdr pane";
            if (typeof found === "string") return `"origin" can't be used: ${found}`;
            return { screen: sessionScreen(found.session), workspaceId: found.workspaceId };
          })();
          return origin;
        },
      });
      // A sandbox's own Herdr, by its key: opened at its first TUI agent, closed with the run.
      // A box's Herdr holds no host credential, so its panes need no variables emptied.
      const boxes = new Map<string, Promise<{ screen: PaneScreen; layout: PaneLayoutHost }>>();
      /** Tabs attached to a box's Herdr, finished before the run's workspace closes. */
      const watching = new Set<Promise<unknown>>();
      // Aborted as the host closes: a watch not yet typed has nothing left to show.
      const unwatch = new AbortController();
      // Best effort: the engine has printed the same command, and an agent does not wait on it.
      const watch = (key: string, argv: readonly string[], cwd: string) => {
        const attached = (async () => {
          if (unwatch.signal.aborted) return;
          const label = `sandbox ${key}`;
          const by = Date.now() + config.commandTimeoutMs;
          const paneId =
            (await runScreen.takeRoot(label)) ??
            (await runScreen.watchTab(label, cwd, by, unwatch.signal));
          await runCommands.typeCommand(paneId, argv, by, unwatch.signal);
        })().catch(() => undefined);
        watching.add(attached);
        attached.finally(() => watching.delete(attached));
      };
      const layoutFor = (terminal: PaneTerminal | undefined, cwd: string) => {
        if (!terminal || terminal.herdr === "run") return Promise.resolve(runLayout);
        const via = terminal.herdr;
        let opening = boxes.get(via.key);
        if (!opening) {
          opening = (async () => {
            const commands = createHerdrCommands(config, run, via);
            const box = await commands.version();
            if (box !== HERDR_VERSION) {
              throw new Error(
                `the sandbox's Herdr is ${box ?? "not answering"}, and this adapter drives ${HERDR_VERSION}`,
              );
            }
            const screen = createPaneScreen({
              commands,
              session: `sandbox ${via.key}`,
              label,
              cwd,
              environment: [],
              commandTimeoutMs: config.commandTimeoutMs,
              remaining,
              boxed: true,
            });
            if (config.watchSandboxes && via.watch) watch(via.key, via.watch, cwd);
            return { screen, layout: createPaneLayout({ run: screen, runId: runSpec.runId }) };
          })();
          boxes.set(via.key, opening);
          const failed = opening;
          failed.catch(() => {
            if (boxes.get(via.key) === failed) boxes.delete(via.key);
          });
        }
        return opening.then((box) => box.layout);
      };

      const adapter = createSessionAdapter({
        harnesses: PLACEMENT_HARNESSES.tui,
        placement: "tui",
        launchesInSandbox: true,
        givesSkills: true,
        continues: true,
        async activate(request) {
          const harness = knownHarness(request.execution.harness);
          const spec = harnessSpec(harness);
          const { continues } = request;
          if (continues && !spec.interactiveResume) {
            throw new Error(
              `${harness} tui agents cannot continue a forked session: ${spec.absent.interactiveResume}`,
            );
          }
          /** What its harness is launched at: as activated, then as the last `set` left it. */
          let settings = launchSettings(request.execution);
          /** Its harness's launches in a pane, a relaunch at other settings included. */
          let launches = 0;
          /** The harness's own fork of `sessionRef`, run beside the pane or inside its sandbox. */
          const runFork = async (
            sessionRef: string,
            deadline: { unixMilliseconds: number },
            signal: AbortSignal,
          ): Promise<NativeFork> => {
            const skills = request.skills ? await skillsLaunch(harness, request.skills) : undefined;
            const plan = await spec.forkSession!(sessionRef, randomUUID(), {
              ...settings,
              sessionHint: sessionRef,
              ...(request.home ? { home: request.home } : {}),
              launchArgs: launchArgs(harness, request, skills),
            });
            return runForkPlan(
              harness,
              plan,
              { cwd: request.cwd, env: { ...skills?.env }, deadline, signal },
              request.occupant ? run : forkRun,
              request.occupant,
            );
          };
          // A session copied into this agent's home is forked here, before its pane opens on it.
          const continued =
            continues?.copied && spec.forkSession
              ? (
                  await runFork(
                    continues.sessionRef,
                    forkDeadline(request.deadline),
                    AbortSignal.timeout(FORK_ACTIVATION_MS),
                  )
                ).sessionRef
              : continues?.sessionRef;
          if (continues?.copied && !spec.forkSession) throw new Error(`${harness} cannot fork`);
          // In a sandbox, the pane's terminal is the occupant's, in the run's Herdr or the box's.
          let terminal = request.occupant ? await request.occupant.pane?.() : undefined;
          if (request.occupant && !terminal) throw new Error("this sandbox hosts no panes");
          // A prelude loads its secrets once and removes them: a start after a failed one needs
          // a terminal of its own.
          let typed = false;
          const placing = await layoutFor(terminal, request.cwd);
          const skills = request.skills ? await skillsLaunch(harness, request.skills) : undefined;
          const paneRequest = (
            deadline: { unixMilliseconds: number },
            signal?: AbortSignal,
          ): PaneRequest => ({
            key: request.key,
            ...(request.layout ? { layout: request.layout } : {}),
            ...(request.layoutFallback ? { fallback: request.layoutFallback } : {}),
            ...(request.front ? { front: true as const } : {}),
            ...(request.fallbackWorkspace ? { fallbackWorkspace: request.fallbackWorkspace } : {}),
            cwd: request.cwd,
            ...(skills ? { env: skills.env } : {}),
            deadlineUnixMs: deadline.unixMilliseconds,
            ...(signal ? { signal } : {}),
          });
          /**
           * Its pane, placed now so the workflow's order is the screen's, and any agent open is
           * there to split, or at its first turn where the activation says; absent once closed.
           */
          let pane: PlacedPane | undefined = request.paneAtFirstTurn
            ? undefined
            : await placing.place(paneRequest(request.deadline));
          // The session its pane is in, which a pane placed again may change.
          let commands = pane?.screen.commands;
          const screen = () => {
            if (!commands) throw new Error(`${request.key} has no pane yet`);
            return commands;
          };
          const herdr: HerdrCommand = (...args) => screen().herdr(...args);
          const startAgent: HerdrCommands["startAgent"] = (...args) => screen().startAgent(...args);
          const adoptAgent: HerdrCommands["adoptAgent"] = (...args) => screen().adoptAgent(...args);
          /** Where it was placed: kept once its pane closes, for the record; absent until it is. */
          let placement = pane?.report;
          let current:
            | {
                operationId: string;
                paneId: string;
                agentName: string;
              }
            | undefined;
          let closed = false;
          let hasExecuted = false;
          const mayKeep = request.keepPane === "always" || request.keepPane === "on-failure";
          /** Whether its pane was kept when it was done, or why not. */
          let fate: Pick<PanePlacement, "kept" | "notKept"> = {};

          const timings = { ...PANE_TIMINGS, ...config.timings };

          /**
           * Herdr's report of `agentName`: Herdr can lose a live agent a moment under load, so it
           * is gone only if Herdr keeps not finding it. Herdr's last answer otherwise.
           */
          const getAgent = async (agentName: string, signal?: AbortSignal) => {
            let got = await herdr(["agent", "get", agentName], undefined, signal);
            for (let check = 1; !got.ok && check < MISSING_CHECKS; check++) {
              if (!hasHerdrErrorCode(got.error, "agent_not_found")) break;
              if (!(await abortableDelay(timings.lostAgentMs, signal))) break;
              got = await herdr(["agent", "get", agentName], undefined, signal);
            }
            return got;
          };

          /** The dialog blocking `agentName`, shown on two looks running; undefined where none. */
          const confirmedDialog = (agentName: string, gapMs: number, signal?: AbortSignal) =>
            lookTwice(
              async () => blockedBy(await herdr(["agent", "get", agentName], undefined, signal)),
              gapMs,
              signal,
            );

          /**
           * Whether its harness holds `untaken`'s prompt, which it never took in, unsent in its
           * input, on two looks running, as a loaded screen lags its record; never where it cannot.
           */
          const stillHeld = async (
            agentName: string,
            untaken: RecordedTurn | undefined,
            signal?: AbortSignal,
          ): Promise<boolean> => {
            const held = spec.heldPrompt;
            if (!held || !untaken || untaken.accepted) return false;
            const look = async () => {
              const read = await herdr(
                ["agent", "read", agentName, "--source", "detection"],
                config.commandTimeoutMs,
                signal,
              );
              return (
                (read.ok && !untaken.accepted && held(read.stdout, untaken.marker)) || undefined
              );
            };
            return (await lookTwice(look, RECORD_CATCH_UP_MS, signal)) ?? false;
          };

          /** Interrupts its harness if it is working, as an answered turn left too long is. */
          const interrupt = async (agentName: string): Promise<boolean> => {
            const got = await getAgent(agentName);
            if (!got.ok) return false;
            // A record a poll behind a turn just ended would have Escape reach an idle codex,
            // whose second opens its history: it is given a moment to catch up first.
            if (recordSpeaks(turn) && turn.end === undefined) {
              turn.readNow();
              await Promise.race([turn.ended, Bun.sleep(RECORD_CATCH_UP_MS)]);
            }
            // A dialog is left for the operator to answer: Escape would dismiss it. One shown only
            // a moment, as claude's auto mode asking under load, is no dialog.
            // Not seen again, as by a lost agent, it stays one.
            const status = reportedAgent(got.result).agent_status;
            let blocked = status === "blocked";
            if (blocked) {
              await Bun.sleep(RECORD_CATCH_UP_MS);
              const again = await herdr(["agent", "get", agentName]);
              if (again.ok) blocked = reportedAgent(again.result).agent_status === "blocked";
            }
            if (recordSpeaks(turn) ? turn.end === undefined && !blocked : status === "working") {
              await herdr(["agent", "send-keys", agentName, "esc"]);
            }
            return true;
          };

          /**
           * Its harness was released by a cancel, and prompted nothing since: a second Escape opens
           * codex's history.
           */
          let released = false;
          /**
           * Readies its harness to be left in a kept pane: interrupted if working, and settled, so a
           * kept agent goes on editing nothing. Why not, where it is gone or would not settle.
           */
          const release = async (agentName: string): Promise<string | undefined> => {
            if (released) return undefined;
            if (!(await interrupt(agentName))) return "its harness is gone";
            // A harness that dropped the Enter still holds the cancelled prompt in its input,
            // where the next paste would join it.
            if (await stillHeld(agentName, turn)) return "its prompt is still unsent in its input";
            const busy = await settle(
              agentName,
              { unixMilliseconds: Date.now() + KEEP_SETTLE_MS },
              AbortSignal.timeout(KEEP_SETTLE_MS + HERDR_REPORT_GRACE_MS),
            );
            return busy && busy.state !== "blocked"
              ? `its harness did not settle after an interrupt: ${busy.detail ?? busy.state}`
              : undefined;
          };
          /** When its harness was launched: a session it names to nobody started since. */
          let launchedAt = Date.now();
          /** The workflow's instructions go with the first prompt the pane's agent is sent. */
          const instructed = instructOnce(request.instructions);
          const active = activeOperation();
          // A run-local sandbox pane preserves the host cwd and seeded harness home.
          const readsRecord =
            !request.occupant || (terminal?.herdr === "run" && request.home !== undefined);
          const confirmsDelivery = harness === "claude" && readsRecord;
          const receiptObservers = new Set<AbortController>();
          /**
           * Where its harness records its turns, read for their start and end in place of
           * Herdr's screen, which with many panes busy missed a turn or showed it late.
           */
          const turnRecord = readsRecord ? spec.turnRecord : undefined;
          /**
           * Its last prompted turn, where its record is read; none after a compaction. Until its
           * harness takes the prompt in, which a cancel can stop, Herdr settles it, as with none;
           * one its operation gave up on untaken is kept, read no more, for the prompt it may hold.
           */
          let turn: RecordedTurn | undefined;
          /** Its last turn was settled by its record, and Herdr's wait has not caught up since. */
          let herdrBehind = false;

          /** Where its harness records `session`'s turns, or a new session's. */
          const turnPlace = (record: NonNullable<typeof turnRecord>, session: string | undefined) =>
            record.place({
              cwd: request.cwd,
              since: launchedAt,
              ...(request.home ? { home: request.home } : {}),
              ...(session ? { session } : {}),
            });

          /**
           * Waits for `recorded` to end, with one wait on Herdr meanwhile for a dialog blocking it.
           * `untaken`, called while its harness has not taken the prompt in, may end it instead. A
           * record that stopped being readable fails the turn: Herdr, which may never have seen a
           * turn sent without its wait, cannot say it ended.
           */
          const untilEnded = async (
            recorded: RecordedTurn,
            deadline: number,
            signal: AbortSignal,
            untaken?: () => Promise<NativeTurnOutcome | undefined>,
          ): Promise<TurnSettled> => {
            const ended = (end: TurnEnd): TurnSettled =>
              "how" in end
                ? {
                    settled: {
                      state: "completed",
                      ...(end.how === "interrupted" ? { detail: "the turn was interrupted" } : {}),
                    },
                    ...(end.session ? { session: end.session } : {}),
                  }
                : "failed" in end
                  ? { outcome: unreadable(end.failed) }
                  : { outcome: paneCancelled() };
            if (recorded.end) return ended(recorded.end);
            const started = Date.now();
            const done = new AbortController();
            const waiting = AbortSignal.any([signal, done.signal]);
            const dialog = recorded.dialog().then((outcome) => ({ outcome }));
            try {
              for (;;) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) {
                  return { outcome: deadlineExceeded() };
                }
                // Ticks only to look at a prompt its harness has not taken in.
                const tick =
                  untaken && !recorded.accepted
                    ? Math.min(timings.turnPollMs, remaining)
                    : remaining;
                const next = await Promise.race([
                  recorded.ended,
                  dialog,
                  abortableDelay(tick, waiting),
                ]);
                if (next === false) {
                  return { outcome: paneCancelled() };
                }
                if (next === true) {
                  if (untaken && !recorded.accepted && Date.now() - started >= timings.untakenMs) {
                    const stopped = await untaken();
                    if (stopped) return { outcome: stopped };
                  }
                  continue;
                }
                if ("outcome" in next) return next;
                // A prompt never taken in is read only until its deadline.
                if ("stopped" in next && Date.now() >= deadline) {
                  return { outcome: deadlineExceeded() };
                }
                return ended(next);
              }
            } finally {
              done.abort();
            }
          };

          /** Herdr's own wait for the agent to settle; once it has, Herdr has caught up. */
          const herdrSettle = async (
            agentName: string,
            deadline: number,
            signal: AbortSignal,
          ): Promise<NativeTurnOutcome | undefined> => {
            const busy = await settleAgent(herdr, agentName, deadline, signal);
            if (!busy) herdrBehind = false;
            return busy;
          };

          /**
           * Herdr's own wait, once its record settled the pane's last turn: Herdr may not show
           * that turn's end yet, which would match a wait on what follows before it ran.
           */
          const herdrCaughtUp = async (
            agentName: string,
            deadline: number,
            signal: AbortSignal,
          ): Promise<NativeTurnOutcome | undefined> =>
            herdrBehind ? herdrSettle(agentName, deadline, signal) : undefined;

          /**
           * Waits on Herdr until `stopped` for a dialog blocking `agentName`, or for it gone:
           * Herdr answered `agent_not_found` for a live claude with eighteen panes busy, so only
           * one it keeps not finding has exited. A wait answered otherwise is asked again.
           */
          const dialogWait = async (
            agentName: string,
            stopped: AbortSignal,
          ): Promise<NativeTurnOutcome> => {
            const never = new Promise<never>(() => {});
            while (!stopped.aborted) {
              const shown = await herdr(
                ["agent", "wait", agentName, "--until", "blocked"],
                DIALOG_WAIT_MS,
                stopped,
              );
              // A dialog shown a moment, as claude's auto mode asking while its classifier is
              // slow under load, is no block: only one still there a moment later is.
              if (blockedBy(shown)) {
                const still = await confirmedDialog(agentName, timings.dialogConfirmMs, stopped);
                if (still) return still;
                continue;
              }
              if (stopped.aborted) break;
              if (!shown.ok && hasHerdrErrorCode(shown.error, "agent_not_found")) {
                const got = await getAgent(agentName, stopped);
                if (stopped.aborted) break;
                if (!got.ok && hasHerdrErrorCode(got.error, "agent_not_found")) {
                  return localOutcome("failed", "its harness exited during the turn");
                }
              }
              // Answered without a dialog, or failed, it is asked again a moment later.
              if (!(await abortableDelay(timings.lostAgentMs, stopped))) break;
            }
            return never;
          };

          /**
           * Reads the turn `watching` finds from its harness's record, as the pane's turn from now
           * on. Its delivery is told only while the operation still observes it.
           */
          const observeTurn = (
            watching: Awaited<ReturnType<typeof prepareTurnRecord>>,
            record: NonNullable<typeof turnRecord>,
            operation: {
              receiptSignal?: AbortSignal;
              receiptDeadline?: () => number;
              deadline: { unixMilliseconds: number };
              onAccepted?: () => void;
              onReceived?: () => void;
              onDeliveryFailed?: (reason: string) => void;
            },
            signal: AbortSignal,
            marker: string,
            agentName: string,
          ): RecordedTurn => {
            const stopping = new AbortController();
            let dialog: Promise<NativeTurnOutcome> | undefined;
            const observing = new AbortController();
            receiptObservers.add(observing);
            const receipt = AbortSignal.any([
              observing.signal,
              signal,
              ...(operation.receiptSignal ? [operation.receiptSignal] : []),
            ]);
            const receiptDeadline =
              operation.receiptDeadline ?? (() => operation.deadline.unixMilliseconds);
            const receiving = () => !receipt.aborted && Date.now() < receiptDeadline();
            let resolve!: (ended: TurnEnd) => void;
            const end = (ended: TurnEnd) => {
              recorded.end ??= ended;
              resolve(ended);
            };
            let received = false;
            const recorded: RecordedTurn = {
              ended: new Promise<TurnEnd>((settle) => {
                resolve = settle;
              }),
              accepted: false,
              marker,
              // Once it has answered, a later wait asks Herdr afresh: the dialog may be answered.
              dialog: () => {
                if (!dialog) {
                  const waiting = dialogWait(agentName, stopping.signal);
                  dialog = waiting;
                  const clear = () => {
                    if (dialog === waiting) dialog = undefined;
                  };
                  void waiting.then(clear, clear);
                }
                return dialog;
              },
              readNow: () => watching.readNow(),
              stop: () => stopping.abort(),
            };
            void watching
              .watch(
                stopping.signal,
                {
                  accepted() {
                    recorded.accepted = true;
                    if (receiving()) operation.onAccepted?.();
                  },
                  received() {
                    recorded.accepted = true;
                    received = true;
                    if (receiving()) operation.onReceived?.();
                  },
                  ended(how, file) {
                    const session = record.session(file);
                    herdrBehind = true;
                    end({ how, ...(session ? { session } : {}) });
                  },
                },
                // A poll in case no change is seen: a change to the file reads it at once.
                { every: () => (recorded.accepted ? RECORD_POLL_MS : UNTAKEN_POLL_MS) },
                // A prompt never taken in is read no longer than its operation runs.
                () =>
                  recorded.accepted
                    ? Number.POSITIVE_INFINITY
                    : operation.deadline.unixMilliseconds,
              )
              .catch((error: unknown) => {
                const reason = reasonOf(error);
                // Received, its delivery stands: only the record of its end was lost.
                if (!received && receiving()) operation.onDeliveryFailed?.(reason);
                end({ failed: reason });
              })
              .finally(() => {
                end({ stopped: true });
                // The dialog wait ends with the reading of its turn.
                stopping.abort();
                receiptObservers.delete(observing);
              });
            dropTurn();
            turn = recorded;
            return recorded;
          };

          /** Stops reading its last turn's record; Herdr settles what follows until another. */
          const dropTurn = () => {
            turn?.stop();
            turn = undefined;
          };

          /** What its pane showed as a failed start closed it, until the next operation. */
          let closedScreen: string | undefined;
          const readScreen = async (signal?: AbortSignal): Promise<string | undefined> => {
            if (!pane) return closedScreen;
            const read = await herdr(
              ["pane", "read", pane.paneId, "--source", "visible"],
              Math.min(config.commandTimeoutMs, SCREEN_READ_MS),
              signal,
            );
            return read.ok ? readable(read.stdout) : undefined;
          };

          const closeCurrentPane = async (): Promise<void> => {
            const closing = pane;
            if (!closing) return;
            // Its turn is read no more, whether the pane closes or not.
            dropTurn();
            await placing.close(closing);
            if (pane === closing) {
              pane = undefined;
              current = undefined;
            }
          };

          /**
           * Waits for its last turn to end, as its record says where it has one, and for no dialog
           * to block it; Herdr's wait otherwise.
           */
          const settle = async (
            agentName: string,
            deadline: { unixMilliseconds: number },
            signal: AbortSignal,
          ): Promise<NativeTurnOutcome | undefined> => {
            // A turn its harness took in whose record then failed: Herdr, which may never have
            // seen it, cannot say it is over.
            if (turn?.accepted && turn.end && "failed" in turn.end)
              return unreadable(turn.end.failed);
            if (!recordSpeaks(turn))
              return herdrSettle(agentName, deadline.unixMilliseconds, signal);
            const ended = await untilEnded(turn, deadline.unixMilliseconds, signal);
            if ("outcome" in ended) return ended.outcome;
            // A dialog can follow the turn's end, as claude's setup offers did; one shown only a
            // moment is no dialog.
            const dialog = await confirmedDialog(agentName, RECORD_CATCH_UP_MS, signal);
            return signal.aborted ? paneCancelled() : dialog;
          };

          /**
           * The harness's own compaction, typed into the pane as `spec.compactPane` says, each
           * prompt once the agent has settled. Neither Herdr's status nor any `wfa result` says it
           * ran, so the screen after it does; the summary is read from the harness's record, where
           * this host can read it.
           */
          const compactInPane = async (
            agentName: string,
            operation: {
              prompt: string;
              deadline: { unixMilliseconds: number };
              previousSessionRef?: string;
            },
            signal: AbortSignal,
          ): Promise<NativeTurnOutcome> => {
            const compaction = spec.compactPane!;
            const remaining = () => operation.deadline.unixMilliseconds - Date.now();
            const readRecent = () =>
              herdr(
                ["agent", "read", agentName, "--source", "recent-unwrapped", "--lines", "200"],
                Math.max(1, remaining()),
                signal,
              );
            let before = "";
            if (compaction.ended) {
              const read = await readRecent();
              if (!read.ok) {
                return read.cancelled || signal.aborted
                  ? paneCancelled()
                  : localOutcome("failed", `the pane could not be read: ${read.error}`);
              }
              before = read.stdout;
            }
            // Where its harness records its compaction, the record says it ran: a loaded
            // screen showed none, and Herdr's wait ended before it began.
            const session = operation.previousSessionRef;
            const reading = new AbortController();
            const recorded = turnRecord !== undefined && session !== undefined;
            const record =
              turnRecord && session
                ? await turnPlace(turnRecord, session)
                    .then((place) =>
                      watchSessionEnd(
                        place,
                        turnRecord.compaction,
                        AbortSignal.any([signal, reading.signal]),
                        () => operation.deadline.unixMilliseconds,
                      ),
                    )
                    .catch(() => undefined)
                : undefined;
            try {
              return await compactThrough();
            } finally {
              reading.abort();
            }

            async function compactThrough(): Promise<NativeTurnOutcome> {
              let agent: Record<string, unknown> | undefined;
              for (const [index, text] of compaction.prompts(operation.prompt).entries()) {
                if (index > 0) {
                  const idle = await settle(agentName, operation.deadline, signal);
                  if (idle) return idle;
                }
                const waitMs = remaining();
                if (waitMs <= 0) return deadlineExceeded();
                const sent = await herdr(
                  ["agent", "prompt", agentName, text, "--wait", "--timeout", String(waitMs)],
                  waitMs + HERDR_REPORT_GRACE_MS,
                  signal,
                );
                if (!sent.ok) {
                  if (sent.cancelled || signal.aborted) {
                    return paneCancelled();
                  }
                  // A stall says nothing about whether it ran; the screen will, once it settles.
                  if (!hasHerdrErrorCode(sent.error, "agent_prompt_stalled")) {
                    return herdrFailure(sent, remaining());
                  }
                  const idle = await settle(agentName, operation.deadline, signal);
                  if (idle) return idle;
                } else {
                  agent = reportedAgent(sent.result);
                }
              }
              // Either may show it first: the record, or a screen that has caught up.
              const shownOnScreen = async (): Promise<boolean> => {
                for (;;) {
                  const read = await readRecent();
                  if (
                    read.ok &&
                    compaction.compacted(read.stdout, operation.prompt, before) &&
                    (!compaction.ended || compaction.ended(read.stdout, before))
                  ) {
                    return true;
                  }
                  if (
                    remaining() <= 0 ||
                    !(await abortableDelay(COMPACTION_POLL_MS, reading.signal))
                  )
                    return false;
                }
              };
              // One its record has not seen begin a while after its prompts went is taken not to
              // have run, as the screen then says; begun, it is given as long again to end.
              const grace = () => Math.max(0, Math.min(remaining(), timings.compactionGraceMs));
              const graceOver = async () => {
                if ((await abortableDelay(grace(), reading.signal)) && record?.begun())
                  await abortableDelay(grace(), reading.signal);
                return false;
              };
              // A record it could not find to read still has the screen raced against its grace.
              const inRecord = recorded
                ? await Promise.race([
                    record?.ended ?? new Promise<never>(() => {}),
                    shownOnScreen(),
                    graceOver(),
                  ])
                : false;
              if (recorded && !inRecord && (signal.aborted || remaining() <= 0)) {
                return signal.aborted ? paneCancelled() : deadlineExceeded();
              }
              let read = await readRecent();
              while (
                !inRecord &&
                read.ok &&
                compaction.ended &&
                !compaction.ended(read.stdout, before)
              ) {
                // Herdr sees the agent idle, so nothing else would stop a compaction left running.
                const interrupt = () => herdr(["agent", "send-keys", agentName, "esc"]);
                if (remaining() <= 0) {
                  await interrupt();
                  return deadlineExceeded();
                }
                if (!(await abortableDelay(COMPACTION_POLL_MS, signal))) {
                  await interrupt();
                  return paneCancelled();
                }
                read = await readRecent();
              }
              if (!read.ok && (read.cancelled || signal.aborted)) {
                return paneCancelled();
              }
              // Herdr reads no scrollback of a pane it sees working, which a codex just past its
              // compaction can be: one its record showed needs no screen to say so.
              if (!read.ok && !inRecord) {
                return localOutcome("failed", `the pane could not be read: ${read.error}`);
              }
              const evidence = read.ok
                ? { kind: "transcript" as const, text: read.stdout }
                : { kind: "unavailable" as const };
              if (
                read.ok &&
                !inRecord &&
                !compaction.compacted(read.stdout, operation.prompt, before)
              ) {
                return {
                  state: "failed",
                  detail: `${harness} shows no compaction: ${readable(read.stdout).trim().slice(-300)}`,
                  resultEvidence: evidence,
                  reportedCostsUsd: [],
                };
              }
              // A stalled prompt returns no agent; the session is the one its turns already named.
              const sessionRef =
                (agent && spec.herdrSessionIsOwn && readSessionRef(agent)) ||
                operation.previousSessionRef;
              const summary = sessionRef
                ? await spec.readCompactSummary?.(sessionRef, request.cwd)
                : undefined;
              return {
                state: "completed",
                resultEvidence: evidence,
                ...(sessionRef ? { sessionRef } : {}),
                reportedCostsUsd: [],
                summary: summary ?? "",
              };
            }
          };

          /**
           * Opens a pane and starts its harness in it at `settings`, on `resume` where there is a
           * session to go on; why not, where it did not start.
           */
          const launchPane = async (
            resume: string | undefined,
            operationId: string,
            deadline: { unixMilliseconds: number },
            signal: AbortSignal,
            onSession?: (sessionRef: string) => void,
          ): Promise<NativeTurnOutcome | undefined> => {
            // A first start that failed closed its pane; one never started may be placed again.
            if (!pane) {
              try {
                pane = await placing.place(paneRequest(deadline, signal));
                placement = pane.report;
                commands = pane.screen.commands;
              } catch (error) {
                if (signal.aborted) {
                  return paneCancelled();
                }
                throw error;
              }
            }
            const { paneId } = pane;
            launchedAt = Date.now();
            launches += 1;
            // A relaunch is a new agent in Herdr, never the one whose pane it closed.
            const agentName = safeAgentName(
              `wf-${request.key}`,
              `${runSpec.runId}:${request.key}:${operationId}${launches > 1 ? `:${launches}` : ""}`,
            );
            current = { operationId, paneId, agentName };
            const args = launchArgs(harness, request, skills);
            // A new session named at launch can be read while its first turn runs.
            const launch = resume
              ? spec.interactiveResume!(resume, settings, args)
              : spec.interactive(settings, args, randomUUID());
            if (terminal && typed) terminal = await request.occupant!.pane!();
            typed = true;
            const started = terminal
              ? await adoptAgent(
                  agentName,
                  harness,
                  paneId,
                  terminal,
                  launch.argv.slice(1),
                  deadline.unixMilliseconds,
                  signal,
                )
              : await startAgent(
                  agentName,
                  harness,
                  paneId,
                  launch.argv.slice(1),
                  deadline.unixMilliseconds,
                  signal,
                );
            if (!started.ok) {
              const login =
                signal.aborted || started.cancelled
                  ? undefined
                  : await loginShown(herdr, harness, paneId, config.commandTimeoutMs, signal);
              if (!signal.aborted && !started.cancelled)
                closedScreen = await readScreen(signal).catch(() => undefined);
              await closeCurrentPane().catch(() => undefined);
              // A pane that would not close holds no agent to drive.
              current = undefined;
              if (signal.aborted || started.cancelled) {
                return paneCancelled();
              }
              return (
                login ??
                localOutcome(
                  started.timedOut ? "timed-out" : "failed",
                  `agent start failed after ${started.attempts}: ${started.error}`,
                )
              );
            }
            if (launch.sessionId) onSession?.(launch.sessionId);
            return undefined;
          };

          /**
           * Waits, where the usage reader can tell, until the session's last turn is written, or the
           * deadline; false when cancelled first.
           */
          const untilWritten = async (
            sessionRef: string,
            deadline: { unixMilliseconds: number },
            signal: AbortSignal,
          ): Promise<boolean> => {
            while (
              (await spec.readSessionUsage?.([sessionRef], request.cwd, request.home))?.open ===
                true &&
              Date.now() < deadline.unixMilliseconds
            ) {
              if (!(await abortableDelay(FORK_SETTLE_POLL_MS, signal))) return false;
            }
            return true;
          };

          /**
           * Switches its settings by relaunching its harness on its session at them, once its
           * agent has settled: a typed switch would save them as the operator's default (M2).
           * Before its pane opens, the pane opens at them. One that did not come back leaves no
           * pane, so the agent's next operation fails.
           */
          const relaunchAt = async (
            next: SessionSettings,
            deadline: { unixMilliseconds: number },
            sessionRef?: string,
          ): Promise<void> => {
            if (closed) throw new Error("Herdr run session is closed");
            if (!current) {
              if (hasExecuted) {
                throw new Error("this agent's pane was closed, so its session cannot be switched");
              }
              settings = launchSettings(next);
              return;
            }
            // A harness that names its session to nobody is found by its last operation's id.
            sessionRef ??= await spec.findSession?.(
              current.operationId,
              launchedAt,
              request.cwd,
              request.home,
            );
            if (!sessionRef) {
              throw new Error(
                "its harness never named its session, so its pane cannot relaunch on it",
              );
            }
            return active.run(async (signal) => {
              const busy = await settle(current!.agentName, deadline, signal);
              if (busy)
                throw new Error(`the agent did not settle before its switch: ${busy.detail}`);
              // Its harness is stopped with its pane: the session's last turn must be in it first.
              if (!(await untilWritten(sessionRef, deadline, signal))) {
                throw new Error("the switch was cancelled");
              }
              const { operationId } = current!;
              const old = pane!;
              current = undefined;
              pane = undefined;
              dropTurn();
              // In the old pane's place, which closes with the harness in it.
              try {
                pane = await placing.replace(old, paneRequest(deadline, signal));
              } catch (error) {
                // One whose old pane would not close keeps it, for close to try again.
                pane = placing.paneOf(request.key);
                throw error;
              }
              settings = launchSettings(next);
              const failed = await launchPane(sessionRef, operationId, deadline, signal);
              if (failed) throw new Error(failed.detail ?? "its harness did not start again");
            });
          };

          /** Ends the active wait on the agent, leaving the agent, and its pane, as they are. */
          const stopWaiting = () => active.stop();

          /**
           * The harness's own fork of the session the pane's harness named, run beside the pane
           * once its agent has settled and, where the usage reader can tell, its session's last
           * turn is written, so the copy holds it.
           */
          const forkPane = async (
            sessionRef: string,
            deadline: { unixMilliseconds: number },
            into?: SessionCopy,
          ): Promise<NativeFork> => {
            if (closed) throw new Error("Herdr run session is closed");
            if (!current) {
              throw new Error(
                placement === undefined
                  ? "this agent has had no turn in this attempt, so it has no pane to fork from yet; fork it after its first turn"
                  : "this agent's pane was closed, so its session cannot be forked",
              );
            }
            refuseSandboxedFork(request.occupant !== undefined, into);
            return active.run(async (signal) => {
              const busy = await settle(current!.agentName, deadline, signal);
              if (busy) throw new Error(`the agent did not settle before its fork: ${busy.detail}`);
              if (!(await untilWritten(sessionRef, deadline, signal))) {
                throw new Error("the fork was cancelled");
              }
              return await forkOrCopy(
                harness,
                {
                  home: request.home ?? harnessState()[harness],
                  session: sessionRef,
                  cwd: request.cwd,
                },
                into,
                () => runFork(sessionRef, deadline, signal),
              );
            });
          };

          const backend: ActivatedSessionBackend = {
            ...(confirmsDelivery
              ? {
                  confirmsDelivery: true as const,
                  async finishAnswered(deadline: {
                    unixMilliseconds: number;
                  }): Promise<NativeTurnOutcome> {
                    const live = current;
                    const stopOriginal = active.stopperForNow();
                    if (!live) return releaseDeadlineExceeded();
                    return observeRelease(
                      deadline.unixMilliseconds,
                      receiptObservers,
                      async (signal, remaining) => {
                        let outcome: Pick<NativeTurnOutcome, "state" | "detail">;
                        let named: string | undefined;
                        const recorded = turn;
                        if (recorded?.accepted && !recordSpeaks(recorded)) {
                          // Sent without Herdr's wait, which may never have seen it.
                          return localOutcome("failed", "native release was not confirmed");
                        }
                        if (recordSpeaks(recorded)) {
                          const ended = await untilEnded(
                            recorded,
                            deadline.unixMilliseconds,
                            signal,
                          );
                          if ("outcome" in ended) {
                            if (ended.outcome.state === "timed-out")
                              return localOutcome("timed-out", "pane operation timed out");
                            outcome = ended.outcome;
                          } else {
                            outcome = ended.settled;
                            named = ended.session;
                          }
                        } else {
                          const ended = await waitForTurnEnd(
                            herdr,
                            live.agentName,
                            deadline.unixMilliseconds,
                            remaining,
                            signal,
                          );
                          if ("failed" in ended) return ended.failed;
                          outcome = settledOutcome(ended.agent);
                          named = readSessionRef(ended.agent);
                        }
                        if (signal.aborted || current !== live || outcome.state !== "completed") {
                          return localOutcome("failed", "native release was not confirmed");
                        }
                        await stopOriginal();
                        const sessionRef =
                          named ??
                          (await spec.findSession?.(
                            live.operationId,
                            launchedAt,
                            request.cwd,
                            request.home,
                          ));
                        return releasedOutcome(outcome, sessionRef);
                      },
                    );
                  },
                }
              : {}),
            identity: { sessionId: continued ?? randomUUID(), cwd: request.cwd },
            // A box's pane is placed by its sandbox, not by a layout.
            ...(terminal && terminal.herdr !== "run"
              ? {}
              : {
                  pane: () => {
                    const placed = pane?.report ?? placement;
                    return placed && { ...placed, ...fate };
                  },
                }),
            screen: () => readScreen(),
            ...(spec.forkSession ? { fork: forkPane } : {}),
            ...(spec.setPane && spec.interactiveResume ? { set: relaunchAt } : {}),
            // The pane's agent is the session: an answered turn is left to end in it, and the next
            // operation is prompted into the same pane once it has.
            finishesAnswered: true,
            // Still working past its grace, an answered agent is interrupted, as a headless one's
            // process is stopped: it would otherwise spend, and change files, until the run ends.
            // Escape stops a claude, codex or pi turn and leaves the session; an idle agent is left
            // alone, since a second Escape opens codex's history.
            async stopFinishing() {
              const stopped = await stopWaiting();
              const agentName = current?.agentName;
              if (!agentName) return stopped;
              await interrupt(agentName);
              return stopped;
            },
            async execute(operation) {
              if (closed) throw new Error("Herdr run session is closed");
              released = false;
              closedScreen = undefined;
              return active.run(async (signal) => {
                const operationId =
                  operation.binding?.operationId ?? `internal:${request.key}:${operation.id}`;
                if (operation.kind === "compact") {
                  if (!spec.compactPane) {
                    return localOutcome(
                      "failed",
                      `${harness} has no compaction of its own: ${spec.absent.compactPane}`,
                    );
                  }
                  if (!current) {
                    return localOutcome(
                      "failed",
                      hasExecuted
                        ? "this agent's pane was closed, so its session cannot be compacted"
                        : "there is nothing to compact before the first turn",
                    );
                  }
                }
                if (!current) {
                  // A pane is closed only when a cancelled harness would not settle, or one failed
                  // to start, and its agent's session went with it: a close proves no process gone,
                  // so the session is not reopened (ADR 0008).
                  if (hasExecuted) {
                    return localOutcome(
                      "failed",
                      "this agent's pane was closed, so its session cannot be continued",
                    );
                  }
                  const failed = await launchPane(
                    continued,
                    operationId,
                    operation.deadline,
                    signal,
                    operation.onSession,
                  );
                  if (failed) return failed;
                  hasExecuted = true;
                } else {
                  // Herdr's prompt wait does not track turns: prompted while the last turn is still
                  // going, it could match that turn's end. So the agent settles first (E8).
                  current.operationId = operationId;
                  const idle = await settle(
                    current.agentName,
                    operation.deadline,
                    operation.deliverySignal
                      ? AbortSignal.any([signal, operation.deliverySignal])
                      : signal,
                  );
                  if (idle) return idle;
                }

                const live = current!;
                // A prompt its last operation gave up on, still in its input, would be sent with
                // what is typed now: none is typed while it is there.
                if (await stillHeld(live.agentName, turn, signal)) {
                  return localOutcome("failed", "its last prompt is still unsent in its input");
                }
                if (operation.kind === "compact") {
                  // A compaction is no recorded turn: Herdr settles what follows it.
                  dropTurn();
                  // Its prompts wait through Herdr, which may not yet show the last turn's end,
                  // its record's: that end would match the wait before the compaction ran.
                  const shown = await herdrCaughtUp(
                    live.agentName,
                    operation.deadline.unixMilliseconds,
                    signal,
                  );
                  if (shown) return shown;
                  return await compactInPane(live.agentName, operation, signal);
                }
                let prompt = instructed(operation.prompt);
                const remainingMs = operation.deadline.unixMilliseconds - Date.now();
                if (remainingMs <= 0) {
                  return deadlineExceeded();
                }
                const waitMs = Math.max(1, remainingMs);
                const marker = `[awf-delivery:${randomUUID()}]`;

                const dispatchSignal = operation.deliverySignal
                  ? AbortSignal.any([operation.deliverySignal, signal])
                  : signal;
                let watching: Awaited<ReturnType<typeof prepareTurnRecord>> | undefined;
                const resumed = operation.previousSessionRef ?? continued;
                try {
                  watching = turnRecord
                    ? await prepareTurnRecord(
                        await turnPlace(turnRecord, resumed),
                        marker,
                        () => turnRecord.reducer(marker, spec.promptLead),
                        { signal: dispatchSignal },
                      )
                    : undefined;
                } catch (error) {
                  if (operation.deliverySignal?.aborted || signal.aborted)
                    return localOutcome("cancelled", "check-in cancelled before dispatch");
                  const reason = reasonOf(error);
                  // A delivery confirmed by its record cannot go without it; a turn can, on Herdr.
                  if (operation.onReceived) {
                    operation.onDeliveryFailed?.(reason);
                    return localOutcome("failed", reason);
                  }
                }
                if (operation.deliverySignal?.aborted || signal.aborted) {
                  return localOutcome("cancelled", "check-in cancelled before dispatch");
                }
                if (Date.now() >= operation.deadline.unixMilliseconds) {
                  return localOutcome("timed-out", "operation expired before dispatch");
                }
                let recorded: RecordedTurn | undefined;
                if (watching && turnRecord) {
                  prompt = `${marker} ${prompt}`;
                  recorded = observeTurn(
                    watching,
                    turnRecord,
                    operation,
                    signal,
                    marker,
                    live.agentName,
                  );
                } else {
                  dropTurn();
                  const busy = await herdrCaughtUp(
                    live.agentName,
                    operation.deadline.unixMilliseconds,
                    signal,
                  );
                  if (busy) return busy;
                }
                operation.onDispatched?.();
                const sent = await submitPrompt(
                  herdr,
                  live.agentName,
                  live.paneId,
                  prompt,
                  spec.promptLead,
                  waitMs,
                  signal,
                  !recorded,
                );
                if (!sent.ok) {
                  if (sent.cancelled || signal.aborted) {
                    return paneCancelled();
                  }
                  // A harness that cannot sign in ends the turn before Herdr sees it working,
                  // which Herdr calls a stall; waiting it out would spend the whole deadline.
                  const login = await loginShown(
                    herdr,
                    harness,
                    live.paneId,
                    config.commandTimeoutMs,
                    signal,
                    operation.binding?.operationId,
                  );
                  if (signal.aborted) {
                    return paneCancelled();
                  }
                  if (login) return login;
                }
                let settled: Pick<NativeTurnOutcome, "state" | "detail">;
                let session: string | undefined;
                if (!recorded) {
                  if (!sent.ok) {
                    if (!hasHerdrErrorCode(sent.error, "agent_prompt_stalled")) {
                      return herdrFailure(sent, remainingMs);
                    }
                    return waitOutStalledPrompt(operation.deadline.unixMilliseconds, signal);
                  }
                  ({ settled, session } = herdrSettled(harness, sent));
                } else {
                  // Herdr answered an error, so it said what it did, and sent nothing that runs;
                  // one that never answered, saw no turn start, or lost a live agent a moment
                  // under load may have pasted the prompt, which the record says.
                  if (
                    !sent.ok &&
                    !sent.timedOut &&
                    !hasHerdrErrorCode(sent.error, "agent_prompt_stalled") &&
                    !hasHerdrErrorCode(sent.error, "agent_not_found")
                  ) {
                    dropTurn();
                    return herdrFailure(sent, remainingMs);
                  }
                  // A busy claude drops the Enter after a paste, leaving the prompt unsent in its
                  // input: pressed once more, only while the record shows it untaken and the
                  // screen shows it there on two polls running, since a loaded screen lags its
                  // record. A harness that cannot sign in takes nothing.
                  let pressed = false;
                  let heldBefore = false;
                  const untaken = async () => {
                    const read = await herdr(
                      ["agent", "read", live.agentName, "--source", "detection"],
                      config.commandTimeoutMs,
                      signal,
                    );
                    const shown = read.ok ? read.stdout : undefined;
                    const login = await loginShown(
                      herdr,
                      harness,
                      live.paneId,
                      config.commandTimeoutMs,
                      signal,
                      operation.binding?.operationId,
                      shown,
                    );
                    if (login) return login;
                    const held =
                      shown !== undefined &&
                      !recorded.accepted &&
                      spec.heldPrompt?.(shown, marker) === true;
                    const press = held && heldBefore && !pressed;
                    heldBefore = held;
                    if (press) {
                      pressed = true;
                      await herdr(
                        ["agent", "send-keys", live.agentName, "enter"],
                        config.commandTimeoutMs,
                        signal,
                      );
                    }
                    return undefined;
                  };
                  const ended = await untilEnded(
                    recorded,
                    operation.deadline.unixMilliseconds,
                    signal,
                    untaken,
                  );
                  if ("outcome" in ended) {
                    // A prompt never taken in is read no more once its operation is over: a cancel
                    // still settles it. The prompt its harness may still hold is looked for before
                    // the next is typed, and at release.
                    if (!recorded.accepted && ended.outcome.state !== "cancelled") recorded.stop();
                    return ended.outcome;
                  }
                  settled = ended.settled;
                  session = ended.session;
                }
                const read = await herdr(
                  ["agent", "read", live.agentName, "--source", "detection"],
                  Math.max(1, operation.deadline.unixMilliseconds - Date.now()),
                  signal,
                );
                if (!read.ok && read.cancelled) {
                  return paneCancelled();
                }
                const outcome = paneOutcome(
                  harness,
                  settled,
                  session,
                  read,
                  await loginShown(
                    herdr,
                    harness,
                    live.paneId,
                    config.commandTimeoutMs,
                    signal,
                    operation.binding?.operationId,
                    read.ok ? read.stdout : "",
                  ),
                );
                // A session named by its file, a pi fork's, keeps that name: the id Herdr reports
                // for it is its parent's (F6), which a relaunch or a fork would resume instead.
                if (operation.previousSessionRef && isAbsolute(operation.previousSessionRef)) {
                  return { ...outcome, sessionRef: operation.previousSessionRef };
                }
                if (outcome.sessionRef || !spec.findSession || !operation.binding) return outcome;
                // A harness that names its session to nobody is found by this operation's id.
                const found =
                  operation.previousSessionRef ??
                  (await spec.findSession(
                    operation.binding.operationId,
                    launchedAt,
                    request.cwd,
                    request.home,
                  ));
                return found ? { ...outcome, sessionRef: found } : outcome;
              });
            },
            async cancel() {
              for (const observer of receiptObservers) observer.abort();
              if (!active.running && !current) return false;
              await active.stop();
              // Interrupted and settled, its harness stays the agent's: the next operation is
              // prompted into it, as one after an answered turn stopped past its grace is. The same
              // process goes on, so no session is reopened. One that won't settle is closed.
              const why = current && pane ? await release(current.agentName) : "it has no pane";
              if (!why) {
                released = true;
                return true;
              }
              if (mayKeep) fate = { notKept: why };
              await closeCurrentPane();
              return true;
            },
            async close(_reason, options) {
              if (closed) return;
              for (const observer of receiptObservers) observer.abort();
              await active.stop();
              if (options?.keep) {
                const kept = pane;
                const why =
                  fate.notKept ??
                  (current && kept
                    ? await release(current.agentName)
                    : "its harness never started");
                if (!why && kept && pane === kept && (await placing.keep(kept))) {
                  fate = { kept: true };
                  dropTurn();
                  closed = true;
                  return;
                }
                fate = { notKept: why ?? "its pane closed" };
              }
              await closeCurrentPane();
              closed = true;
            },
          };
          return backend;
        },
      });
      const inner = await createSingleSessionHostFactory(adapter).openRun(runSpec);
      let closeAttempt: Promise<void> | undefined;
      let workspaceClosed = false;
      let hostState: "running" | "closing" | "closed" = "running";
      return {
        openAgent: (request) => inner.openAgent(request),
        inspect: () => ({ ...inner.inspect(), state: hostState }),
        async close(reason) {
          if (workspaceClosed) return;
          closeAttempt ??= (async () => {
            hostState = "closing";
            const failures: Error[] = [];
            await inner.close(reason).catch((error: unknown) => failures.push(asError(error)));
            unwatch.abort();
            await Promise.all(watching);
            // A box's Herdr ends with its box, which the engine removes after this host closes,
            // so failing to close its workspace leaves nothing behind.
            await Promise.all(
              [...boxes.values()].map((opening) =>
                opening.then((box) => box.screen.closeAll()).catch(() => undefined),
              ),
            );
            // Another session's panes are closed one by one; a session gone took them with it.
            const others = await Promise.all(
              [...screens.values()].map((screen) => screen.closeAll()),
            );
            for (const failed of others) if (failed) failures.push(new Error(failed));
            const failed = await runScreen.closeAll();
            if (failed) failures.push(new Error(failed));
            if (failures.length === 0) {
              workspaceClosed = true;
              hostState = "closed";
            }
            if (failures.length > 0) {
              throw new AggregateError(failures, "Herdr run host cleanup failed");
            }
          })();
          try {
            await closeAttempt;
          } finally {
            if (!workspaceClosed) closeAttempt = undefined;
          }
        },
      };
    },
  };
}

/** What Herdr's settled agent says of a turn: its status, and its session where it is the pane's. */
function herdrSettled(harness: Harness, sent: Extract<HerdrResult, { ok: true }>) {
  const agent = reportedAgent(sent.result);
  return {
    settled: settledOutcome(agent),
    session: harnessSpec(harness).herdrSessionIsOwn ? readSessionRef(agent) : undefined,
  };
}
/**
 * What the pane itself proves about a settled turn: how it ended, the transcript the harness spec
 * can read out of the screen, and the native session, when one is named.
 */
function paneOutcome(
  harness: Harness,
  settled: Pick<NativeTurnOutcome, "state" | "detail">,
  /** The session the turn ran in, as Herdr or the harness's record names it. */
  session: string | undefined,
  read: HerdrResult,
  /** What the screen shows of a login the harness lacks; see `loginShown`. */
  login: NativeTurnOutcome | undefined,
): NativeTurnOutcome {
  const spec = harnessSpec(harness);
  const rawTranscript = read.ok && read.stdout.trim() !== "" ? read.stdout : null;
  const transcript = rawTranscript ? (spec.readTranscript?.(rawTranscript) ?? rawTranscript) : null;
  const nativeSession =
    session ?? (rawTranscript ? spec.readSessionId?.(rawTranscript) : undefined);
  return {
    ...(login ? { state: login.state, detail: login.detail, login: login.login } : settled),
    resultEvidence: transcript ? { kind: "transcript", text: transcript } : { kind: "unavailable" },
    ...(nativeSession ? { sessionRef: nativeSession } : {}),
    // The screen is no record of spend; the engine reads the session files when the run ends.
    reportedCostsUsd: [],
  };
}

/** Enough of a pane's scrollback to hold a turn's prompt, its schema included, and what followed. */
const LOGIN_READ_LINES = 400;

/**
 * The failed turn a pane's screen shows when its harness cannot sign in: at a launch that stopped
 * at a sign-in screen or exited, as codex and cursor do, after a prompt that failed or stalled,
 * which pi's refused login does before Herdr sees it working, or after a settled turn. `shown`, a
 * read already made, settles it unless it shows a login line and not the prompt carrying `marker`,
 * which a long schema can push out of it: then the scrollback is read.
 */
async function loginShown(
  herdr: HerdrCommand,
  harness: Harness,
  paneId: string,
  commandTimeoutMs: number,
  signal: AbortSignal,
  /** The operation's id, where a prompt carrying it was sent. */
  marker?: string,
  shown?: string,
): Promise<NativeTurnOutcome | undefined> {
  const check = harnessSpec(harness).login;
  if (!check) return undefined;
  const failed = (screen: string): NativeTurnOutcome | undefined => {
    const login = failedOnLogin(harness, check, (it) => it.screen(thisTurn(screen, marker)));
    return login && { ...login, resultEvidence: { kind: "unavailable" }, reportedCostsUsd: [] };
  };
  if (shown !== undefined) {
    const screen = readable(shown);
    if (marker === undefined || screen.includes(marker) || !check.screen(screen)) {
      return failed(screen);
    }
  }
  const read = await herdr(
    ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(LOGIN_READ_LINES)],
    commandTimeoutMs,
    signal,
  );
  if (signal.aborted || !read.ok) return undefined;
  return failed(readable(read.stdout));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
