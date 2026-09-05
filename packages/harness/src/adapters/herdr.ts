import { createHash, randomUUID } from "node:crypto";
import type {
  AgentRunHostFactory,
  AgentSessionAdapter,
  HarnessActivation,
  HarnessOperationBinding,
} from "../adapter";
import { runProcess, type RunProcess } from "../command";
import { createLegacyDriver } from "../legacy-driver";
import { createSessionAdapter, type ActivatedSessionBackend } from "../session-core";
import { createSingleSessionHostFactory } from "../single-session-host";
import { harnessSpec } from "../spec";
import type { AgentSessionDriver, CallIdentity, Harness, SettledState, Step } from "../types";

export type HerdrConfig = {
  /** Never `review-loop`: that session has a live loop attached to it. */
  session: string;
  workspaceLabel: string;
  commandTimeoutMs: number;
  settleTimeoutMs: number;
  binDir?: string;
  /** Names forced to an empty value in every workspace. Values never cross the Herdr argv. */
  emptyEnvironment?: readonly string[];
  /** `agent start` refuses a pane that has not reached its shell prompt; see `startAgent`. */
  startAttempts?: number;
  startRetryMs?: number;
  /** Accept only the known Claude/Codex trust gate for a workspace the caller created and vetted. */
  acceptWorkspaceTrust?: boolean;
};

type HerdrResult =
  | { ok: true; result: Record<string, unknown>; stdout: string }
  | { ok: false; error: string; timedOut: boolean; cancelled: boolean };

/**
 * Herdr reports the settled agent itself; the process kill is only a backstop for a herdr that
 * never returns. Without slack the kill lands on the same tick as the report, and an agent that
 * used its whole settle window is misread as a timeout with its transcript, session ref and usage
 * discarded.
 */
const HERDR_REPORT_GRACE_MS = 30_000;

const HERDR_KINDS: Record<Step["harness"], string> = {
  claude: "claude",
  codex: "codex",
  pi: "pi",
  cursor: "cursor",
};

function createHerdrCommands(config: HerdrConfig, run: RunProcess) {
  const startAttempts = config.startAttempts ?? 5;
  const startRetryMs = config.startRetryMs ?? 2_000;
  const herdr = async (
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<HerdrResult> => {
    const result = await run({
      argv: ["herdr", "--session", config.session, ...args],
      timeoutMs: timeoutMs ?? config.commandTimeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: (result.stderr || result.stdout || "herdr command failed").trim().slice(0, 400),
        timedOut: result.timedOut,
        cancelled: result.cancelled === true,
      };
    }
    const line = result.stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
    if (!line) return { ok: true, result: {}, stdout: result.stdout };
    try {
      const parsed = JSON.parse(line) as { result?: Record<string, unknown> };
      return { ok: true, result: parsed.result ?? {}, stdout: result.stdout };
    } catch {
      return { ok: true, result: {}, stdout: result.stdout };
    }
  };
  const startAgent = async (
    name: string,
    kind: string,
    paneId: string,
    args: string[],
    deadlineUnixMs?: number,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    attempts: number;
    error: string;
    timedOut: boolean;
    cancelled: boolean;
  }> => {
    let error = "agent start never ran";
    let timedOut = false;
    for (let attempt = 1; attempt <= startAttempts; attempt += 1) {
      if (signal?.aborted) {
        return {
          ok: false,
          attempts: attempt - 1,
          error: "operation cancelled",
          timedOut: false,
          cancelled: true,
        };
      }
      const remaining = deadlineUnixMs === undefined ? 150_000 : deadlineUnixMs - Date.now();
      if (remaining <= 0) {
        return {
          ok: false,
          attempts: attempt - 1,
          error: "operation deadline exceeded",
          timedOut: true,
          cancelled: false,
        };
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
          "120000",
          ...(args.length > 0 ? ["--", ...args] : []),
        ],
        Math.min(150_000, remaining),
        signal,
      );
      if (started.ok) {
        return { ok: true, attempts: attempt, error: "", timedOut: false, cancelled: false };
      }
      error = started.error;
      timedOut = started.timedOut;
      if (started.cancelled) {
        return {
          ok: false,
          attempts: attempt,
          error,
          timedOut: false,
          cancelled: true,
        };
      }
      if (config.acceptWorkspaceTrust && herdrErrorCode(error) === "agent_not_ready") {
        const trusted = await acceptKnownWorkspaceTrust(
          herdr,
          name,
          kind,
          deadlineUnixMs,
          signal,
        );
        if (trusted.ok) {
          return { ok: true, attempts: attempt, error: "", timedOut: false, cancelled: false };
        }
        return {
          ok: false,
          attempts: attempt,
          error: trusted.error,
          timedOut: trusted.timedOut,
          cancelled: trusted.cancelled,
        };
      }
      if (!isRetryableStartError(error)) {
        return {
          ok: false,
          attempts: attempt,
          error,
          timedOut,
          cancelled: false,
        };
      }
      const retryRemaining = deadlineUnixMs === undefined ? undefined : deadlineUnixMs - Date.now();
      if (retryRemaining !== undefined && retryRemaining <= 0) break;
      const waited = await abortableDelay(
        retryRemaining === undefined ? startRetryMs : Math.min(startRetryMs, retryRemaining),
        signal,
      );
      if (!waited) {
        return {
          ok: false,
          attempts: attempt,
          error: "operation cancelled",
          timedOut: false,
          cancelled: true,
        };
      }
    }
    return {
      ok: false,
      attempts: startAttempts,
      error,
      timedOut,
      cancelled: false,
    };
  };
  return { herdr, startAgent };
}

