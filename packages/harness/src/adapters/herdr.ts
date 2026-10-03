import { randomUUID } from "node:crypto";
import { type PaneHerdr, type PaneTerminal, shellQuote } from "@agentswf/sandbox";
import type { AgentRunHostFactory, AgentSessionAdapter, NativeFork } from "../adapter";
import { skillsLaunch } from "../capabilities/skills";
import { type RunProcess, runProcess, withholding } from "../command";
import { parseRow, record } from "../json";
import { sandboxedArgs } from "../sandbox-needs";
import {
  type ActivatedSessionBackend,
  createSessionAdapter,
  localOutcome,
  type NativeTurnOutcome,
} from "../session-core";
import { createSingleSessionHostFactory } from "../single-session-host";
import {
  HARNESS_NAMES,
  type HarnessSpec,
  harnessSpec,
  knownHarness,
  PLACEMENT_HARNESSES,
} from "../spec";
import { createSessionAccounting } from "../usage/accounting";
import { forkCommand, forkResult } from "./fork";
import {
  abortableDelay,
  emptyEnvironmentArgs,
  HERDR_REPORT_GRACE_MS,
  type HerdrCommand,
  type HerdrResult,
  hasHerdrErrorCode,
  herdrFailure,
  readable,
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
};

const AGENT_START_WAIT_MS = 120_000;
/** How often a pane parent's session is read, while its last turn is still being written. */
const FORK_SETTLE_POLL_MS = 500;

/**
 * The Herdr this adapter drives, as `herdr --version` answers: the run's, checked by the evals'
 * preflight, and a box's, checked before its first pane, as the default image pins it.
 */
export const HERDR_VERSION = "herdr 0.9.1";

