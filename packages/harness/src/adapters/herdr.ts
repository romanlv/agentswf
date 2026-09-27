import { randomUUID } from "node:crypto";
import { type PaneHerdr, type PaneTerminal, shellQuote } from "@wf/sandbox";
import type { AgentRunHostFactory, AgentSessionAdapter } from "../adapter";
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
import { HARNESS_NAMES, type HarnessSpec, harnessSpec, knownHarness } from "../spec";
import { createSessionAccounting } from "../usage/accounting";
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
  safeAgentName,
  settledOutcome,
} from "./herdr-protocol";
import { answerStartupBlocks } from "./herdr-startup";

export type HerdrConfig = {
  /** The Herdr session agents open in; `awf run` picks the one it runs in. */
  session: string;
  workspaceLabel: string;
  commandTimeoutMs: number;
  settleTimeoutMs: number;
  /** Prepended to PATH for the frozen legacy driver, whose `wf` is still found by name. */
  binDir?: string;
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
            const waitMs = Math.max(1, Math.min(config.settleTimeoutMs, remaining()));
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
        harnesses: ["claude", "codex"],
        placement: "pane",
        launchesInSandbox: true,
        givesSkills: true,
        async activate(request) {
          const harness = knownHarness(request.execution.harness);
          const spec = harnessSpec(harness);
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
          let activeController: AbortController | undefined;
          let activeCompletion: Promise<void> | undefined;

          const closeCurrentPane = async (): Promise<void> => {
            if (!current) return;
            const paneId = current.paneId;
            await closePane(paneId);
            if (current?.paneId === paneId) current = undefined;
          };

          const backend: ActivatedSessionBackend = {
            identity: { sessionId: randomUUID(), cwd: request.cwd },
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
                const sameOperation = current?.operationId === operationId;
                if (!sameOperation) {
                  await closeCurrentPane();
                  // Herdr lifecycle state does not track a turn, so nothing this host observes
                  // proves the previous pane released.
                  if (hasExecuted) {
                    return localOutcome(
                      "failed",
                      "this host runs one operation per agent: " +
                        "native release cannot be proved for a later one",
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
                  const agentName = safeAgentName(
                    `wf-${request.key}`,
                    `${runSpec.runId}:${request.key}:${operationId}`,
                  );
                  current = { operationId, paneId, agentName };
                  const launch = spec.interactive(request.execution.model, [
                    ...(request.occupant ? sandboxedArgs(harness) : []),
                    ...(skills?.args ?? []),
                  ]);
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
                }

                const placement = current;
                if (!placement) throw new Error("operation pane was not retained");
                // Only with the pane: a nudge reaches an agent that has already read these, and
                // sending them again reads as a new assignment rather than a reminder.
                const prompt =
                  !sameOperation && request.instructions
                    ? `${request.instructions}\n\n${operation.prompt}`
                    : operation.prompt;
                const remainingMs = operation.deadline.unixMilliseconds - Date.now();
                if (remainingMs <= 0) {
                  return localOutcome("timed-out", "operation deadline exceeded");
                }
                const waitMs = Math.max(1, Math.min(config.settleTimeoutMs, remainingMs));
                const sent = await herdr(
                  [
                    "agent",
                    "prompt",
                    placement.agentName,
                    prompt,
                    "--wait",
                    "--timeout",
                    String(waitMs),
                  ],
                  waitMs + HERDR_REPORT_GRACE_MS,
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
                return paneOutcome(spec, sent, read);
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
  const agent = record(sent.result.agent) ?? sent.result;
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
