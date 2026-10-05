import { randomUUID } from "node:crypto";
import type { AbsoluteDeadline } from "@agentswf/contract/workflow";
import type {
  AgentRunHostFactory,
  AgentSessionAdapter,
  NativeFork,
  SessionCopy,
  SessionSettings,
} from "../adapter";
import { skillsLaunch } from "../capabilities/skills";
import { type RunProcess, runProcess } from "../command";
import { failedOnLogin } from "../harnesses/login";
import { launchSettings } from "../harnesses/shared";
import { headlessRefusal } from "../refusals";
import { sandboxedArgs } from "../sandbox-needs";
import { createSessionAdapter, localOutcome } from "../session-core";
import { createSingleSessionHostFactory } from "../single-session-host";
import { harnessSpec, knownHarness, PLACEMENT_HARNESSES } from "../spec";
import { harnessState } from "../state";
import { createSessionAccounting } from "../usage/accounting";
import { copySession, forkCommand, forkDeadline, forkResult } from "./fork";

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
    harnesses: PLACEMENT_HARNESSES.headless,
    ...(config.finishGraceMs === undefined ? {} : { finishGraceMs: config.finishGraceMs }),
    placement: "headless",
    launchesInSandbox: true,
    givesSkills: true,
    continues: true,
    async activate(request) {
      const refused = headlessRefusal(request);
      if (refused) throw new Error(refused);
      const harness = knownHarness(request.execution.harness);
      const spec = harnessSpec(harness);
      const { occupant } = request;
      const identity = {
        sessionId: request.continues?.sessionRef ?? newSessionId(),
        cwd: request.cwd,
      };
      let hasExecuted = false;
      /**
       * The session's running total as the harness last printed it: a new session's is nothing, a
       * fork's is what was printed when it was made, its parent's. Unknown, the next total charges
       * nothing rather than its parent's spend again.
       */
      let costTotal: number | undefined = request.continues ? request.continues.costTotal : 0;
      /** The instructions go with the first turn, not a compaction, a forked session's too. */
      let instructed = false;
      /** What each turn is launched at: as activated, then as the last `set` left it. */
      let settings = launchSettings(request.execution);
      /** Every turn, a resumed one too: none of them remembers the last one's arguments. */
      const launchContext = async () => {
        const skills = request.skills ? await skillsLaunch(harness, request.skills) : undefined;
        const launchArgs = [...(occupant ? sandboxedArgs(harness) : []), ...(skills?.args ?? [])];
        return {
          env: { ...skills?.env },
          context: {
            ...settings,
            sessionHint: identity.sessionId,
            ...(launchArgs.length > 0 ? { launchArgs } : {}),
            ...(request.home ? { home: request.home } : {}),
          },
        };
      };
      let closed = false;
      let active: AbortController | undefined;
      let activeCompletion: Promise<void> | undefined;
      type ActiveProcess = {
        setDeadline(at: number): void;
        result: Promise<Awaited<ReturnType<RunProcess>>>;
      };
      let activeProcess: Promise<ActiveProcess | undefined> | undefined;
      /** The harness's own fork of `sessionRef`, run where this agent's turns run. */
      const runFork = async (sessionRef: string, deadline: AbsoluteDeadline) => {
        const { env, context } = await launchContext();
        if (closed) throw new Error("headless session is closed");
        const plan = await spec.forkSession!(sessionRef, newSessionId(), context);
        const controller = new AbortController();
        const command = forkCommand(plan, {
          cwd: request.cwd,
          env,
          deadline,
          signal: controller.signal,
        });
        active = controller;
        const { holdStdinUntil, ...process } = command;
        const running = run(occupant ? { ...occupant.launch(process), holdStdinUntil } : command);
        activeCompletion = running.then(
          () => undefined,
          () => undefined,
        );
        const result = await running.finally(() => {
          if (active === controller) active = undefined;
        });
        return forkResult(harness, plan, result, deadline);
      };
      // A session copied into this agent's home is forked here, before its first turn resumes it.
      if (request.continues?.copied) {
        if (!spec.forkSession) throw new Error(`${harness} cannot fork`);
        const forked = await runFork(request.continues.sessionRef, forkDeadline(request.deadline));
        identity.sessionId = forked.sessionRef;
        costTotal = forked.costTotal;
      }
      return {
        identity,
        // Each turn is a process of its own, and the next one resumes the session this one leaves.
        finishesAnswered: true,
        async finishAnswered(deadline) {
          const original = await activeProcess;
          if (!original) return localOutcome("failed", "no native process completion to observe");
          original.setDeadline(deadline.unixMilliseconds);
          const result = await original.result;
          if (result.timedOut)
            return localOutcome("timed-out", "native process exceeded its release deadline");
          if (result.cancelled) return localOutcome("cancelled", "native process was cancelled");
          if (result.exitCode !== 0)
            return localOutcome("failed", `native process exited with status ${result.exitCode}`);
          return { state: "completed", resultEvidence: { kind: "unavailable" }, chargesUsd: [] };
        },
        async execute(operation) {
          const processReady = Promise.withResolvers<ActiveProcess | undefined>();
          activeProcess = processReady.promise;
          try {
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
            if (operation.kind === "compact") {
              if (!spec.compactHeadless) {
                return localOutcome(
                  "failed",
                  `${harness} has no compaction of its own: ${spec.absent.compactHeadless}`,
                );
              }
              if (!operation.previousSessionRef) {
                return localOutcome("failed", "there is nothing to compact before the first turn");
              }
            }
            const prompt =
              !instructed && operation.kind !== "compact" && request.instructions
                ? `${request.instructions}\n\n${operation.prompt}`
                : operation.prompt;
            if (operation.kind !== "compact") instructed = true;
            hasExecuted = true;
            const { env, context } = await launchContext();
            const compaction =
              operation.kind === "compact"
                ? spec.compactHeadless!(operation.prompt, operation.previousSessionRef!, context)
                : undefined;
            const plan =
              compaction ??
              (operation.previousSessionRef
                ? spec.resumeTurn!(prompt, operation.previousSessionRef, context)
                : spec.headlessTurn(prompt, context));
            const controller = new AbortController();
            active = controller;
            const command = {
              argv: plan.argv,
              cwd: request.cwd,
              env,
              ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
              timeoutMs: Math.max(1, remaining),
              signal: controller.signal,
            };
            const holding = compaction?.holdStdinUntil
              ? { holdStdinUntil: compaction.holdStdinUntil }
              : {};
            // Every turn, a resumed one too, runs inside when the agent has a place there.
            let processDeadline = operation.deadline.unixMilliseconds;
            const timeoutAt = () => processDeadline;
            const running = run(
              occupant
                ? { ...occupant.launch(command), ...holding, timeoutAt }
                : { ...command, ...holding, timeoutAt },
            );
            processReady.resolve({
              setDeadline(at) {
                processDeadline = at;
              },
              result: running,
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
            // Never the id we generated unless the plan handed it over: resuming one the harness never
            // saw fails as an opaque exit instead of saying no session came back. A handed-over id is
            // dropped when the process failed on its own, which may be before it made a session:
            // resuming it would silently start a new one without the agent's instructions. A turn we
            // stopped, as after its answer, did run. A session the plan names, or the one resumed,
            // wins over the one the output does: a pi fork, resumed by its file, prints its parent's
            // id, which would point the next turn at the parent.
            const failedToRun = result.exitCode !== 0 && !result.cancelled && !result.timedOut;
            const nativeSession = failedToRun
              ? (operation.previousSessionRef ?? spec.readSessionId?.(result.stdout))
              : (plan.sessionId ??
                spec.readSessionId?.(result.stdout) ??
                operation.previousSessionRef);
            if (nativeSession) identity.sessionId = nativeSession;
            // What it printed of its usage is all there is of it; a turn's answer never waits on it.
            if (nativeSession && !compaction) {
              await spec
                .keepTurnUsage?.(result.stdout, nativeSession, context)
                .catch(() => undefined);
            }
            let charge = spec.readCharge?.(result.stdout);
            const total = spec.readCostTotal?.(result.stdout);
            if (total !== undefined) {
              // A resume that started a session of its own, or a total below the last, is no running
              // sum of the session before: all of it is this turn's.
              const before =
                nativeSession === operation.previousSessionRef || !operation.previousSessionRef
                  ? costTotal
                  : 0;
              charge =
                before === undefined
                  ? undefined
                  : total >= before
                    ? roundUsd(total - before)
                    : total;
              costTotal = total;
            }
            const common = {
              resultEvidence: transcript
                ? ({ kind: "transcript", text: transcript } as const)
                : ({ kind: "unavailable" } as const),
              ...(nativeSession ? { sessionRef: nativeSession } : {}),
              chargesUsd: charge === undefined ? [] : [charge],
            };
            // What the harness printed decides a compaction it answered, not how it was made to exit.
            if (compaction && result.answered && !result.cancelled) {
              const read = compaction.read(result.stdout);
              if ("summary" in read) {
                return { state: "completed" as const, ...common, summary: read.summary };
              }
            }
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
            // pi's refused login exits 0, so it is read before the exit code.
            const login = failedOnLogin(harness, spec.login, (check) =>
              check.headless(result.stdout, result.stderr),
            );
            if (login) return { ...login, ...common };
            if (result.exitCode !== 0) {
              return {
                state: "failed" as const,
                detail: `${plan.argv[0]} exited ${result.exitCode}: ${result.stderr.trim().slice(0, 400)}`,
                ...common,
              };
            }
            if (compaction) {
              const read = compaction.read(result.stdout);
              return "error" in read
                ? { state: "failed" as const, detail: read.error, ...common }
                : { state: "completed" as const, ...common, summary: read.summary };
            }
            return { state: "completed" as const, ...common };
          } finally {
            processReady.resolve(undefined);
          }
        },
        ...(spec.forkSession
          ? {
              async fork(
                sessionRef: string,
                deadline: AbsoluteDeadline,
                into?: SessionCopy,
              ): Promise<NativeFork> {
                if (closed) throw new Error("headless session is closed");
                // A home of its own is carried whole; the new agent forks it in its own.
                if (into) {
                  return copySession(
                    harness,
                    request.home ?? harnessState()[harness],
                    sessionRef,
                    request.cwd,
                    into,
                  );
                }
                if (occupant) throw new Error("a sandboxed agent's session is forked by copy");
                return runFork(sessionRef, deadline);
              },
            }
          : {}),
        // The next turn resumes at them: each turn is a launch of its own (M1).
        ...(spec.setHeadless
          ? {
              async set(next: SessionSettings) {
                if (closed) throw new Error("headless session is closed");
                settings = launchSettings(next);
              },
            }
          : {}),
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

/** A difference of two printed totals, without the float noise subtraction leaves. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}