type HerdrCommands = ReturnType<typeof createHerdrCommands>;

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
            const launch = spec.interactive(request.execution.model);
            const started = await startAgent(
              name,
              harness,
              paneId,
              launch.argv.slice(1),
              operation.deadline.unixMilliseconds,
              controller.signal,
            );
            if (!started.ok) {
              if (controller.signal.aborted || started.cancelled) {
                return localOutcome("cancelled", "pane operation cancelled");
              }
              return localOutcome(
                started.timedOut || remaining() <= 0 ? "timed-out" : "failed",
                `agent start failed after ${started.attempts}: ${started.error}`,
              );
            }
            if (remaining() <= 0) return localOutcome("timed-out", "operation deadline exceeded");
            const waitMs = Math.max(1, remaining());
            const sent = await herdr(
              ["agent", "prompt", name, prompt, "--wait", "--timeout", String(waitMs)],
              waitMs + HERDR_REPORT_GRACE_MS,
              controller.signal,
            );
            if (!sent.ok) return herdrFailure(sent, remaining());
            if (remaining() <= 0) return localOutcome("timed-out", "operation deadline exceeded");
            const read = await herdr(
              ["agent", "read", name, "--source", "detection"],
              Math.max(1, remaining()),
              controller.signal,
            );
            if (!read.ok && read.cancelled) {
              return localOutcome("cancelled", "pane operation cancelled");
            }
            const outcome = paneOutcome(spec, sent, read);
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

  /**
   * This run's workspace in one Herdr, with a tab for each agent. A box's Herdr holds no host
   * credential, so its tabs need no variables emptied.
   */
  const openTopology = async (
    commands: HerdrCommands,
    label: string,
    cwd: string,
    environment: readonly string[],
    remaining: () => number,
    /** In a sandbox's box, which the engine removes, and every tab with it, after this host. */
    boxed = false,
  ) => {
    const { herdr } = commands;
    if (remaining() <= 0) throw new Error("run deadline exceeded before Herdr host creation");
    const created = await herdr(
      ["workspace", "create", "--label", label, ...environment, "--cwd", cwd, "--no-focus"],
      Math.max(1, remaining()),
    );
    if (!created.ok) throw new Error(`run workspace create failed: ${created.error}`);
    const workspaceId = readId(created.result.workspace, "workspace_id");
    const rootPaneId = readPaneId(created.result);
    const rootTabId = readId(created.result.tab, "tab_id");
    if (!workspaceId || !rootPaneId) {
      const incomplete = "run workspace create returned incomplete topology";
      if (!workspaceId) throw new Error(incomplete);
      const rollback = await herdr(["workspace", "close", workspaceId]);
      if (!rollback.ok) {
        throw new AggregateError(
          [
            new Error(incomplete),
            new Error(`incomplete run workspace cleanup failed: ${rollback.error}`),
          ],
          "Herdr run host acquisition and cleanup failed",
        );
      }
      throw new Error(incomplete);
    }

    let topologyOpen = true;
    let topologyTail = Promise.resolve();
    // Pane to the tab it is the only pane of: an agent gets a tab, so closing it is closing that.
    const panes = new Map<string, string>();
    const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = topologyTail.then(operation);
      topologyTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const closePane = (paneId: string): Promise<void> =>
      mutate(async () => {
        if (!panes.has(paneId)) return;
        const closed = await herdr(["tab", "close", panes.get(paneId)!]);
        // A box's tab ends with its box, which the engine may already have removed.
        if (!closed.ok && !boxed) {
          throw new Error(`agent tab close failed: ${closed.error}`);
        }
        panes.delete(paneId);
      });
    const allocatePane = (
      label: string,
      cwd: string,
      deadlineUnixMilliseconds: number,
      signal: AbortSignal,
      /** Set for the agent's process: a host codex's own home, say. */
      env: Readonly<Record<string, string>> = {},
    ): Promise<string> =>
      mutate(async () => {
        if (!topologyOpen) throw new Error("Herdr run topology is closing");
        const remainingMilliseconds = deadlineUnixMilliseconds - Date.now();
        if (remainingMilliseconds <= 0) {
          throw new Error("operation deadline exceeded before tab allocation");
        }
        const created = await herdr(
          [
            "tab",
            "create",
            "--workspace",
            workspaceId,
            "--label",
            label,
            "--cwd",
            cwd,
            ...environment,
            ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
            "--no-focus",
          ],
          Math.min(config.commandTimeoutMs, remainingMilliseconds),
          signal,
        );
        if (!created.ok) {
          throw new Error(`agent tab create failed: ${created.error}`);
        }
        const tabId = readId(created.result.tab, "tab_id");
        const paneId = readPaneId(created.result);
        if (!tabId || !paneId) throw new Error("agent tab create returned no tab or pane identity");
        panes.set(paneId, tabId);
        return paneId;
      });
    let closed = false;
    /** Stops new tabs and closes the workspace; the error when it could not. */
    const close = async (): Promise<string | undefined> => {
      if (closed) return undefined;
      topologyOpen = false;
      const workspaceClose = await herdr(["workspace", "close", workspaceId]);
      if (!workspaceClose.ok) return `run workspace close failed: ${workspaceClose.error}`;
      panes.clear();
      closed = true;
      return undefined;
    };
    let rootTaken = false;
    /**
     * The workspace's first pane, once, labelled `label`, for what would otherwise leave it an idle
     * shell. Its label is best effort; the pane is the point.
     */
    const takeRoot = async (label: string) => {
      if (rootTaken || !topologyOpen) return undefined;
      rootTaken = true;
      if (rootTabId) await herdr(["tab", "rename", rootTabId, label]);
      return rootPaneId;
    };
    return { commands, allocatePane, closePane, close, takeRoot };
  };

  return {
    // A pane's agent never sees the emptied variables, so its status command must not either.
    accounting: createSessionAccounting(withholding(run, config.emptyEnvironment ?? [])),
    async openRun(runSpec) {
      const remaining = () => runSpec.deadline.unixMilliseconds - Date.now();
      const label = `${config.workspaceLabel} ${runSpec.runId}`;
      type Topology = Awaited<ReturnType<typeof openTopology>>;
      // Opened at the first tab it needs, so a run whose panes are all in boxes, unwatched, leaves
      // no empty workspace in the operator's Herdr.
      let runOpening: Promise<Topology> | undefined;
      const runTopology = () => {
        if (!runOpening) {
          const opening = openTopology(runCommands, label, runSpec.cwd, paneEnvironment, remaining);
          runOpening = opening;
          opening.catch(() => {
            if (runOpening === opening) runOpening = undefined;
          });
        }
        return runOpening;
      };
      // A sandbox's own Herdr, by its key: opened at its first pane agent, closed with the run.
      const boxes = new Map<string, Promise<Topology>>();
      /** Tabs attached to a box's Herdr, finished before the run's workspace closes. */
      const watching = new Set<Promise<unknown>>();
      // Aborted as the host closes: a watch not yet typed has nothing left to show.
      const unwatch = new AbortController();
      // Best effort: the engine has printed the same command, and an agent does not wait on it.
      const watch = (key: string, argv: readonly string[], cwd: string) => {
        const attached = (async () => {
          if (unwatch.signal.aborted) return;
          const topology = await runTopology();
          if (unwatch.signal.aborted) return;
          const label = `sandbox ${key}`;
          const by = Date.now() + config.commandTimeoutMs;
          const paneId =
            (await topology.takeRoot(label)) ??
            (await topology.allocatePane(label, cwd, by, unwatch.signal));
          await runCommands.typeCommand(paneId, argv, by, unwatch.signal);
        })().catch(() => undefined);
        watching.add(attached);
        attached.finally(() => watching.delete(attached));
      };
      const topologyFor = (terminal: PaneTerminal | undefined, cwd: string) => {
        if (!terminal || terminal.herdr === "run") return runTopology();
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
            const topology = await openTopology(commands, label, cwd, [], remaining, true);
            if (config.watchSandboxes && via.watch) watch(via.key, via.watch, cwd);
            return topology;
          })();
          boxes.set(via.key, opening);
          const failed = opening;
          failed.catch(() => {
            if (boxes.get(via.key) === failed) boxes.delete(via.key);
          });
        }
        return opening;
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
            throw new Error(`${harness} panes cannot continue a forked session yet`);
          }
          // In a sandbox, the pane's terminal is the occupant's, in the run's Herdr or the box's.
          let terminal = request.occupant ? await request.occupant.pane?.() : undefined;
          if (request.occupant && !terminal) throw new Error("this sandbox hosts no panes");
          // A prelude loads its secrets once and removes them: a start after a failed one needs
          // a terminal of its own.
          let typed = false;
          const topology = await topologyFor(terminal, request.cwd);
          const { herdr, startAgent, adoptAgent } = topology.commands;
          const { allocatePane, closePane } = topology;
          let current:
            | {
                operationId: string;
                paneId: string;
                agentName: string;
              }
            | undefined;
          let closed = false;
          let hasExecuted = false;
          /** When its harness was launched: a session it names to nobody started since. */
          let launchedAt = Date.now();
          /** The workflow's instructions go with the first prompt the pane's agent is sent. */
          let instructed = false;
          let activeController: AbortController | undefined;
          let activeCompletion: Promise<void> | undefined;

          const closeCurrentPane = async (): Promise<void> => {
            if (!current) return;
            const paneId = current.paneId;
            await closePane(paneId);
            if (current?.paneId === paneId) current = undefined;
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
            const sessionRef = (agent && readSessionRef(agent)) || operation.previousSessionRef;
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
          ): Promise<NativeFork> => {
            if (closed) throw new Error("Herdr run session is closed");
            if (!current) {
              throw new Error("this agent's pane was closed, so its session cannot be forked");
            }
            if (request.occupant) throw new Error("a sandboxed pane agent cannot be forked yet");
            const controller = new AbortController();
            activeController = controller;
            let finish!: () => void;
            activeCompletion = new Promise<void>((resolve) => {
              finish = resolve;
            });
            try {
              const busy = await settle(current.agentName, deadline, controller.signal);
              if (busy) throw new Error(`the agent did not settle before its fork: ${busy.detail}`);
              while (
                (await spec.readSessionUsage?.([sessionRef], request.cwd, request.skills?.ownHome))
                  ?.open === true &&
                Date.now() < deadline.unixMilliseconds
              ) {
                if (!(await abortableDelay(FORK_SETTLE_POLL_MS, controller.signal))) {
                  throw new Error("the fork was cancelled");
                }
              }
              const skills = request.skills
                ? await skillsLaunch(harness, request.skills)
                : undefined;
              const plan = spec.forkSession!(sessionRef, randomUUID(), {
                ...(request.execution.model ? { model: request.execution.model } : {}),
                sessionHint: sessionRef,
                ...(skills ? { launchArgs: skills.args } : {}),
              });
              const result = await forkRun(
                forkCommand(plan, {
                  cwd: request.cwd,
                  env: { ...skills?.env },
                  deadline,
                  signal: controller.signal,
                }),
              );
              return forkResult(harness, plan, result, deadline);
            } finally {
              if (activeController === controller) activeController = undefined;
              finish();
            }
          };

          const backend: ActivatedSessionBackend = {
            identity: { sessionId: continues?.sessionRef ?? randomUUID(), cwd: request.cwd },
            ...(spec.forkSession ? { fork: forkPane } : {}),
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
                    return localOutcome("failed", `${harness} has no compaction of its own`);
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
                  const skills = request.skills
                    ? await skillsLaunch(harness, request.skills)
                    : undefined;
                  let paneId: string;
                  try {
                    paneId = await allocatePane(
                      request.key,
                      request.cwd,
                      operation.deadline.unixMilliseconds,
                      controller.signal,
                      skills?.env,
                    );
                  } catch (error) {
                    if (controller.signal.aborted) {
                      return localOutcome("cancelled", "pane operation cancelled");
                    }
                    throw error;
                  }
                  launchedAt = Date.now();
                  const agentName = safeAgentName(
                    `wf-${request.key}`,
                    `${runSpec.runId}:${request.key}:${operationId}`,
                  );
                  current = { operationId, paneId, agentName };
                  const launchArgs = [
                    ...(request.occupant ? sandboxedArgs(harness) : []),
                    ...(skills?.args ?? []),
                  ];
                  const launch = continues
                    ? spec.interactiveResume!(
                        continues.sessionRef,
                        request.execution.model,
                        launchArgs,
                      )
                    : spec.interactive(request.execution.model, launchArgs);
                  if (terminal && typed) terminal = await request.occupant!.pane!();
                  typed = true;
                  const started = terminal
                    ? await adoptAgent(
                        agentName,
                        harness,
                        paneId,
                        terminal,
                        launch.argv.slice(1),
                        operation.deadline.unixMilliseconds,
                        controller.signal,
                      )
                    : await startAgent(
                        agentName,
                        harness,
                        paneId,
                        launch.argv.slice(1),
                        operation.deadline.unixMilliseconds,
                        controller.signal,
                      );
                  if (!started.ok) {
                    await closeCurrentPane().catch(() => undefined);
                    if (controller.signal.aborted || started.cancelled) {
                      return localOutcome("cancelled", "pane operation cancelled");
                    }
                    return localOutcome(
                      started.timedOut ? "timed-out" : "failed",
                      `agent start failed after ${started.attempts}: ${started.error}`,
                    );
                  }
                  hasExecuted = true;
                } else {
                  // Herdr's prompt wait does not track turns: prompted while the last turn is still
                  // going, it could match that turn's end. So the agent settles first (E8).
                  current.operationId = operationId;
                  const idle = await settle(
                    current.agentName,
                    operation.deadline,
                    controller.signal,
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
                const prompt =
                  !instructed && request.instructions
                    ? `${request.instructions}\n\n${operation.prompt}`
                    : operation.prompt;
                instructed = true;
                const remainingMs = operation.deadline.unixMilliseconds - Date.now();
                if (remainingMs <= 0) {
                  return localOutcome("timed-out", "operation deadline exceeded");
                }
                const waitMs = Math.max(1, remainingMs);
                const sent = await submitPrompt(
                  herdr,
                  placement.agentName,
                  placement.paneId,
                  prompt,
                  spec.pastesQuoted === true,
                  waitMs,
                  controller.signal,
                );
                if (!sent.ok) {
                  if (sent.cancelled || controller.signal.aborted) {
                    return localOutcome("cancelled", "pane operation cancelled");
                  }
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
                const outcome = paneOutcome(spec, sent, read);
                if (outcome.sessionRef || !spec.findSession || !operation.binding) return outcome;
                // A harness that names its session to nobody is found by this operation's id.
                const found =
                  operation.previousSessionRef ??
                  (await spec.findSession(
                    operation.binding.operationId,
                    launchedAt,
                    request.cwd,
                    request.skills?.ownHome,
                  ));
                return found ? { ...outcome, sessionRef: found } : outcome;
              } finally {
                if (activeController === controller) activeController = undefined;
                finish();
              }
            },
            async cancel() {
              if (!activeController && !current) return false;
              activeController?.abort();
              await activeCompletion;
              await closeCurrentPane();
              return true;
            },
            async close() {
              if (closed) return;
              activeController?.abort();
              await activeCompletion;
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
                opening.then((box) => box.close()).catch(() => undefined),
              ),
            );
            const opened = await runOpening?.catch(() => undefined);
            const failed = await opened?.close();
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
  spec: HarnessSpec,
  sent: Extract<HerdrResult, { ok: true }>,
  read: HerdrResult,
): NativeTurnOutcome {
  const rawTranscript = read.ok && read.stdout.trim() !== "" ? read.stdout : null;
  const transcript = rawTranscript ? (spec.readTranscript?.(rawTranscript) ?? rawTranscript) : null;
  const agent = reportedAgent(sent.result);
  const nativeSession =
    readSessionRef(agent) ?? (rawTranscript ? spec.readSessionId?.(rawTranscript) : undefined);
  return {
    ...settledOutcome(agent),
    resultEvidence: transcript ? { kind: "transcript", text: transcript } : { kind: "unavailable" },
    ...(nativeSession ? { sessionRef: nativeSession } : {}),
    // The screen is no record of spend; the engine reads the session files when the run ends.
    chargesUsd: [],
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
