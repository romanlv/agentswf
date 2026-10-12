import { join } from "node:path";
import type {
  Activity,
  AttemptRecord,
  OperationLivenessRecord,
  RunLogLine,
} from "@agentswf/contract/records";
import type { AgentKey, HarnessKind, StageOutcome } from "@agentswf/contract/workflow";
import { readLines } from "./jsonl";
import { currentStage, estimateOf } from "./run-commands";
import { type Cursor, type FileCache, readRun, timeOf } from "./run-read";
import type { RunStatus } from "./run-state";

/** A stage of the attempt shown: running, reused or given from an earlier one, or how it ended. */
export type StageView = {
  stage: string;
  state: "running" | "interrupted" | "reused" | "provided" | StageOutcome;
  startedAt?: number;
  endedAt?: number;
};

/**
 * An agent of the attempt shown, as its operations leave it: working on one, or its last one's
 * outcome. What its liveness file and native files say of it is best effort, and kept apart.
 */
export type AgentView = {
  key: AgentKey;
  harness?: HarnessKind;
  caller: boolean;
  /** The stage its last operation ran in. */
  stage?: string;
  state: string;
  turns: number;
  /** When its current operation, or its last, started. */
  since?: number;
  /** Its operation's latest phase, where it is waiting within it. */
  live?: { phase: "waiting"; reason?: string; until?: number };
  last?: { activity: Activity; at: string };
  sessions: { harness: HarnessKind; id: string; files: string[] }[];
};

export type DecisionView = { decision: number; key: string; askedAt: number; outcome?: string };

export type RunView = {
  status: RunStatus;
  /** The attempt shown: the last. */
  attempt?: AttemptRecord;
  stages: StageView[];
  /** The stage running now, or the one the attempt ended in. */
  stage?: string;
  agents: AgentView[];
  decisions: DecisionView[];
  /** Over the attempts that kept one, at list prices: never what was billed. */
  estimate?: number;
  lastEventAt?: number;
  lines: { number: number; line: RunLogLine }[];
  cursor: Cursor;
};

export async function viewRun(status: RunStatus): Promise<RunView> {
  const { run, attempts } = status;
  const attempt = attempts.at(-1);
  const files: FileCache = { lines: -1, sessions: new Map() };
  const read = await readRun(run.dir, run.record.cwd, undefined, {
    ended: status.state !== "running",
    files,
  });
  const own = read.log.lines
    .map(({ line }) => line)
    .filter((line) => attempt === undefined || line.attempt === attempt.attempt);

  const stages: StageView[] = [];
  const decisions: DecisionView[] = [];
  const agents = new Map<AgentKey, AgentView>();
  const open = new Map<string, AgentKey>();
  const agent = (key: AgentKey) => {
    const found = agents.get(key) ?? {
      key,
      caller: read.log.agents.get(key)?.caller ?? false,
      state: "idle",
      turns: 0,
      sessions: [],
    };
    agents.set(key, found);
    return found;
  };
  for (const line of own) {
    const at = Date.parse(timeOf(line));
    switch (line.kind) {
      case "stage-started":
        stages.push({ stage: line.stage, state: "running", startedAt: at });
        break;
      case "stage-ended": {
        const started = stages.find((each) => each.stage === line.stage);
        const state = line.source ?? line.outcome;
        if (started) Object.assign(started, { state, endedAt: at });
        else stages.push({ stage: line.stage, state, startedAt: at, endedAt: at });
        break;
      }
      case "agent-opened":
        agent(line.agent).harness = line.harness;
        break;
      case "operation-started": {
        const started = agent(line.agent);
        Object.assign(started, { state: "working", since: at, harness: line.execution.harness });
        if (line.stage !== undefined) started.stage = line.stage;
        open.set(line.operationId, line.agent);
        break;
      }
      case "turn":
      case "compact":
      case "operation-failed": {
        const settled = agent(line.agent);
        open.delete(line.operationId);
        if (line.stage !== undefined) settled.stage = line.stage;
        settled.harness ??= line.execution.harness;
        settled.state = line.kind === "operation-failed" ? "failed" : line.outcome;
        if (line.kind === "turn") settled.turns += 1;
        break;
      }
      case "agent-stopped":
        if (agent(line.agent).state === "working") agent(line.agent).state = "stopped";
        break;
      case "decision-asked":
        decisions.push({ decision: line.decision, key: line.key, askedAt: at });
        break;
      case "decision-ended": {
        const asked = decisions.find((each) => each.decision === line.decision);
        if (asked) asked.outcome = line.outcome;
        break;
      }
    }
  }
  const stage = currentStage(status, read.log.lines);
  // A run whose process is gone left what it was doing undone.
  if (status.state === "interrupted") {
    for (const each of agents.values()) if (each.state === "working") each.state = "was working";
    for (const each of stages) if (each.state === "running") each.state = "interrupted";
  }
  if (status.state === "running") {
    for (const [id, key] of open) {
      const phase = await latestPhase(run.dir, id);
      if (phase?.kind !== "waiting") continue;
      agent(key).live = {
        phase: "waiting",
        ...(phase.reason === undefined ? {} : { reason: phase.reason }),
        ...(phase.until === undefined ? {} : { until: phase.until }),
      };
    }
  }
  const since = attempt ? Date.parse(attempt.started) : Number.NEGATIVE_INFINITY;
  for (const event of read.events) {
    if (event.source !== "activity" || !event.agent || event.time < since) continue;
    const seen = agents.get(event.agent);
    if (seen) seen.last = { activity: event.activity, at: event.at };
  }
  for (const session of read.log.sessions) {
    const seen = session.agent ? agents.get(session.agent) : undefined;
    if (!seen) continue;
    seen.sessions.push({
      harness: session.harness,
      id: session.id,
      files: (files.sessions.get(session.n) ?? []).map((file) => file.path),
    });
  }
  const estimate = estimateOf(attempts);
  const lastLine = read.log.lines.at(-1)?.line;
  return {
    status,
    ...(attempt ? { attempt } : {}),
    stages,
    ...(stage === undefined ? {} : { stage }),
    agents: [...agents.values()],
    decisions,
    ...(estimate === undefined ? {} : { estimate }),
    ...(lastLine ? { lastEventAt: Date.parse(timeOf(lastLine)) } : {}),
    lines: read.log.lines,
    cursor: read.cursor,
  };
}

/** The latest phase a call's liveness file holds, which is diagnostics, best effort. */
async function latestPhase(
  runDir: string,
  operationId: string,
): Promise<OperationLivenessRecord | undefined> {
  const file = join(runDir, "calls", operationId, "liveness.jsonl");
  return (await readLines<OperationLivenessRecord>(file).catch(() => [])).at(-1);
}

/** `45s`, `6m40s`, `1h02m`. */
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** An activity in a few words: `tool Bash bun test → exit 0`, `message 412 chars`. */
export function describeActivity(activity: Activity): string {
  switch (activity.type) {
    case "message":
      return `${activity.from === "user" ? "prompt" : "message"}  ${activity.chars.toLocaleString("en-US")} chars`;
    case "tool":
      return `tool ${activity.tool}${activity.input ? `  ${activity.input}` : ""}${activity.background ? "  (background)" : ""}`;
    case "tool-result":
      return activity.exit !== undefined
        ? `→ exit ${activity.exit}`
        : activity.error
          ? "→ error"
          : "→ ok";
    case "background-ended":
      return "background task ended";
    case "compaction":
      return "compacted";
  }
}
