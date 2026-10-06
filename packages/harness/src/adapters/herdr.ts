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
import { sandboxedArgs } from "../sandbox-needs";
import { readable } from "../screen";
import {
  type ActivatedSessionBackend,
  createSessionAdapter,
  localOutcome,
  type NativeTurnOutcome,
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
import type { Harness } from "../types";
import { createSessionAccounting } from "../usage/accounting";
import { prepareClaudeReceipt } from "./claude-receipt";
import { copySession, FORK_ACTIVATION_MS, forkCommand, forkDeadline, forkResult } from "./fork";
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
  emptyEnvironmentArgs,
  HERDR_REPORT_GRACE_MS,
  type HerdrCommand,
  type HerdrResult,
  hasHerdrErrorCode,
  herdrFailure,
  readId,
  readPaneId,
  readSessionRef,
  reportedAgent,
  safeAgentName,
  settleAgent,
  settledOutcome,
  submitPrompt,
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
  /**
   * At a sandbox's first pane agent, open a tab in the run's workspace attached to the sandbox's
   * own Herdr, so its panes show beside the run's.
   */
  watchSandboxes?: boolean;
  /**
   * Told the run's workspace id once it exists, before any agent opens in it, so an engine can
   * tell its workspace from another of the same label.
   */
  onRunWorkspace?: (workspaceId: string) => Promise<void>;
  /**
   * Whether a session a layout names can be used: undefined when it can, else why not. Absent,
   * none but the run's can.
   */
  sessionFor?: (session: string) => Promise<string | undefined>;
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
      if (started.ok) return startedAfter(attempt);
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

  /**
   * Types `text` into a fresh tab's login shell once it has settled, every call ending by `by`.
   * Undefined once cancelled.
   */
  const typeInto = async (paneId: string, text: string, by: number, signal?: AbortSignal) => {
    const call = (args: string[]) =>
      herdr(args, Math.max(1, Math.min(config.commandTimeoutMs, by - Date.now())), signal);
    const screen = async () => {
      const read = await call(["pane", "read", paneId]);
      return read.ok ? read.stdout : "";
    };
    // If the text is swallowed nonetheless, what it should show never does.
    if (!(await settle(screen, Math.min(by, Date.now() + TYPED_START_SETTLE_MS), signal))) {
      return undefined;
    }
    return call(["pane", "run", paneId, text]);
  };

  /** Types `argv`, quoted, into a fresh tab's login shell. */
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
    const remaining = () => deadlineUnixMs - Date.now();
    const step = () => Math.min(deadlineUnixMs, Date.now() + TYPED_START_WAIT_MS);
    const call = (args: string[]) =>
      herdr(args, Math.max(1, Math.min(config.commandTimeoutMs, remaining())), signal);
    const screen = async () => {
      const read = await call(["pane", "read", paneId]);
      return read.ok ? read.stdout : "";
    };
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
    const drawn = findHarness(kind)?.paneReady;
    if (drawn) {
      let shown = false;
      for (const limit = step(); !shown && Date.now() < limit; ) {
        shown = readable(await screen()).includes(drawn);
        if (!shown && !(await abortableDelay(TYPED_START_POLL_MS, signal))) return cancelled();
      }
      if (!shown) {
        return failed(
          `${kind} never showed it was ready: ${readable(await screen()).slice(-300)}`,
          {
            timedOut: true,
          },
        );
      }
    }
    return startedAfter(1);
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
          if (remaining() <= 0) return localOutcome("timed-out", "operation deadline exceeded");
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
                : await loginShown(herdr, harness, paneId, config, controller.signal);
              if (controller.signal.aborted || started.cancelled) {
                return localOutcome("cancelled", "pane operation cancelled");
              }
              return (
                login ??
                localOutcome(
                  started.timedOut || remaining() <= 0 ? "timed-out" : "failed",
                  `agent start failed after ${started.attempts}: ${started.error}`,
                )
              );
            }
            if (remaining() <= 0) return localOutcome("timed-out", "operation deadline exceeded");
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
                    config,
                    controller.signal,
                    operation.binding?.operationId,
                  );
              if (sent.cancelled || controller.signal.aborted) {
                return localOutcome("cancelled", "pane operation cancelled");
              }
              return login ?? herdrFailure(sent, remaining());
            }
            if (remaining() <= 0) return localOutcome("timed-out", "operation deadline exceeded");
            const read = await herdr(
              ["agent", "read", name, "--source", "detection"],
              Math.max(1, remaining()),
              controller.signal,
            );
            if (!read.ok && read.cancelled) {
              return localOutcome("cancelled", "pane operation cancelled");
            }
            const outcome = paneOutcome(
              harness,
              sent,
              read,
              await loginShown(
                herdr,
                harness,
                paneId,
                config,
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

/** The production host: one run workspace, with a tab for each agent. */
export function createHerdrRunHostFactory(
  config: HerdrConfig,
  run: RunProcess = runProcess,
): AgentRunHostFactory {
  /**
   * Every tab launches its own process, so the workspace's environment does not reach it and the
   * metered credentials this run promises to withhold would survive in an agent pane. Nothing the
   * return channel needs is repeated here: a tab inherits its `PATH` from the login shell Herdr
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
      /** The other sessions this run's panes open in, by name: named ones, and `"origin"`'s. */
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
      /** Each named session's answer, asked once a run. */
      const usable = new Map<string, Promise<string | undefined>>();
      let origin: Promise<{ screen: PaneScreen; workspaceId: string } | string> | undefined;
      const runLayout = createPaneLayout({
        run: runScreen,
        runLabel: label,
        session: async (name) => {
          if (name === config.session) return runScreen;
          let answer = usable.get(name);
          if (!answer) {
            answer = config.sessionFor
              ? config.sessionFor(name).catch((error: unknown) => asError(error).message)
              : Promise.resolve(`session ${name} is not one this host can use`);
            usable.set(name, answer);
          }
          const why = await answer;
          return why === undefined ? sessionScreen(name) : `session ${name} can't be used: ${why}`;
        },
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
      // A sandbox's own Herdr, by its key: opened at its first pane agent, closed with the run.
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
            return { screen, layout: createPaneLayout({ run: screen, runLabel: label }) };
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
        harnesses: PLACEMENT_HARNESSES.pane,
        placement: "pane",
        launchesInSandbox: true,
        givesSkills: true,
        continues: true,
        async activate(request) {
          const harness = knownHarness(request.execution.harness);
          const spec = harnessSpec(harness);
          const { continues } = request;
          if (continues && !spec.interactiveResume) {
            throw new Error(
              `${harness} panes cannot continue a forked session: ${spec.absent.interactiveResume}`,
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
              launchArgs: [
                ...(request.occupant ? sandboxedArgs(harness) : []),
                ...(skills?.args ?? []),
              ],
            });
            const command = forkCommand(plan, {
              cwd: request.cwd,
              env: { ...skills?.env },
              deadline,
              signal,
            });
            const { holdStdinUntil, ...process } = command;
            const result = await (request.occupant
              ? run({ ...request.occupant.launch(process), holdStdinUntil })
              : forkRun(command));
            return forkResult(harness, plan, result, deadline);
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
            cwd: request.cwd,
            ...(skills ? { env: skills.env } : {}),
            deadlineUnixMs: deadline.unixMilliseconds,
            ...(signal ? { signal } : {}),
          });
          /**
           * Its pane, placed now so the workflow's order is the screen's, and any agent open is
           * there to split; absent once closed.
           */
          let pane: PlacedPane | undefined = await placing.place(paneRequest(request.deadline));
          // The session its pane is in, which a pane placed again may change.
          let commands = pane.screen.commands;
          const herdr: HerdrCommand = (...args) => commands.herdr(...args);
          const startAgent: HerdrCommands["startAgent"] = (...args) => commands.startAgent(...args);
          const adoptAgent: HerdrCommands["adoptAgent"] = (...args) => commands.adoptAgent(...args);
          /** Where it was placed: kept once its pane closes, for the record. */
          let placement = pane.report;
          let current:
            | {
                operationId: string;
                paneId: string;
                agentName: string;
              }
            | undefined;
          let closed = false;
          let hasExecuted = false;
          /**
           * Why it is done though its pane is open: a cancel left a pane that may be kept for
           * `close` to decide on. It is not driven again (ADR 0008).
           */
          let done: string | undefined;
          const mayKeep = request.keepPane === "always" || request.keepPane === "on-failure";
          /** Whether its pane was kept when it was done, or why not. */
          let fate: Pick<PanePlacement, "kept" | "notKept"> = {};

          /** Interrupts its harness if it is working, as an answered turn left too long is. */
          const interrupt = async (agentName: string): Promise<boolean> => {
            const got = await herdr(["agent", "get", agentName]);
            if (!got.ok) return false;
            if (reportedAgent(got.result).agent_status === "working") {
              await herdr(["agent", "send-keys", agentName, "esc"]);
            }
            return true;
          };

          /**
           * Readies its harness to be left in a kept pane: interrupted if working, and settled, so a
           * kept agent goes on editing nothing. Why not, where it is gone or would not settle.
           */
          /** Its harness was released by a cancel already: a second Escape opens codex's history. */
          let released = false;
          const release = async (agentName: string): Promise<string | undefined> => {
            if (released) return undefined;
            if (!(await interrupt(agentName))) return "its harness is gone";
            const busy = await settleAgent(
              herdr,
              agentName,
              Date.now() + KEEP_SETTLE_MS,
              AbortSignal.timeout(KEEP_SETTLE_MS + HERDR_REPORT_GRACE_MS),
            );
            return busy && busy.state !== "blocked"
              ? `its harness did not settle after an interrupt: ${busy.detail ?? busy.state}`
              : undefined;
          };
          /** When its harness was launched: a session it names to nobody started since. */
          let launchedAt = Date.now();
          /** The workflow's instructions go with the first prompt the pane's agent is sent. */
          let instructed = false;
          let activeController: AbortController | undefined;
          let activeCompletion: Promise<void> | undefined;
          // A run-local sandbox pane preserves the host cwd and seeded harness home.
          const confirmsDelivery =
            harness === "claude" &&
            (!request.occupant || (terminal?.herdr === "run" && request.home !== undefined));
          const receiptObservers = new Set<AbortController>();

          const closeCurrentPane = async (): Promise<void> => {
            const closing = pane;
            if (!closing) return;
            await placing.close(closing);
            if (pane === closing) {
              pane = undefined;
              current = undefined;
            }
          };

          const settle = (
            agentName: string,
            deadline: { unixMilliseconds: number },
            signal: AbortSignal,
          ) => settleAgent(herdr, agentName, deadline.unixMilliseconds, signal);

          /**
           * The harness's own compaction, typed into the pane as `spec.compactPane` says, each
           * prompt once the agent has settled. Neither Herdr's status nor any `wf result` says it
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
            const readScreen = () =>
              herdr(
                ["agent", "read", agentName, "--source", "recent-unwrapped", "--lines", "200"],
                Math.max(1, remaining()),
                signal,
              );
            let before = "";
            if (compaction.ended) {
              const read = await readScreen();
              if (!read.ok) {
                return read.cancelled || signal.aborted
                  ? localOutcome("cancelled", "pane operation cancelled")
                  : localOutcome("failed", `the pane could not be read: ${read.error}`);
              }
              before = read.stdout;
            }
            let agent: Record<string, unknown> | undefined;
            for (const [index, text] of compaction.prompts(operation.prompt).entries()) {
              if (index > 0) {
                const idle = await settle(agentName, operation.deadline, signal);
                if (idle) return idle;
              }
              const waitMs = remaining();
              if (waitMs <= 0) return localOutcome("timed-out", "operation deadline exceeded");
              const sent = await herdr(
                ["agent", "prompt", agentName, text, "--wait", "--timeout", String(waitMs)],
                waitMs + HERDR_REPORT_GRACE_MS,
                signal,
              );
              if (!sent.ok) {
                if (sent.cancelled || signal.aborted) {
                  return localOutcome("cancelled", "pane operation cancelled");
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
            let read = await readScreen();
            while (read.ok && compaction.ended && !compaction.ended(read.stdout, before)) {
              // Herdr sees the agent idle, so nothing else would stop a compaction left running.
              const interrupt = () => herdr(["agent", "send-keys", agentName, "esc"]);
              if (remaining() <= 0) {
                await interrupt();
                return localOutcome("timed-out", "operation deadline exceeded");
              }
              if (!(await abortableDelay(COMPACTION_POLL_MS, signal))) {
                await interrupt();
                return localOutcome("cancelled", "pane operation cancelled");
              }
              read = await readScreen();
            }
            if (!read.ok) {
              return read.cancelled || signal.aborted
                ? localOutcome("cancelled", "pane operation cancelled")
                : localOutcome("failed", `the pane could not be read: ${read.error}`);
            }
            const evidence = { kind: "transcript" as const, text: read.stdout };
            if (!compaction.compacted(read.stdout, operation.prompt, before)) {
              return {
                state: "failed",
                detail: `${harness} shows no compaction: ${readable(read.stdout).trim().slice(-300)}`,
                resultEvidence: evidence,
                chargesUsd: [],
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
              chargesUsd: [],
              summary: summary ?? "",
            };
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
          ): Promise<NativeTurnOutcome | undefined> => {
            // A first start that failed closed its pane; one never started may be placed again.
            if (!pane) {
              try {
                pane = await placing.place(paneRequest(deadline, signal));
                placement = pane.report;
                commands = pane.screen.commands;
              } catch (error) {
                if (signal.aborted) {
                  return localOutcome("cancelled", "pane operation cancelled");
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
            const launchArgs = [
              ...(request.occupant ? sandboxedArgs(harness) : []),
              ...(skills?.args ?? []),
            ];
            const launch = resume
              ? spec.interactiveResume!(resume, settings, launchArgs)
              : spec.interactive(settings, launchArgs);
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
                  : await loginShown(herdr, harness, paneId, config, signal);
              await closeCurrentPane().catch(() => undefined);
              // A pane that would not close holds no agent to drive.
              current = undefined;
              if (signal.aborted || started.cancelled) {
                return localOutcome("cancelled", "pane operation cancelled");
              }
              return (
                login ??
                localOutcome(
                  started.timedOut ? "timed-out" : "failed",
                  `agent start failed after ${started.attempts}: ${started.error}`,
                )
              );
            }
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
            if (done) throw new Error(done);
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
            const controller = new AbortController();
            activeController = controller;
            let finish!: () => void;
            activeCompletion = new Promise<void>((resolve) => {
              finish = resolve;
            });
            try {
              const busy = await settle(current.agentName, deadline, controller.signal);
              if (busy)
                throw new Error(`the agent did not settle before its switch: ${busy.detail}`);
              // Its harness is stopped with its pane: the session's last turn must be in it first.
              if (!(await untilWritten(sessionRef, deadline, controller.signal))) {
                throw new Error("the switch was cancelled");
              }
              const { operationId } = current;
              const old = pane!;
              current = undefined;
              pane = undefined;
              // In the old pane's place, which closes with the harness in it.
              try {
                pane = await placing.replace(old, paneRequest(deadline, controller.signal));
              } catch (error) {
                // One whose old pane would not close keeps it, for close to try again.
                pane = placing.paneOf(request.key);
                throw error;
              }
              settings = launchSettings(next);
              const failed = await launchPane(sessionRef, operationId, deadline, controller.signal);
              if (failed) throw new Error(failed.detail ?? "its harness did not start again");
            } finally {
              if (activeController === controller) activeController = undefined;
              finish();
            }
          };

          /** Ends the active wait on the agent, leaving the agent, and its pane, as they are. */
          const stopWaiting = async (): Promise<boolean> => {
            if (!activeController) return false;
            activeController.abort();
            await activeCompletion;
            return true;
          };

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
            if (done) throw new Error(done);
            if (!current) {
              throw new Error("this agent's pane was closed, so its session cannot be forked");
            }
            if (request.occupant && !into) {
              throw new Error("a sandboxed agent's session is forked by copy");
            }
            const controller = new AbortController();
            activeController = controller;
            let finish!: () => void;
            activeCompletion = new Promise<void>((resolve) => {
              finish = resolve;
            });
            try {
              const busy = await settle(current.agentName, deadline, controller.signal);
              if (busy) throw new Error(`the agent did not settle before its fork: ${busy.detail}`);
              if (!(await untilWritten(sessionRef, deadline, controller.signal))) {
                throw new Error("the fork was cancelled");
              }
              // A home of its own is carried whole; the new agent forks it in its own.
              if (into) {
                return await copySession(
                  harness,
                  request.home ?? harnessState()[harness],
                  sessionRef,
                  request.cwd,
                  into,
                );
              }
              return await runFork(sessionRef, deadline, controller.signal);
            } finally {
              if (activeController === controller) activeController = undefined;
              finish();
            }
          };

          const backend: ActivatedSessionBackend = {
            ...(confirmsDelivery
              ? {
                  confirmsDelivery: true as const,
                  async finishAnswered(deadline: {
                    unixMilliseconds: number;
                  }): Promise<NativeTurnOutcome> {
                    const placement = current;
                    const originalController = activeController;
                    const originalCompletion = activeCompletion;
                    const remaining = deadline.unixMilliseconds - Date.now();
                    if (!placement || remaining <= 0)
                      return localOutcome("timed-out", "release deadline exceeded");
                    const observing = new AbortController();
                    receiptObservers.add(observing);
                    const timer = setTimeout(
                      () => observing.abort(),
                      Math.min(remaining, 2_147_483_647),
                    );
                    try {
                      const ended = await herdr(
                        ["agent", "wait", placement.agentName, "--timeout", String(remaining)],
                        remaining,
                        observing.signal,
                      );
                      if (!ended.ok)
                        return herdrFailure(ended, deadline.unixMilliseconds - Date.now());
                      const agent = reportedAgent(ended.result);
                      const outcome = settledOutcome(agent);
                      if (
                        observing.signal.aborted ||
                        current !== placement ||
                        outcome.state !== "completed"
                      ) {
                        return localOutcome("failed", "native release was not confirmed");
                      }
                      originalController?.abort();
                      await originalCompletion;
                      const sessionRef =
                        readSessionRef(agent) ??
                        (await spec.findSession?.(
                          placement.operationId,
                          launchedAt,
                          request.cwd,
                          request.home,
                        ));
                      return {
                        ...outcome,
                        resultEvidence: { kind: "unavailable" },
                        chargesUsd: [],
                        ...(sessionRef ? { sessionRef } : {}),
                      };
                    } finally {
                      clearTimeout(timer);
                      receiptObservers.delete(observing);
                    }
                  },
                }
              : {}),
            identity: { sessionId: continued ?? randomUUID(), cwd: request.cwd },
            // A box's pane is placed by its sandbox, not by a layout.
            ...(terminal && terminal.herdr !== "run"
              ? {}
              : { pane: () => ({ ...(pane?.report ?? placement), ...fate }) }),
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
              const got = await herdr(["agent", "get", agentName]);
              const agent = got.ok ? reportedAgent(got.result) : undefined;
              if (agent?.agent_status === "working") {
                await herdr(["agent", "send-keys", agentName, "esc"]);
              }
              return stopped;
            },
            async execute(operation) {
              if (closed) throw new Error("Herdr run session is closed");
              if (done) return localOutcome("failed", done);
              const controller = new AbortController();
              activeController = controller;
              let finish!: () => void;
              activeCompletion = new Promise<void>((resolve) => {
                finish = resolve;
              });
              try {
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
                  // A pane is closed only when an operation was cancelled or failed to start, and
                  // its agent's session went with it.
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
                    controller.signal,
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
                      ? AbortSignal.any([controller.signal, operation.deliverySignal])
                      : controller.signal,
                  );
                  if (idle) return idle;
                }

                const placement = current;
                if (!placement) throw new Error("operation pane was not retained");
                if (operation.kind === "compact") {
                  return await compactInPane(placement.agentName, operation, controller.signal);
                }
                // Only once: a later prompt reaches an agent that has already read these, and
                // sending them again reads as a new assignment rather than a reminder.
                let prompt =
                  !instructed && request.instructions
                    ? `${request.instructions}\n\n${operation.prompt}`
                    : operation.prompt;
                instructed = true;
                const remainingMs = operation.deadline.unixMilliseconds - Date.now();
                if (remainingMs <= 0) {
                  return localOutcome("timed-out", "operation deadline exceeded");
                }
                const waitMs = Math.max(1, remainingMs);
                const marker = `[awf-delivery:${randomUUID()}]`;
                let receipt: Awaited<ReturnType<typeof prepareClaudeReceipt>> | undefined;
                try {
                  receipt =
                    confirmsDelivery && operation.onReceived
                      ? await prepareClaudeReceipt(request.cwd, marker, request.home, {
                          sessionRef: operation.previousSessionRef ?? continued,
                          signal: operation.deliverySignal
                            ? AbortSignal.any([operation.deliverySignal, controller.signal])
                            : controller.signal,
                        })
                      : undefined;
                } catch (error) {
                  if (operation.deliverySignal?.aborted || controller.signal.aborted)
                    return localOutcome("cancelled", "check-in cancelled before dispatch");
                  const reason = error instanceof Error ? error.message : String(error);
                  operation.onDeliveryFailed?.(reason);
                  return localOutcome("failed", reason);
                }
                if (operation.deliverySignal?.aborted || controller.signal.aborted) {
                  return localOutcome("cancelled", "check-in cancelled before dispatch");
                }
                if (Date.now() >= operation.deadline.unixMilliseconds) {
                  return localOutcome("timed-out", "operation expired before dispatch");
                }
                if (receipt) {
                  prompt = `${marker} ${prompt}`;
                  const observing = new AbortController();
                  receiptObservers.add(observing);
                  const signal = AbortSignal.any([
                    observing.signal,
                    controller.signal,
                    ...(operation.receiptSignal ? [operation.receiptSignal] : []),
                  ]);
                  void receipt
                    .watch(
                      signal,
                      () => operation.onAccepted?.(),
                      () => operation.onReceived?.(),
                      undefined,
                      operation.receiptDeadline ?? (() => operation.deadline.unixMilliseconds),
                    )
                    .catch((error: unknown) =>
                      operation.onDeliveryFailed?.(
                        error instanceof Error ? error.message : String(error),
                      ),
                    )
                    .finally(() => receiptObservers.delete(observing));
                }
                operation.onDispatched?.();
                const sent = await submitPrompt(
                  herdr,
                  placement.agentName,
                  prompt,
                  waitMs,
                  controller.signal,
                );
                if (!sent.ok) {
                  if (sent.cancelled || controller.signal.aborted) {
                    return localOutcome("cancelled", "pane operation cancelled");
                  }
                  // A harness that cannot sign in ends the turn before Herdr sees it working,
                  // which Herdr calls a stall; waiting it out would spend the whole deadline.
                  const login = await loginShown(
                    herdr,
                    harness,
                    placement.paneId,
                    config,
                    controller.signal,
                    operation.binding?.operationId,
                  );
                  if (controller.signal.aborted) {
                    return localOutcome("cancelled", "pane operation cancelled");
                  }
                  if (login) return login;
                  if (hasHerdrErrorCode(sent.error, "agent_prompt_stalled")) {
                    // Herdr had already accepted the submission, so the turn may be running.
                    // Settling here would close the result slot under a live agent and arm the
                    // nudge; resending would duplicate a delivered prompt.
                    return (await abortableDelay(
                      Math.max(0, operation.deadline.unixMilliseconds - Date.now()),
                      controller.signal,
                    ))
                      ? localOutcome(
                          "timed-out",
                          "operation deadline exceeded after a stalled prompt observation",
                        )
                      : localOutcome("cancelled", "pane operation cancelled");
                  }
                  return herdrFailure(sent, remainingMs);
                }
                const read = await herdr(
                  ["agent", "read", placement.agentName, "--source", "detection"],
                  Math.max(1, operation.deadline.unixMilliseconds - Date.now()),
                  controller.signal,
                );
                if (!read.ok && read.cancelled) {
                  return localOutcome("cancelled", "pane operation cancelled");
                }
                const outcome = paneOutcome(
                  harness,
                  sent,
                  read,
                  await loginShown(
                    herdr,
                    harness,
                    placement.paneId,
                    config,
                    controller.signal,
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
              } finally {
                if (activeController === controller) activeController = undefined;
                finish();
              }
            },
            async cancel() {
              for (const observer of receiptObservers) observer.abort();
              if (!activeController && !current) return false;
              activeController?.abort();
              await activeCompletion;
              // One that may be kept is left for `close`, which knows whether it is.
              if (mayKeep && current && pane) {
                done = "this agent's operation was cancelled, so its session cannot be continued";
                // Released now, not at its close: it must not go on working meanwhile.
                const why = await release(current.agentName);
                if (why) {
                  fate = { notKept: why };
                  await closeCurrentPane();
                } else released = true;
                return true;
              }
              await closeCurrentPane();
              return true;
            },
            async close(_reason, options) {
              if (closed) return;
              for (const observer of receiptObservers) observer.abort();
              activeController?.abort();
              await activeCompletion;
              if (options?.keep) {
                const kept = pane;
                const why =
                  fate.notKept ??
                  (current && kept
                    ? await release(current.agentName)
                    : "its harness never started");
                if (!why && kept && pane === kept && (await placing.keep(kept))) {
                  fate = { kept: true };
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
            await Promise.all([...screens.values()].map((screen) => screen.closeAll()));
            const failed = await runScreen.closeAll();
            if (failed) failures.push(new Error(failed));
            else {
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

/**
 * What the pane itself proves about a settled turn: the agent's own status, the transcript the
 * harness spec can read out of the screen, and the native session Herdr names, when it does.
 */
function paneOutcome(
  harness: Harness,
  sent: Extract<HerdrResult, { ok: true }>,
  read: HerdrResult,
  /** What the screen shows of a login the harness lacks; see `loginShown`. */
  login: NativeTurnOutcome | undefined,
): NativeTurnOutcome {
  const spec = harnessSpec(harness);
  const rawTranscript = read.ok && read.stdout.trim() !== "" ? read.stdout : null;
  const transcript = rawTranscript ? (spec.readTranscript?.(rawTranscript) ?? rawTranscript) : null;
  const agent = reportedAgent(sent.result);
  const nativeSession =
    (spec.herdrSessionIsOwn ? readSessionRef(agent) : undefined) ??
    (rawTranscript ? spec.readSessionId?.(rawTranscript) : undefined);
  return {
    ...(login
      ? { state: login.state, detail: login.detail, login: login.login }
      : settledOutcome(agent)),
    resultEvidence: transcript ? { kind: "transcript", text: transcript } : { kind: "unavailable" },
    ...(nativeSession ? { sessionRef: nativeSession } : {}),
    // The screen is no record of spend; the engine reads the session files when the run ends.
    chargesUsd: [],
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
  config: HerdrConfig,
  signal: AbortSignal,
  /** The operation's id, where a prompt carrying it was sent. */
  marker?: string,
  shown?: string,
): Promise<NativeTurnOutcome | undefined> {
  const check = harnessSpec(harness).login;
  if (!check) return undefined;
  const failed = (screen: string): NativeTurnOutcome | undefined => {
    const login = failedOnLogin(harness, check, (it) => it.screen(thisTurn(screen, marker)));
    return login && { ...login, resultEvidence: { kind: "unavailable" }, chargesUsd: [] };
  };
  if (shown !== undefined) {
    const screen = readable(shown);
    if (marker === undefined || screen.includes(marker) || !check.screen(screen)) {
      return failed(screen);
    }
  }
  const read = await herdr(
    ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(LOGIN_READ_LINES)],
    config.commandTimeoutMs,
    signal,
  );
  if (signal.aborted || !read.ok) return undefined;
  return failed(readable(read.stdout));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
