import { randomUUID } from "node:crypto";
import type { AgentRunHostFactory, AgentSessionAdapter } from "../adapter";
import { skillsLaunch } from "../capabilities/skills";
import { type RunProcess, runProcess } from "../command";
import { sandboxable, sandboxedArgs } from "../sandbox-needs";
import { createSessionAdapter, localOutcome } from "../session-core";
import { createSingleSessionHostFactory } from "../single-session-host";
import { HARNESS_NAMES, harnessSpec, knownHarness } from "../spec";
import { createSessionAccounting } from "../usage/accounting";

export type DirectProcessConfig = {
  newSessionId?: () => string;
  /** How long a follow-up waits for the previous, answered turn to end before stopping it. */
  finishGraceMs?: number;
};

/**
 * One subprocess per turn, stopped at the operation's deadline. The first turn starts a session;
 * a follow-up resumes it, which only works for a harness whose spec knows how — see `spec.ts`.
 * Nothing about the operation is in its environment: the agent is told the launcher's path in its
 * prompt.
 */
export function createHeadlessAdapter(
  config: DirectProcessConfig = {},
  run: RunProcess = runProcess,
): AgentSessionAdapter {
  const newSessionId = config.newSessionId ?? randomUUID;
  return createSessionAdapter({
    harnesses: HARNESS_NAMES,
    ...(config.finishGraceMs === undefined ? {} : { finishGraceMs: config.finishGraceMs }),
    placement: "headless",
    launchesInSandbox: true,
    givesSkills: true,
    async activate(request) {
      const harness = knownHarness(request.execution.harness);
      const spec = harnessSpec(harness);
      if (spec.meteredHeadless && request.execution.metered !== true) {
        throw new Error(
          `headless ${harness} is billed per token even on a subscription login; set metered: true to run it`,
        );
      }
      const { occupant } = request;
      if (occupant && !sandboxable(harness)) throw new Error(`${harness} cannot run in a sandbox`);
      const identity = { sessionId: newSessionId(), cwd: request.cwd };
      let hasExecuted = false;
      let closed = false;
      let active: AbortController | undefined;
      let activeCompletion: Promise<void> | undefined;
      return {
        identity,
        // Each turn is a process of its own, and the next one resumes the session this one leaves.
        finishesAnswered: true,
        async execute(operation) {
          if (closed) throw new Error("headless session is closed");
          const remaining = operation.deadline.unixMilliseconds - Date.now();
          if (remaining <= 0) {
            return localOutcome("timed-out", "operation deadline exceeded");
          }
          if (hasExecuted && !operation.previousSessionRef) {
            return localOutcome(
              "failed",
              `${harness} produced no resumable native session reference`,
            );
          }
          if (operation.previousSessionRef && !spec.resumeTurn) {
            return localOutcome(
              "failed",
              `${harness} has no confirmed headless resume, so the operation could not continue`,
            );
          }
          const prompt =
            !operation.previousSessionRef && request.instructions
              ? `${request.instructions}\n\n${operation.prompt}`
              : operation.prompt;
          hasExecuted = true;
          // Every turn, a resumed one too: none of them remembers the last one's arguments.
          const skills = request.skills ? await skillsLaunch(harness, request.skills) : undefined;
          const launchArgs = [...(occupant ? sandboxedArgs(harness) : []), ...(skills?.args ?? [])];
          const context = {
            ...(request.execution.model ? { model: request.execution.model } : {}),
            sessionHint: identity.sessionId,
            ...(launchArgs.length > 0 ? { launchArgs } : {}),
          };
          const plan = operation.previousSessionRef
            ? spec.resumeTurn!(prompt, operation.previousSessionRef, context)
            : spec.headlessTurn(prompt, context);
          const controller = new AbortController();
          active = controller;
          const command = {
            argv: plan.argv,
            cwd: request.cwd,
            env: { ...skills?.env },
            ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
            timeoutMs: Math.max(1, remaining),
            signal: controller.signal,
          };
          // Every turn, a resumed one too, runs inside when the agent has a place there.
          const running = run(occupant ? occupant.launch(command) : command);
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
          // Never the id we generated unless the plan handed it over: resuming one the harness never
          // saw fails as an opaque exit instead of saying no session came back. A handed-over id is
          // dropped when the process failed on its own, which may be before it made a session:
          // resuming it would silently start a new one without the agent's instructions. A turn we
          // stopped, as after its answer, did run.
          const failedToRun = result.exitCode !== 0 && !result.cancelled && !result.timedOut;
          const nativeSession =
            spec.readSessionId?.(result.stdout) ??
            (failedToRun ? undefined : plan.sessionId) ??
            operation.previousSessionRef;
          if (nativeSession) identity.sessionId = nativeSession;
          const charge = spec.readCharge?.(result.stdout);
          const common = {
            resultEvidence: transcript
              ? ({ kind: "transcript", text: transcript } as const)
              : ({ kind: "unavailable" } as const),
            ...(nativeSession ? { sessionRef: nativeSession } : {}),
            chargesUsd: charge === undefined ? [] : [charge],
          };
          if (result.cancelled) {
            return { state: "cancelled" as const, detail: "agent process cancelled", ...common };
          }
          if (result.timedOut) {
            return {
              state: "timed-out" as const,
              detail: "timed out at operation deadline",
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
}

/** The production headless host: a subprocess per turn, billed with the credentials `run` gives. */
export function createHeadlessRunHostFactory(
  config: DirectProcessConfig = {},
  run: RunProcess = runProcess,
): AgentRunHostFactory {
  return createSingleSessionHostFactory(
    createHeadlessAdapter(config, run),
    createSessionAccounting(run),
  );
}
