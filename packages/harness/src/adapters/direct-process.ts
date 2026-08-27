import { randomUUID } from "node:crypto";
import { runProcess, type RunProcess } from "../command";
import { harnessSpec } from "../spec";
import type {
  AgentSession,
  AgentSessionDriver,
  CallIdentity,
  Step,
  TurnOutcome,
} from "../types";

export type DirectProcessConfig = {
  turnTimeoutMs: number;
  /** Prepended to PATH so the agent's `wf` is this run's `wf`. */
  binDir?: string;
  newSessionId?: () => string;
};

/**
 * One subprocess per turn. The first turn starts a session; a nudge resumes it, which only
 * works for a harness whose spec knows how — see `spec.ts`.
 */
export function createDirectProcessAdapter(
  config: DirectProcessConfig,
  run: RunProcess = runProcess,
): AgentSessionDriver {
  const newSessionId = config.newSessionId ?? randomUUID;
  return {
    kind: "headless",
    async open(step: Step, call: CallIdentity): Promise<AgentSession> {
      const spec = harnessSpec(step.harness);
      const env: Record<string, string> = {
        WF_RUN: call.runDir,
        WF_CALL: call.callId,
        ...(config.binDir ? { PATH: `${config.binDir}:${process.env.PATH ?? ""}` } : {}),
      };
      const context = {
        ...(step.model ? { model: step.model } : {}),
        sessionHint: newSessionId(),
      };
      let sessionId: string | null = null;
      let transcript = "";

      return {
        async prompt(text: string): Promise<TurnOutcome> {
          if (sessionId !== null && !spec.resumeTurn) {
            return {
              state: "unknown",
              detail: `${step.harness} has no confirmed headless resume, so the turn could not be continued`,
            };
          }
          const plan =
            sessionId === null
              ? spec.headlessTurn(text, context)
              : spec.resumeTurn!(text, sessionId, context);

          const result = await run({
            argv: plan.argv,
            cwd: step.cwd,
            env,
            ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
            timeoutMs: config.turnTimeoutMs,
          });
          transcript += spec.readTranscript
            ? spec.readTranscript(result.stdout)
            : result.stdout;
          sessionId = spec.readSessionId?.(result.stdout) ?? sessionId ?? context.sessionHint;
          const extra = {
            ...(spec.readUsage ? { usage: spec.readUsage(result.stdout) } : {}),
            sessionRef: sessionId,
          };

          if (result.timedOut) {
            return {
              state: "unknown",
              detail: `timed out after ${config.turnTimeoutMs}ms`,
              ...extra,
            };
          }
          if (result.exitCode !== 0) {
            return {
              state: "unknown",
              detail: `${plan.argv[0]} exited ${result.exitCode}: ${result.stderr.trim().slice(0, 400)}`,
              ...extra,
            };
          }
          return { state: "done", ...extra };
        },
        async transcript(): Promise<string | null> {
          return transcript;
        },
        async close(): Promise<void> {},
      };
    },
  };
}
