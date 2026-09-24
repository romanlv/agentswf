import { randomUUID } from "node:crypto";
import type { AgentRunHostFactory, AgentSessionAdapter } from "../adapter";
import { type RunProcess, runProcess, withholding } from "../command";
import { parseRow, record } from "../json";
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
  /** Never `review-loop`: that session has a live loop attached to it. */
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
};

const AGENT_START_WAIT_MS = 120_000;

export function createHerdrCommands(config: HerdrConfig, run: RunProcess) {
  const startAttempts = config.startAttempts ?? 5;
  const startRetryMs = config.startRetryMs ?? 2_000;
  const herdr: HerdrCommand = async (args, timeoutMs, signal) => {
    const result = await run({
      argv: ["herdr", "--session", config.session, ...args],
      timeoutMs: timeoutMs ?? config.commandTimeoutMs,
      ...(signal ? { signal } : {}),
    });
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
  ): Promise<{
    ok: boolean;
    attempts: number;
    error: string;
    timedOut: boolean;
    cancelled: boolean;
  }> => {
    const succeeded = (attempts: number) =>
      ({ ok: true, attempts, error: "", timedOut: false, cancelled: false }) as const;
    const stopped = (
      attempts: number,
      error: string,
      how: { timedOut?: boolean; cancelled?: boolean } = {},
    ) =>
      ({
        ok: false,
        attempts,
        error,
        timedOut: how.timedOut ?? false,
        cancelled: how.cancelled ?? false,
      }) as const;
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
      if (started.ok) return succeeded(attempt);
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
        return trusted.ok ? succeeded(attempt) : stopped(attempt, trusted.error, trusted);
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
  return { herdr, startAgent };
}

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
  const { herdr, startAgent } = createHerdrCommands(config, run);

  return {
    // A pane's agent never sees the emptied variables, so its status command must not either.
    accounting: createSessionAccounting(withholding(run, config.emptyEnvironment ?? [])),
    async openRun(runSpec) {
      const remaining = () => runSpec.deadline.unixMilliseconds - Date.now();
      if (remaining() <= 0) throw new Error("run deadline exceeded before Herdr host creation");
      const created = await herdr(
        [
          "workspace",
          "create",
          "--label",
          `${config.workspaceLabel} ${runSpec.runId}`,
          ...paneEnvironment,
          "--cwd",
          runSpec.cwd,
          "--no-focus",
        ],
        Math.max(1, remaining()),
      );
      if (!created.ok) throw new Error(`run workspace create failed: ${created.error}`);
      const workspaceId = readId(created.result.workspace, "workspace_id");
      const rootPaneId = readPaneId(created.result);
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
          if (!closed.ok) {
            throw new Error(`agent tab close failed: ${closed.error}`);
          }
          panes.delete(paneId);
        });
      const allocatePane = (
        label: string,
        cwd: string,
        deadlineUnixMilliseconds: number,
        signal: AbortSignal,
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
              ...paneEnvironment,
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
          if (!tabId || !paneId)
            throw new Error("agent tab create returned no tab or pane identity");
          panes.set(paneId, tabId);
          return paneId;
        });

      const adapter = createSessionAdapter({
        harnesses: ["claude", "codex"],
        placement: "pane",
        async activate(request) {
          const harness = knownHarness(request.execution.harness);
          const spec = harnessSpec(harness);
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
                  let paneId: string;
                  try {
                    paneId = await allocatePane(
                      request.key,
                      request.cwd,
                      operation.deadline.unixMilliseconds,
                      controller.signal,
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
                  const launch = spec.interactive(request.execution.model);
                  const started = await startAgent(
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
            topologyOpen = false;
            const workspaceClose = await herdr(["workspace", "close", workspaceId]);
            if (workspaceClose.ok) {
              panes.clear();
              workspaceClosed = true;
              hostState = "closed";
            }
            if (!workspaceClose.ok) {
              failures.push(new Error(`run workspace close failed: ${workspaceClose.error}`));
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
