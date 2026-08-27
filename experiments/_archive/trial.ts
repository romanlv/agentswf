import { join } from "node:path";
import { collect, instructions, nudge, type MethodContext , writeE2Call } from "./return-method"
import type { JsonSchema } from "./deps";
import { acceptAny, type SemanticCheck } from "./deps";
import { callDir, readAttempts, type Attempt } from "./deps";
import type { TurnUsage } from "./deps";
import type {
  AgentSessionBackend,
  BackendKind,
  CallResult,
  Harness,
  ReturnMethod,
  SettledState,
  Step,
} from "./deps";

export type Task = { question: string; prompt: string; schema?: JsonSchema };

export type TrialSpec = {
  runId: string;
  runDir: string;
  callId: string;
  harness: Harness;
  backend: BackendKind;
  method: ReturnMethod;
  index: number;
  task: Task;
  model?: string;
  cwd?: string;
};

/**
 * What the agent did on its own, before anything was said to it a second time. `corrected` is
 * kept apart from `accepted` because a value that was refused and then fixed inside the same
 * turn is E5's subject, not a clean delivery — and apart from `absent`, because an agent that
 * was refused has at least proved it knows the channel.
 */
export type FirstAttempt = "accepted" | "corrected" | "malformed" | "absent";

export type TrialOutcome = "unprompted" | "nudged" | "lost";

export type TrialRecord = {
  runId: string;
  callId: string;
  harness: Harness;
  backend: BackendKind;
  method: ReturnMethod;
  index: number;
  outcome: TrialOutcome;
  firstAttempt: FirstAttempt;
  /** The value the engine ends up with passed the result layer. False whenever none arrived. */
  wellFormed: boolean;
  nudged: boolean;
  settled: SettledState;
  settledDetail: string | null;
  settledAfterNudge: SettledState | null;
  settledAfterNudgeDetail: string | null;
  wallClockMs: number;
  firstTurnMs: number;
  nudgeTurnMs: number | null;
  /** What each turn cost, where the harness reports one. Absent is not zero. */
  firstTurnUsage: TurnUsage | null;
  nudgeTurnUsage: TurnUsage | null;
  /** The harness's own conversation id, for finding a transcript after the fact. */
  sessionRef: string | null;
  /** Why the result layer refused, when it did. */
  rejection: string | null;
  /** A backend failure, which is not the agent declining to report. */
  error: string | null;
  value: unknown;
};

export type TrialDeps = { now?: () => number; semantic?: SemanticCheck };

export function resultFilePath(runDir: string, callId: string): string {
  return join(callDir(runDir, callId), "agent-result.json");
}