async function acceptKnownWorkspaceTrust(
  herdr: (
    args: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<HerdrResult>,
  name: string,
  kind: string,
  deadlineUnixMs?: number,
  signal?: AbortSignal,
): Promise<HerdrResult> {
  const remaining = () => deadlineUnixMs === undefined ? 150_000 : deadlineUnixMs - Date.now();
  const inactive = trustHandshakeInactive(deadlineUnixMs, signal);
  if (inactive) return inactive;
  const read = await herdr(
    ["agent", "read", name, "--source", "detection"],
    Math.max(1, remaining()),
    signal,
  );
  if (!read.ok) return read;

  const keys = workspaceTrustKeys(kind, read.stdout);
  if (!keys) {
    return {
      ok: false,
      error: "agent startup stopped at an unrecognized startup block",
      timedOut: false,
      cancelled: false,
    };
  }
  const inactiveAfterRead = trustHandshakeInactive(deadlineUnixMs, signal);
  if (inactiveAfterRead) return inactiveAfterRead;
  const sent = await herdr(
    ["agent", "send-keys", name, ...keys],
    Math.max(1, remaining()),
    signal,
  );
  if (!sent.ok) return sent;
  const inactiveAfterInput = trustHandshakeInactive(deadlineUnixMs, signal);
  if (inactiveAfterInput) return inactiveAfterInput;
  const waitMs = Math.max(1, remaining());
  return herdr(
    [
      "agent",
      "wait",
      name,
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      String(waitMs),
    ],
    waitMs + HERDR_REPORT_GRACE_MS,
    signal,
  );
}

function trustHandshakeInactive(
  deadlineUnixMs: number | undefined,
  signal: AbortSignal | undefined,
): Extract<HerdrResult, { ok: false }> | undefined {
  if (signal?.aborted) {
    return {
      ok: false,
      error: "operation cancelled",
      timedOut: false,
      cancelled: true,
    };
  }
  if (deadlineUnixMs !== undefined && deadlineUnixMs <= Date.now()) {
    return {
      ok: false,
      error: "operation deadline exceeded",
      timedOut: true,
      cancelled: false,
    };
  }
  return undefined;
}

function workspaceTrustKeys(kind: string, screen: string): string[] | null {
  if (
    kind === "claude" &&
    screen.includes("Quick safety check: Is this a project you created or one you trust?") &&
    screen.includes("Yes, I trust this folder")
  ) {
    return ["down", "enter"];
  }
  if (
    kind === "codex" &&
    screen.includes("Do you trust the contents of this directory?") &&
    screen.includes("1. Yes, continue")
  ) {
    return ["enter"];
  }
  return null;
}

function herdrErrorCode(error: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(error);
    return readId(record(parsed)?.error, "code");
  } catch {
    return undefined;
  }
}

