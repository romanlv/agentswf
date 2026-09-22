import { randomUUID } from "node:crypto";
import type { HarnessKind } from "@wf/contract/workflow";
import type { AgentSessionAdapter } from "../adapter";
import { runProcess, type RunProcess } from "../command";
import { createSessionAdapter } from "../session-core";
import { createLegacyDriver } from "../legacy-driver";
import { harnessSpec } from "../spec";
import type { AgentSessionDriver, CallIdentity, Harness } from "../types";

export type DirectProcessConfig = {
  turnTimeoutMs: number;
  /** Prepended to PATH for the frozen legacy driver, whose `wf` is still found by name. */
  binDir?: string;
  newSessionId?: () => string;
};

const SUPPORTED_HARNESSES = ["claude", "codex", "pi", "cursor"] as const;

export function createHeadlessAdapter(
  config: DirectProcessConfig,
  run: RunProcess = runProcess,
): AgentSessionAdapter {
  // Nothing about the operation: the agent is told the launcher's path in its prompt.
  return createHeadlessAdapterCore(config, run, () => ({}));
}

function createHeadlessAdapterCore(
  config: DirectProcessConfig,
  run: RunProcess,
  environment: () => Record<string, string>,
  legacy = false,
): AgentSessionAdapter & { legacySessionRef(): string | undefined } {
  const newSessionId = config.newSessionId ?? randomUUID;
  let legacySessionRef: string | undefined;
  const adapter = createSessionAdapter({
    harnesses: SUPPORTED_HARNESSES,
    observeSessionRef: (sessionRef) => {
      legacySessionRef = sessionRef;
    },
    async activate(request) {
      const harness = knownHarness(request.execution.harness);
      const spec = harnessSpec(harness);
      const identity = { sessionId: newSessionId(), cwd: request.cwd };
      let hasExecuted = false;
      let closed = false;
      let active: AbortController | undefined;
      let activeCompletion: Promise<void> | undefined;
      return {
        identity,
        async execute(operation) {
          if (closed) throw new Error("headless session is closed");
          const remaining = operation.deadline.unixMilliseconds - Date.now();
          if (remaining <= 0) {
            return outcome("timed-out", "operation deadline exceeded");
          }
          if (hasExecuted && !operation.previousSessionRef) {
            return outcome("failed", `${harness} produced no resumable native session reference`);
          }
          if (operation.previousSessionRef && !spec.resumeTurn) {
            return outcome(
              "failed",
              `${harness} has no confirmed headless resume, so the operation could not continue`,
            );
          }
          const prompt =
            !operation.previousSessionRef && request.instructions
              ? `${request.instructions}\n\n${operation.prompt}`
              : operation.prompt;
          hasExecuted = true;
          const context = {
            ...(request.execution.model ? { model: request.execution.model } : {}),
            sessionHint: identity.sessionId,
          };
          const plan = operation.previousSessionRef
            ? spec.resumeTurn!(prompt, operation.previousSessionRef, context)
            : spec.headlessTurn(prompt, context);
          const controller = new AbortController();
          active = controller;
          const nativeTimeoutMs = Math.max(1, Math.min(config.turnTimeoutMs, remaining));
          const running = run({
            argv: plan.argv,
            cwd: request.cwd,
            env: environment(),
            ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
            timeoutMs: nativeTimeoutMs,
            signal: controller.signal,
          });
          activeCompletion = running.then(
            () => undefined,
            () => undefined,
          );
          const result = await running.finally(() => {
            if (active === controller) active = undefined;
          });
          const transcript = spec.readTranscript
            ? spec.readTranscript(result.stdout)
            : result.stdout;
          const nativeSession =
            spec.readSessionId?.(result.stdout) ?? operation.previousSessionRef ?? identity.sessionId;
          if (nativeSession) identity.sessionId = nativeSession;
          const common = {
            resultEvidence: transcript
              ? ({ kind: "transcript", text: transcript } as const)
              : ({ kind: "unavailable" } as const),
            ...(nativeSession ? { sessionRef: nativeSession } : {}),
            nativeUsage: spec.readUsage ? [spec.readUsage(result.stdout)] : [],
          };
          if (result.cancelled) {
            return { state: "cancelled" as const, detail: "agent process cancelled", ...common };
          }
          if (result.timedOut) {
            return {
              state: "timed-out" as const,
              detail: legacy
                ? `timed out after ${config.turnTimeoutMs}ms`
                : nativeTimeoutMs === config.turnTimeoutMs && config.turnTimeoutMs < remaining
                  ? `native turn timed out after ${config.turnTimeoutMs}ms`
                  : "timed out at operation deadline",
              ...common,
            };
          }
          if (result.exitCode !== 0) {
            return {
              state: "failed" as const,
              detail: `${plan.argv[0]} exited ${result.exitCode}: ${result.stderr.trim().slice(0, 400)}`,
              ...common,
            };
          }
          return { state: "completed" as const, ...common };
        },
        async close() {
          closed = true;
          active?.abort();
          await activeCompletion;
        },
        async cancel() {
          if (!active) return false;
          active.abort();
          await activeCompletion;
          return true;
        },
      };
    },
  });
  return Object.assign(adapter, { legacySessionRef: () => legacySessionRef });
}

/**
 * One subprocess per turn. The first turn starts a session; a nudge resumes it, which only
 * works for a harness whose spec knows how — see `spec.ts`.
 */
export function createDirectProcessAdapter(
  config: DirectProcessConfig,
  run: RunProcess = runProcess,
): AgentSessionDriver {
  return createLegacyDriver({
    kind: "headless",
    timeoutMs: config.turnTimeoutMs,
    adapter(call: CallIdentity) {
      const environment = (): Record<string, string> => ({
        WF_RUN: call.runDir,
        WF_CALL: call.callId,
        ...(config.binDir ? { PATH: `${config.binDir}:${process.env.PATH ?? ""}` } : {}),
      });
      return createHeadlessAdapterCore(config, run, environment, true);
    },
  });
}

function knownHarness(value: HarnessKind): Harness {
  if (SUPPORTED_HARNESSES.includes(value as Harness)) return value as Harness;
  throw new Error(`unsupported harness: ${value}`);
}

function outcome(state: "timed-out" | "failed", detail: string) {
  return {
    state,
    detail,
    resultEvidence: { kind: "unavailable" } as const,
    nativeUsage: [],
  };
}