export async function runTrial(
  spec: TrialSpec,
  backend: AgentSessionBackend,
  deps: TrialDeps = {},
): Promise<TrialRecord> {
  const now = deps.now ?? Date.now;
  const semantic = deps.semantic ?? acceptAny;
  const context: MethodContext = {
    runDir: spec.runDir,
    callId: spec.callId,
    filePath: resultFilePath(spec.runDir, spec.callId),
    schema: spec.task.schema,
  };

  await writeE2Call(spec.runDir, {
    callId: spec.callId,
    question: spec.task.question,
    method: spec.method,
    schema: spec.task.schema,
    ...(spec.method === "write-a-file" ? { filePath: context.filePath } : {}),
  });

  const step: Step = {
    prompt: spec.task.prompt,
    harness: spec.harness,
    backend: spec.backend,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.task.schema ? { schema: spec.task.schema } : {}),
  };

  const started = now();
  const base = {
    runId: spec.runId,
    callId: spec.callId,
    harness: spec.harness,
    backend: spec.backend,
    method: spec.method,
    index: spec.index,
  };

  let session;
  try {
    session = await backend.open(step, { runDir: spec.runDir, callId: spec.callId });
  } catch (error) {
    return {
      ...base,
      outcome: "lost",
      firstAttempt: "absent",
      wellFormed: false,
      nudged: false,
      settled: "unknown",
      settledDetail: null,
      settledAfterNudge: null,
      settledAfterNudgeDetail: null,
      wallClockMs: now() - started,
      firstTurnMs: now() - started,
      nudgeTurnMs: null,
      firstTurnUsage: null,
      nudgeTurnUsage: null,
      sessionRef: null,
      rejection: null,
      error: `backend could not open a session: ${message(error)}`,
      value: null,
    };
  }

  try {
    const turnStarted = now();
    const first = await session.prompt(
      `${spec.task.prompt}\n\n${instructions(spec.method, context)}`,
    );
    const firstTurnMs = now() - turnStarted;
    const collected = await collect(spec.method, context, await session.transcript(), semantic);
    const firstAttempts = await readAttempts(spec.runDir, spec.callId);
    const attempted = classify(firstAttempts);

    if (collected.kind === "value") {
      return {
        ...base,
        outcome: "unprompted",
        firstAttempt: attempted,
        wellFormed: true,
        nudged: false,
        settled: first.state,
        settledDetail: first.detail ?? null,
        settledAfterNudge: null,
        settledAfterNudgeDetail: null,
        wallClockMs: now() - started,
        firstTurnMs,
        nudgeTurnMs: null,
        firstTurnUsage: first.usage ?? null,
        nudgeTurnUsage: null,
        sessionRef: first.sessionRef ?? null,
        rejection: attempted === "corrected" ? lastError(firstAttempts) : null,
        error: null,
        value: collected.value,
      };
    }

    // Settled without a value. The agent still holds the task, so one line is all it should
    // take; whether that holds is the thing E2 is measuring.
    const firstError = collected.kind === "malformed" ? collected.error : undefined;
    const nudgeStarted = now();
    const second = await session.prompt(nudge(spec.method, context, firstError));
    const nudgeTurnMs = now() - nudgeStarted;
    const recovered = await collect(spec.method, context, await session.transcript(), semantic);

    return {
      ...base,
      outcome: recovered.kind === "value" ? "nudged" : "lost",
      firstAttempt: attempted,
      wellFormed: recovered.kind === "value",
      nudged: true,
      settled: first.state,
      settledDetail: first.detail ?? null,
      settledAfterNudge: second.state,
      settledAfterNudgeDetail: second.detail ?? null,
      wallClockMs: now() - started,
      firstTurnMs,
      nudgeTurnMs,
      firstTurnUsage: first.usage ?? null,
      nudgeTurnUsage: second.usage ?? null,
      sessionRef: second.sessionRef ?? first.sessionRef ?? null,
      rejection: recovered.kind === "malformed" ? recovered.error : (firstError ?? null),
      error: null,
      value: recovered.kind === "value" ? recovered.value : null,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "lost",
      firstAttempt: "absent",
      wellFormed: false,
      nudged: false,
      settled: "unknown",
      settledDetail: null,
      settledAfterNudge: null,
      settledAfterNudgeDetail: null,
      wallClockMs: now() - started,
      firstTurnMs: now() - started,
      nudgeTurnMs: null,
      firstTurnUsage: null,
      nudgeTurnUsage: null,
      sessionRef: null,
      rejection: null,
      error: `turn failed: ${message(error)}`,
      value: null,
    };
  } finally {
    await session.close().catch(() => {});
  }
}

/** How a trial reads to the engine, once E2 is over and this is a call rather than a sample. */
export function toCallResult(record: TrialRecord): CallResult {
  if (record.outcome !== "lost") return { kind: "answered", value: record.value };
  if (record.error) return { kind: "failed", reason: record.error };
  if (record.settledAfterNudge === "blocked" || record.settled === "blocked") {
    return { kind: "blocked", reason: record.settledDetail ?? "agent is blocked" };
  }
  return {
    kind: "finished",
    reason: record.rejection ?? "the turn ended without a value on the return channel",
  };
}

/** Reads the first turn's attempt log, which is the only place an in-turn correction shows. */
function classify(attempts: readonly Attempt[]): FirstAttempt {
  if (attempts.length === 0) return "absent";
  if (attempts[0]!.accepted) return "accepted";
  return attempts.some((attempt) => attempt.accepted) ? "corrected" : "malformed";
}

function lastError(attempts: readonly Attempt[]): string | null {
  return attempts.find((attempt) => !attempt.accepted)?.error ?? null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