/**
 * The envelope is truncated to 400 characters and may carry a preamble, so a parse failure is
 * ordinary and the retry cannot depend on one. The raw fallback matches the code field, never a
 * message that merely names the code.
 */
function isRetryableStartError(error: string): boolean {
  const code = herdrErrorCode(error);
  if (code !== undefined) return code === "agent_pane_busy";
  return /"code"\s*:\s*"agent_pane_busy"/.test(error) || error.trim() === "agent_pane_busy";
}

export function createPaneAdapter(
  config: HerdrConfig,
  run: RunProcess = runProcess,
): AgentSessionAdapter {
  return createPaneAdapterCore(config, run);
}

/** The production host: one run workspace and tab, with one authority-bound pane per operation. */
export function createHerdrRunHostFactory(
  config: HerdrConfig,
  run: RunProcess = runProcess,
): AgentRunHostFactory {
  const emptyEnvironment = emptyEnvironmentArgs(config.emptyEnvironment);
  const { herdr, startAgent } = createHerdrCommands(config, run);

  return {
    async openRun(runSpec) {
      const remaining = () => runSpec.deadline.unixMilliseconds - Date.now();
      if (remaining() <= 0) throw new Error("run deadline exceeded before Herdr host creation");
      const created = await herdr(
        [
          "workspace",
          "create",
          "--label",
          `${config.workspaceLabel} ${runSpec.runId}`,
          ...emptyEnvironment,
          ...bindingArgs(undefined),
          ...(config.binDir
            ? ["--env", `PATH=${config.binDir}:${process.env.PATH ?? ""}`]
            : []),
          "--cwd",
          runSpec.cwd,
          "--no-focus",
        ],
        Math.max(1, remaining()),
      );
      if (!created.ok) throw new Error(`run workspace create failed: ${created.error}`);
      const workspaceId = readId(created.result.workspace, "workspace_id");
      const rootPaneId = readPaneId(created.result);
      const tabId = readId(created.result.tab, "tab_id");
      if (!workspaceId || !rootPaneId || !tabId) {
        if (!workspaceId) throw new Error("run workspace create returned incomplete topology");
        const rollback = await herdr(["workspace", "close", workspaceId]);
        if (!rollback.ok) {
          throw new AggregateError(
            [
              new Error("run workspace create returned incomplete topology"),
              new Error(`incomplete run workspace cleanup failed: ${rollback.error}`),
            ],
            "Herdr run host acquisition and cleanup failed",
          );
        }
        throw new Error("run workspace create returned incomplete topology");
      }

      let topologyOpen = true;
      let topologyTail = Promise.resolve();
      const panes = new Set<string>();
      const authorities = new Set<string>();
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
          const closed = await herdr(["pane", "close", paneId]);
          if (!closed.ok) {
            throw new Error(
              safeProtectedDetail(
                `operation pane close failed: ${closed.error}`,
                authorities,
                "operation pane close failed without safe diagnostic detail",
              ),
            );
          }
          panes.delete(paneId);
        });
      const allocatePane = (
        binding: HarnessOperationBinding | undefined,
        cwd: string,
        deadlineUnixMilliseconds: number,
        signal: AbortSignal,
      ): Promise<string> =>
        mutate(async () => {
          if (!topologyOpen) throw new Error("Herdr run topology is closing");
          const remainingMilliseconds = deadlineUnixMilliseconds - Date.now();
          if (remainingMilliseconds <= 0) {
            throw new Error("operation deadline exceeded before pane allocation");
          }
          const split = await herdr(
            [
              "pane",
              "split",
              rootPaneId,
              "--direction",
              "right",
              "--ratio",
              "0.5",
              "--cwd",
              cwd,
              ...bindingArgs(binding),
              "--no-focus",
            ],
            Math.min(config.commandTimeoutMs, remainingMilliseconds),
            signal,
          );
          if (!split.ok) {
            throw new Error(
              safeProtectedDetail(
                `operation pane split failed: ${split.error}`,
                authorities,
                "operation pane split failed without safe diagnostic detail",
              ),
            );
          }
          const paneId = readPaneId(split.result);
          if (!paneId) throw new Error("operation pane split returned no pane identity");
          panes.add(paneId);
          return paneId;
        });

      const adapter = createSessionAdapter({
        harnesses: ["claude", "codex"],
        async activate(request) {
          const harness = knownHarness(request.execution.harness);
          const spec = harnessSpec(harness);
          let current:
            | {
                operationId: string;
                capability?: string;
                paneId: string;
                agentName: string;
              }
            | undefined;
          let closed = false;
          let continuationReady = false;
          let continuationRef: string | undefined;
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
              if (operation.binding) {
                authorities.add(operation.binding.operationId);
                authorities.add(operation.binding.capability);
              }
              const controller = new AbortController();
              activeController = controller;
              let finish!: () => void;
              activeCompletion = new Promise<void>((resolve) => {
                finish = resolve;
              });
              try {
                const operationId =
                  operation.binding?.operationId ?? `internal:${request.key}:${operation.id}`;
                const sameOperation =
                  current?.operationId === operationId &&
                  current.capability === operation.binding?.capability;
                if (!sameOperation) {
                  await closeCurrentPane();
                  if (
                    hasExecuted &&
                    (!continuationReady ||
                      !continuationRef ||
                      operation.previousSessionRef !== continuationRef)
                  ) {
                    return localOutcome(
                      "failed",
                      "confirmed native continuation evidence is unavailable for the next operation",
                    );
                  }
                  if (operation.previousSessionRef && !spec.interactiveResume) {
                    return localOutcome(
                      "failed",
                      `${harness} has no measured interactive resume command`,
                    );
                  }
                  hasExecuted = true;
                  continuationReady = false;
                  continuationRef = undefined;
                  const paneId = await allocatePane(
                    operation.binding,
                    request.cwd,
                    operation.deadline.unixMilliseconds,
                    controller.signal,
                  );
                  const agentName = safeAgentName(
                    `wf-${request.key}`,
                    `${runSpec.runId}:${request.key}:${operationId}`,
                  );
                  current = {
                    operationId,
                    ...(operation.binding ? { capability: operation.binding.capability } : {}),
                    paneId,
                    agentName,
                  };
                  const launch = operation.previousSessionRef
                    ? spec.interactiveResume!(operation.previousSessionRef, request.execution.model)
                    : spec.interactive(request.execution.model);
                  const started = await startAgent(
                    agentName,
                    HERDR_KINDS[harness],
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
                      safeProtectedDetail(
                        `agent start failed after ${started.attempts}: ${started.error}`,
                        authorities,
                        "agent start failed without safe diagnostic detail",
                      ),
                    );
                  }
                }

                const placement = current;
                if (!placement) throw new Error("operation pane was not retained");
                continuationReady = false;
                continuationRef = undefined;
                const prompt = request.instructions
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
                  const failure = herdrFailure(sent, operation.binding, remainingMs);
                  return {
                    ...failure,
                    detail: safeProtectedDetail(
                      failure.detail,
                      authorities,
                      "pane operation failed without safe diagnostic detail",
                    ),
                  };
                }
                const read = await herdr(
                  ["agent", "read", placement.agentName, "--source", "detection"],
                  Math.max(1, operation.deadline.unixMilliseconds - Date.now()),
                  controller.signal,
                );
                if (!read.ok && read.cancelled) {
                  return localOutcome("cancelled", "pane operation cancelled");
                }
                const rawTranscript = read.ok && read.stdout.trim() !== "" ? read.stdout : null;
                const safeTranscript =
                  rawTranscript &&
                  !containsProtectedAuthority(rawTranscript, authorities)
                    ? spec.readTranscript?.(rawTranscript) ?? rawTranscript
                    : null;
                const agent = record(sent.result.agent) ?? sent.result;
                const nativeSessionCandidate =
                  readSessionRef(agent) ??
                  (rawTranscript ? spec.readSessionId?.(rawTranscript) : undefined);
                const nativeSession =
                  nativeSessionCandidate &&
                  !containsProtectedAuthority(nativeSessionCandidate, authorities)
                    ? nativeSessionCandidate
                    : undefined;
                const common = {
                  resultEvidence: safeTranscript
                    ? ({ kind: "transcript", text: safeTranscript } as const)
                    : ({ kind: "unavailable" } as const),
                  ...(nativeSession ? { sessionRef: nativeSession } : {}),
                  nativeUsage:
                    rawTranscript && spec.readUsage ? [spec.readUsage(rawTranscript)] : [],
                };
                switch (settledState(agent)) {
                  case "idle":
                  case "done":
                    continuationReady =
                      nativeSession !== undefined &&
                      Date.now() < operation.deadline.unixMilliseconds;
                    continuationRef = continuationReady ? nativeSession : undefined;
                    return {
                      state: "completed" as const,
                      ...(statusText(agent)
                        ? {
                            detail: safeProtectedDetail(
                              statusText(agent)!,
                              authorities,
                              "agent completed without safe status detail",
                            ),
                          }
                        : {}),
                      ...common,
                    };
                  case "blocked":
                    return {
                      state: "blocked" as const,
                      ...(statusText(agent)
                        ? {
                            detail: safeProtectedDetail(
                              statusText(agent)!,
                              authorities,
                              "agent blocked without safe status detail",
                            ),
                          }
                        : {}),
                      ...common,
                    };
                  case "unknown":
                    return {
                      state: "failed" as const,
                      detail: safeProtectedDetail(
                        statusText(agent) ?? "unknown agent status",
                        authorities,
                        "agent failed without safe status detail",
                      ),
                      ...common,
                    };
                }
              } finally {
                if (activeController === controller) activeController = undefined;
                finish();
              }
            },
            async cancel() {
              if (!activeController && !current) return false;
              continuationReady = false;
              continuationRef = undefined;
              activeController?.abort();
              await activeCompletion;
              continuationReady = false;
              continuationRef = undefined;
              await closeCurrentPane();
              return true;
            },
            async close() {
              if (closed) return;
              continuationReady = false;
              continuationRef = undefined;
              activeController?.abort();
              await activeCompletion;
              continuationReady = false;
              continuationRef = undefined;
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
            const sessionClose = await Promise.allSettled([inner.close(reason)]);
            topologyOpen = false;
            const workspaceClose = await herdr(["workspace", "close", workspaceId]);
            if (workspaceClose.ok) {
              panes.clear();
              workspaceClosed = true;
              hostState = "closed";
            }
            const failures = sessionClose
              .filter(
                (result): result is PromiseRejectedResult => result.status === "rejected",
              )
              .map((result) => safeHostError(result.reason, authorities));
            if (!workspaceClose.ok) {
              failures.push(
                safeHostError(
                  new Error(`run workspace close failed: ${workspaceClose.error}`),
                  authorities,
                ),
              );
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

function createPaneAdapterCore(
  config: HerdrConfig,
  run: RunProcess,
  legacyCall?: CallIdentity,
): AgentSessionAdapter & { legacyTranscript(): Promise<string | null> } {
  const emptyEnvironment = emptyEnvironmentArgs(config.emptyEnvironment);
  const { herdr, startAgent } = createHerdrCommands(config, run);
  let legacyTranscript: (() => Promise<string | null>) | undefined;
  let legacySessionRef: string | undefined;
  const adapter = createSessionAdapter({
    harnesses: ["claude", "codex", "pi", "cursor"],
    observeSessionRef: (sessionRef) => {
      legacySessionRef = sessionRef;
    },
    async activate(request) {
      if (legacyCall) {
        const legacy = await activateLegacyPane(request, legacyCall, config, herdr, startAgent);
        legacyTranscript = legacy.readTranscript;
        return legacy.backend;
      }
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
      const closeOpenWorkspaces = async (): Promise<boolean> => {
        const pending = [...openWorkspaces];
        const results = await Promise.allSettled(pending.map(closeWorkspace));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        return pending.length > 0;
      };

      return {
        identity,
        async execute(operation) {
          if (closed) throw new Error("pane session is closed");
          if (executed || operation.previousSessionRef) {
            return localOutcome(
              "failed",
              "safe pane continuation is unavailable without a measured interactive-resume primitive",
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
            const prompt =
              request.instructions
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
                ...bindingArgs(operation.binding),
                ...(config.binDir
                  ? ["--env", `PATH=${config.binDir}:${process.env.PATH ?? ""}`]
                  : []),
                "--cwd",
                request.cwd,
                "--no-focus",
              ],
              Math.max(1, remaining()),
              controller.signal,
            );
            if (!created.ok) return herdrFailure(created, operation.binding, remaining());
            const paneId = readPaneId(created.result);
            workspaceId = readId(created.result.workspace, "workspace_id");
            if (workspaceId) openWorkspaces.add(workspaceId);
            if (!paneId || !workspaceId) {
              throw new Error("workspace create returned incomplete identity");
            }
            const launch = spec.interactive(request.execution.model);
            const started = await startAgent(
              name,
              HERDR_KINDS[harness],
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
              [
                "agent",
                "prompt",
                name,
                prompt,
                "--wait",
                "--timeout",
                String(waitMs),
              ],
              waitMs + HERDR_REPORT_GRACE_MS,
              controller.signal,
            );
            if (!sent.ok) return herdrFailure(sent, operation.binding, remaining());
            if (remaining() <= 0) return localOutcome("timed-out", "operation deadline exceeded");
            const read = await herdr(
              ["agent", "read", name, "--source", "detection"],
              Math.max(1, remaining()),
              controller.signal,
            );
            if (!read.ok && read.cancelled) {
              return localOutcome("cancelled", "pane operation cancelled");
            }
            const rawTranscript = read.ok && read.stdout.trim() !== "" ? read.stdout : null;
            const authorities = operation.binding
              ? [operation.binding.operationId, operation.binding.capability]
              : [];
            const safeRawTranscript =
              rawTranscript && !authorities.some((authority) => rawTranscript.includes(authority))
                ? rawTranscript
                : null;
            const safeTranscript = safeRawTranscript
              ? spec.readTranscript?.(safeRawTranscript) ?? safeRawTranscript
              : null;
            const agent = record(sent.result.agent) ?? sent.result;
            const nativeSession =
              readSessionRef(agent) ??
              (safeRawTranscript ? spec.readSessionId?.(safeRawTranscript) : undefined);
            if (
              nativeSession &&
              !authorities.some((authority) => nativeSession.includes(authority))
            ) {
              identity.sessionId = nativeSession;
            }
            const common = {
              resultEvidence: safeTranscript
                ? ({ kind: "transcript", text: safeTranscript } as const)
                : ({ kind: "unavailable" } as const),
              ...(nativeSession && !authorities.some((authority) => nativeSession.includes(authority))
                ? { sessionRef: nativeSession }
                : {}),
              nativeUsage:
                safeRawTranscript && spec.readUsage ? [spec.readUsage(safeRawTranscript)] : [],
            };
            switch (settledState(agent)) {
              case "idle":
              case "done":
                return { state: "completed" as const, detail: statusText(agent), ...common };
              case "blocked":
                return { state: "blocked" as const, detail: statusText(agent), ...common };
              case "unknown":
                return {
                  state: "failed" as const,
                  detail: statusText(agent) ?? "unknown agent status",
                  ...common,
                };
            }
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
  return Object.assign(adapter, {
    async legacyTranscript() {
      return legacyTranscript?.() ?? null;
    },
    legacySessionRef: () => legacySessionRef,
  });
}

/**
 * A workspace per call, closed after. Every Herdr verb the experiment uses is in this file and
 * every harness flag it passes through is in `spec.ts`.
 */
export function createHerdrAdapter(
  config: HerdrConfig,
  run: RunProcess = runProcess,
): AgentSessionDriver {
  return createLegacyDriver({
    kind: "pane",
    timeoutMs: config.settleTimeoutMs + config.commandTimeoutMs,
    adapter(call) {
      return createPaneAdapterCore(config, run, call);
    },
  });
}

async function activateLegacyPane(
  request: HarnessActivation,
  call: CallIdentity,
  config: HerdrConfig,
  herdr: ReturnType<typeof createHerdrCommands>["herdr"],
  startAgent: ReturnType<typeof createHerdrCommands>["startAgent"],
): Promise<{
  backend: ActivatedSessionBackend;
  readTranscript(): Promise<string | null>;
}> {
  const harness = knownHarness(request.execution.harness);
  const spec = harnessSpec(harness);
  const emptyEnvironment = emptyEnvironmentArgs(config.emptyEnvironment);
  const name = safeAgentName(`wf-${call.callId}`);
  const created = await herdr([
    "workspace",
    "create",
    "--label",
    `${config.workspaceLabel} ${call.callId}`,
    ...emptyEnvironment,
    "--env",
    `WF_RUN=${call.runDir}`,
    "--env",
    `WF_CALL=${call.callId}`,
    ...(config.binDir ? ["--env", `PATH=${config.binDir}:${process.env.PATH ?? ""}`] : []),
    "--cwd",
    request.cwd,
    "--no-focus",
  ]);
  if (!created.ok) throw new Error(`workspace create failed: ${created.error}`);
  const paneId = readPaneId(created.result);
  const workspaceId = readId(created.result.workspace, "workspace_id");
  const closeWorkspace = async () => {
    if (!workspaceId) return;
    const closed = await herdr(["workspace", "close", workspaceId]);
    if (!closed.ok) throw new Error(`workspace close failed: ${closed.error}`);
  };
  if (!paneId || !workspaceId) {
    await closeWorkspace();
    throw new Error("workspace create returned incomplete identity");
  }
  const launch = spec.interactive(request.execution.model);
  const started = await startAgent(
    name,
    HERDR_KINDS[harness],
    paneId,
    launch.argv.slice(1),
    request.deadline.unixMilliseconds,
  );
  if (!started.ok) {
    await closeWorkspace();
    throw new Error(`agent start failed after ${started.attempts}: ${started.error}`);
  }
  let active: AbortController | undefined;
  let activeCompletion: Promise<void> | undefined;
  let isClosed = false;
  const backend: ActivatedSessionBackend = {
    identity: { sessionId: randomUUID(), cwd: request.cwd },
    async execute(operation) {
      if (isClosed) throw new Error("pane session is closed");
      const controller = new AbortController();
      active = controller;
      let finish!: () => void;
      activeCompletion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        const remaining = Math.max(1, operation.deadline.unixMilliseconds - Date.now());
        const sent = await herdr(
          [
            "agent",
            "prompt",
            name,
            operation.prompt,
            "--wait",
            "--timeout",
            String(Math.min(config.settleTimeoutMs, remaining)),
          ],
          Math.min(config.settleTimeoutMs + 30_000, remaining),
          controller.signal,
        );
        if (!sent.ok) {
          return herdrFailure(
            sent,
            undefined,
            operation.deadline.unixMilliseconds - Date.now(),
          );
        }
        const read = await herdr(
          ["agent", "read", name, "--source", "detection"],
          Math.max(1, operation.deadline.unixMilliseconds - Date.now()),
          controller.signal,
        );
        const transcript = read.ok && read.stdout.trim() !== "" ? read.stdout : undefined;
        const agent = record(sent.result.agent) ?? sent.result;
        const sessionRef = readSessionRef(agent);
        const state = settledState(agent);
        return {
          state:
            state === "idle" || state === "done"
              ? "completed"
              : state === "blocked"
                ? "blocked"
                : "failed",
          ...(statusText(agent) ? { detail: statusText(agent) } : {}),
          resultEvidence: transcript
            ? { kind: "transcript" as const, text: transcript }
            : { kind: "unavailable" as const },
          ...(sessionRef ? { sessionRef } : {}),
          nativeUsage: [],
        };
      } finally {
        if (active === controller) active = undefined;
        finish();
      }
    },
    async cancel() {
      if (!active) return false;
      active.abort();
      await activeCompletion;
      return true;
    },
    async close() {
      active?.abort();
      await activeCompletion;
      await closeWorkspace();
      isClosed = true;
    },
  };
  return {
    backend,
    async readTranscript() {
      const read = await herdr(["agent", "read", name, "--source", "detection"]);
      return read.ok && read.stdout.trim() !== "" ? read.stdout : null;
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readId(value: unknown, key: string): string | undefined {
  const id = record(value)?.[key];
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Herdr reports the harness's own session as `{ kind, value }`, not as a bare string. */
function readSessionRef(agent: Record<string, unknown>): string | undefined {
  return readId(agent.agent_session, "value");
}

function readPaneId(result: Record<string, unknown>): string | null {
  const direct = result.pane_id;
  if (typeof direct === "string") return direct;
  return readId(result.root_pane ?? result.pane, "pane_id") ?? null;
}

function statusText(result: Record<string, unknown>): string | undefined {
  const status = result.agent_status ?? result.status ?? result.state;
  return typeof status === "string" ? status : undefined;
}

/** Anything Herdr reports that we do not recognize is `unknown`, never `done`. */
function settledState(result: Record<string, unknown>): SettledState {
  switch (statusText(result)) {
    case "idle":
      return "idle";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    default:
      return "unknown";
  }
}

function knownHarness(value: string): Harness {
  if (value === "claude" || value === "codex" || value === "pi" || value === "cursor") {
    return value;
  }
  throw new Error(`unsupported harness: ${value}`);
}

function bindingArgs(binding: HarnessOperationBinding | undefined): string[] {
  return [
        "--env",
        `WF_ENDPOINT=${binding?.endpoint ?? ""}`,
        "--env",
        `WF_OPERATION=${binding?.operationId ?? ""}`,
        "--env",
        `WF_CAPABILITY=${binding?.capability ?? ""}`,
      ];
}

const RESERVED_WORKSPACE_ENVIRONMENT = new Set([
  "PATH",
  "WF_ENDPOINT",
  "WF_OPERATION",
  "WF_CAPABILITY",
  "WF_RUN",
  "WF_CALL",
]);

function emptyEnvironmentArgs(names: readonly string[] | undefined): string[] {
  const args: string[] = [];
  for (const name of names ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid Herdr workspace environment name: ${name}`);
    }
    if (RESERVED_WORKSPACE_ENVIRONMENT.has(name)) {
      throw new Error(`Herdr workspace environment is adapter-owned: ${name}`);
    }
    args.push("--env", `${name}=`);
  }
  return args;
}

function safeAgentName(value: string, identity = value): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const rooted = /^[a-z]/.test(normalized) ? normalized : `a-${normalized}`;
  if (rooted === value && rooted.length <= 32 && identity === value) return rooted;

  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const prefix = rooted.slice(0, 19).replace(/[-_]+$/, "");
  return `${prefix}-${suffix}`;
}

function safeOperationDetail(
  detail: string,
  binding: HarnessOperationBinding | undefined,
): string {
  return binding &&
    (detail.includes(binding.operationId) || detail.includes(binding.capability))
    ? "pane operation failed without safe diagnostic detail"
    : detail;
}

function safeHostError(error: unknown, authorities: ReadonlySet<string>): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return containsProtectedAuthority(detail, authorities)
    ? new Error("Herdr run host cleanup failed without safe diagnostic detail")
    : error instanceof Error
      ? error
      : new Error(detail);
}

function safeProtectedDetail(
  detail: string,
  authorities: Iterable<string>,
  fallback: string,
): string {
  return containsProtectedAuthority(detail, authorities) ? fallback : detail;
}

function containsProtectedAuthority(
  text: string,
  authorities: Iterable<string>,
): boolean {
  const decoded = text
    .replace(/\\x([0-9a-f]{2})/gi, (_match, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_match, digits: string) =>
      String.fromCharCode(Number.parseInt(digits, 16)),
    );
  return [...authorities].some(
    (authority) => text.includes(authority) || decoded.includes(authority),
  );
}

function localOutcome(state: "failed" | "timed-out" | "cancelled", detail: string) {
  return {
    state,
    detail,
    resultEvidence: { kind: "unavailable" } as const,
    nativeUsage: [],
  };
}

function herdrFailure(
  result: Extract<HerdrResult, { ok: false }>,
  binding: HarnessOperationBinding | undefined,
  remainingMs: number,
) {
  if (result.cancelled) return localOutcome("cancelled", "pane operation cancelled");
  if (result.timedOut || remainingMs <= 0) {
    return localOutcome("timed-out", "pane operation timed out");
  }
  return localOutcome("failed", safeOperationDetail(result.error, binding));
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
