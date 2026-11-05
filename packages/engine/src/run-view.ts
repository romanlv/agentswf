import type {
  Activity,
  AgentStateJson,
  ClaimedAttempt,
  OperationLivenessRecord,
  RunLogLine,
  StageStateJson,
} from "@agentswf/contract/records";
import type { AgentKey, HarnessKind, JsonValue } from "@agentswf/contract/workflow";
import { messageOf } from "./errors";
import { readLines } from "./jsonl";
import { liveFile } from "./ops";
import { currentStage, estimateOf } from "./run-commands";
import { readRunLines } from "./run-lines";
import { type Cursor, type FileCache, readRun, timeOf } from "./run-read";
import type { RunStatus } from "./run-state";

/**
 * A stage of the attempt shown: running, reused or given from an earlier one, or how it ended. Its
 * outcome and value are its own `stage` line's, a reused one's the line it reused.
 */
export type StageView = {
  stage: string;
  state: StageStateJson;
  startedAt?: number;
  endedAt?: number;
  value?: JsonValue;
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
  state: AgentStateJson;
  turns: number;
  /** When its current operation, or its last, started. */
  since?: number;
  /** Its operation's latest phase, where it is waiting within it, or awaiting `peer`'s reply. */
  live?:
    | { phase: "waiting"; reason?: string; until?: number }
    | { phase: "awaiting-reply"; peer: string; until?: number };
  last?: { activity: Activity; at: string };
  sessions: { harness: HarnessKind; id: string; files: string[] }[];
};

export type DecisionView = { decision: number; key: string; askedAt: number; outcome?: string };

export type RunView = {
  status: RunStatus;
  /** The attempt shown: the last. */
  attempt?: ClaimedAttempt;
  stages: StageView[];
  /** Why the stages show no values: `run.jsonl` didn't read. */
  unread?: string;
  /** The stage running now, or the one the attempt ended in. */
  stage?: string;
  agents: AgentView[];
  decisions: DecisionView[];
  /** Over the attempts that kept one, at list prices: never what was billed. */
  estimate?: number;
  /** How many agent operations' usage isn't known: `estimate` is a floor. */
  unknownCost: number;
  lastEventAt?: number;
  lines: { number: number; line: RunLogLine }[];
  cursor: Cursor;
};

export async function viewRun(status: RunStatus): Promise<RunView> {
  const { run, attempts } = status;
  const attempt = attempts.at(-1);
  const files: FileCache = new Map();
  const read = await readRun(run.dir, run.record.cwd, undefined, {
    ended: status.state !== "running",
    files,
    tail: true,
  });
  const own = read.log.lines
    .map(({ line }) => line)
    .filter((line) => attempt === undefined || line.attempt === attempt.attempt);

  const stages: (StageView & { started?: string })[] = [];
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
        stages.push({ stage: line.stage, state: "running", startedAt: at, started: line.at });
        break;
      case "stage-ended": {
        // An event run enters a failed stage again in the same attempt: the end is the open one's.
        const started = stages.findLast(
          (each) => each.stage === line.stage && each.state === "running",
        );
        const state = line.source ?? line.outcome;
        if (started && line.source === undefined) Object.assign(started, { state, endedAt: at });
        else
          stages.push({ stage: line.stage, state, startedAt: at, endedAt: at, started: line.at });
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
  const unread = await withLines(stages, run.dir, attempt?.attempt);
  const stage = currentStage(status, read.log.lines);
  // A run whose process is gone left what it was doing undone.
  if (status.state === "interrupted") {
    for (const each of agents.values()) if (each.state === "working") each.state = "interrupted";
    for (const each of stages) if (each.state === "running") each.state = "interrupted";
  }
  if (status.state === "running") {
    for (const [id, key] of open) {
      const phase = await latestPhase(run.dir, id);
      const until = phase?.until === undefined ? {} : { until: phase.until };
      if (phase?.kind === "waiting") {
        agent(key).live = {
          phase: "waiting",
          ...(phase.reason === undefined ? {} : { reason: phase.reason }),
          ...until,
        };
      } else if (phase?.kind === "awaiting-reply" && phase.peer !== undefined) {
        agent(key).live = { phase: "awaiting-reply", peer: phase.peer, ...until };
      }
      // One word with `wfa peers`: the phase is the state; `live` keeps its detail.
      const { live } = agent(key);
      if (live && agent(key).state === "working") agent(key).state = live.phase;
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
      files: (files.get(session.n)?.files ?? []).map((file) => file.path),
    });
  }
  const { estimate, unknown } = await estimateOf(status);
  const lastLine = read.log.lines.at(-1)?.line;
  return {
    status,
    ...(attempt ? { attempt } : {}),
    stages: stages.map(({ started: _started, ...each }) => each),
    ...(unread === undefined ? {} : { unread }),
    ...(stage === undefined ? {} : { stage }),
    agents: [...agents.values()],
    decisions,
    ...(estimate === undefined ? {} : { estimate }),
    unknownCost: unknown,
    ...(lastLine ? { lastEventAt: Date.parse(timeOf(lastLine)) } : {}),
    lines: read.log.lines,
    cursor: read.cursor,
  };
}

/**
 * Each stage's outcome and value from `run.jsonl`. One that ran or was given takes its own line, of
 * attempt `attempt` with its name and `started`, ties by the order entered; a reused one takes the
 * line it reused, its stage's settled one. A stage running, or one the plan stopped, has no line,
 * and keeps what the log says.
 */
async function withLines(
  stages: (StageView & { started?: string })[],
  runDir: string,
  attempt: number | undefined,
): Promise<string | undefined> {
  let view: Awaited<ReturnType<typeof readRunLines>>["view"];
  try {
    ({ view } = await readRunLines(runDir));
  } catch (error) {
    // A run whose lines can't be read still shows its story from the log, and says what it lacks.
    return `run.jsonl could not be read, so stages show no values: ${messageOf(error)}`;
  }
  if (attempt === undefined) return undefined;
  const taken = new Set<unknown>();
  for (const entry of stages) {
    const stage = view.stages[entry.stage];
    if (!stage) continue;
    if (entry.state === "reused") {
      // The attempt shown is the latest, and a stage it reused it can't run again: no later
      // success than the one it reused.
      if (stage.settled?.value !== undefined) entry.value = stage.settled.value;
      continue;
    }
    const line = stage.history.find(
      (each) => each.attempt === attempt && each.started === entry.started && !taken.has(each),
    );
    if (!line) continue;
    taken.add(line);
    if (entry.state !== "provided") entry.state = line.outcome;
    // The log is best effort: an end it lost is the line's.
    entry.endedAt ??= Date.parse(line.at);
    if (line.value !== undefined) entry.value = line.value;
  }
  return undefined;
}

/** The latest phase a call's liveness file holds, which is diagnostics, best effort. */
async function latestPhase(
  runDir: string,
  operationId: string,
): Promise<OperationLivenessRecord | undefined> {
  const file = liveFile(runDir, operationId);
  return (await readLines<OperationLivenessRecord>(file).catch(() => [])).at(-1);
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
