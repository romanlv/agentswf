import type { StageOutcome } from "@agentswf/contract/records";
import { placementOf } from "@agentswf/contract/workflow";
import { duration } from "./accounting/format";
import type { StageProgress } from "./stage-ledger";
import type { WorkflowRunSnapshot } from "./workflow-runner";

type Agent = WorkflowRunSnapshot["agents"][number];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Past this, an active stage lists only what is running or went wrong, then a count. */
const MAX_LISTED = 8;

export type Paint = {
  dim(text: string): string;
  ok(text: string): string;
  bad(text: string): string;
  busy(text: string): string;
};

export const PLAIN: Paint = { dim: (t) => t, ok: (t) => t, bad: (t) => t, busy: (t) => t };
export const ANSI: Paint = {
  dim: (t) => `\x1b[2m${t}\x1b[22m`,
  ok: (t) => `\x1b[32m${t}\x1b[39m`,
  bad: (t) => `\x1b[31m${t}\x1b[39m`,
  busy: (t) => `\x1b[33m${t}\x1b[39m`,
};

/**
 * The live block: the run's stages in the order entered, the current one with its agents, and
 * those an earlier attempt recorded still to come; then one line per labelled `parallel`, and
 * under the active ones, the agents worth watching.
 */
export function renderProgress(
  snapshot: WorkflowRunSnapshot,
  view: { name: string; startedAt: number; now: number; paint: Paint },
): string[] {
  const { now, paint } = view;
  const working = snapshot.agents.filter(isRunning).length;
  const current = snapshot.stages.findLast((stage) => stage.endedAt === undefined);
  const lines = [
    `${view.name}${current ? ` · ${current.stage}` : ""} ${paint.dim(`· ${duration(now - view.startedAt)}`)}${working ? paint.dim(` · ${working} working`) : ""}`,
  ];
  lines.push(...stageLines(snapshot, now, paint));
  const width = Math.max(...snapshot.agents.map((agent) => agent.key.length), 0);
  const model = Math.max(...snapshot.agents.map((agent) => agent.execution.model.length), 0);
  const agentLine = (agent: Agent) => {
    const [mark, note] = agentState(agent, now, paint);
    const took = agent.turn ? duration((agent.turn.settledAt ?? now) - agent.turn.startedAt) : "";
    return `    ${mark} ${agent.key.padEnd(width)}  ${paint.dim(agent.execution.model.padEnd(model))}  ${took.padStart(6)}${note ? `  ${note}` : ""}`;
  };
  const listAgents = (agents: readonly Agent[]) => {
    const shown =
      agents.length <= MAX_LISTED ? agents : agents.filter((a) => isRunning(a) || isFailed(a));
    lines.push(...shown.slice(0, MAX_LISTED).map(agentLine));
    const hidden = agents.length - Math.min(shown.length, MAX_LISTED);
    if (hidden > 0) lines.push(paint.dim(`    … ${hidden} more`));
  };

  // Under the current stage, the agents are listed there instead.
  const inStage = (agent: Agent) => current !== undefined && agent.turn?.stage === current.stage;
  snapshot.groups.forEach((group, index) => {
    const members = snapshot.agents.filter((agent) => agent.group === index);
    const agents = members.filter((agent) => !inStage(agent));
    const failed = members.filter(isFailed).length;
    const failures = failed ? paint.bad(` · ${failed} failed`) : "";
    if (group.endedAt !== undefined) {
      const mark = failed ? paint.bad("✗") : paint.ok("✓");
      lines.push(
        `${mark} ${group.label} ${paint.dim(`${group.done}/${group.total} · ${duration(group.endedAt - group.startedAt)}`)}${failures}`,
      );
      listAgents(agents.filter(isFailed));
      return;
    }
    const queued = group.total - group.started;
    lines.push(
      `${paint.busy(spin(now))} ${group.label} ${paint.dim(`${group.done}/${group.total}${queued ? ` · ${queued} queued` : ""}`)}${failures}`,
    );
    listAgents(agents);
  });
  // Agents opened outside any labelled parallel.
  const loose = snapshot.agents.filter((agent) => agent.group === undefined && !inStage(agent));
  if (loose.some((agent) => isRunning(agent) || isFailed(agent))) listAgents(loose);
  return lines;
}

/** For a log rather than a terminal: one line per change between two snapshots. */
export function progressEvents(
  before: WorkflowRunSnapshot | undefined,
  after: WorkflowRunSnapshot,
  view: { startedAt: number; now: number },
): string[] {
  const at = `[${clock(view.now - view.startedAt)}]`;
  const events: string[] = [];
  after.groups.forEach((group, index) => {
    if (!before?.groups[index]) events.push(`${at} ▶ ${group.label} (${group.total})`);
  });
  for (const agent of after.agents) {
    const earlier = before?.agents.find((a) => a.key === agent.key);
    if (agent.forkedFrom !== undefined && earlier?.forkedFrom === undefined) {
      events.push(`${at} ↳ ${agent.key} forked from ${agent.forkedFrom}`);
    }
    const turn = agent.turn;
    if (!turn) continue;
    const fresh = earlier?.turns !== agent.turns;
    if (fresh && turn.outcome === undefined) {
      events.push(`${at} ▶ ${agent.key} · ${agent.execution.model}`);
    }
    if (turn.outcome !== undefined && (fresh || earlier?.turn?.outcome === undefined)) {
      const took = duration((turn.settledAt ?? view.now) - turn.startedAt);
      events.push(
        turn.outcome === "answered"
          ? `${at} ✓ ${agent.key} · ${took}`
          : `${at} ✗ ${agent.key} · ${took} · ${turn.outcome}${turn.reason ? `: ${oneLine(turn.reason)}` : ""}`,
      );
    }
  }
  // After the agents, so a group's and a stage's end follow the turns that ended them; and in the
  // order entered, so one stage's end comes before the next one's start.
  after.groups.forEach((group, index) => {
    if (group.endedAt !== undefined && before?.groups[index]?.endedAt === undefined) {
      const failed = after.agents.filter((a) => a.group === index && isFailed(a)).length;
      events.push(
        `${at} ■ ${group.label} done ${group.done}/${group.total} in ${duration(group.endedAt - group.startedAt)}${failed ? `, ${failed} failed` : ""}`,
      );
    }
  });
  after.stages.forEach((stage, index) => {
    const earlier = before?.stages[index];
    if (stage.source === "reused") {
      if (!earlier) {
        events.push(`${at} ↺ stage ${stage.stage} · attempt ${stage.attempt}${summaryOf(stage)}`);
      }
      return;
    }
    if (!earlier) events.push(`${at} ▶ stage ${stage.stage}`);
    if (stage.endedAt !== undefined && earlier?.endedAt === undefined) {
      events.push(
        `${at} ${stageMark(stage.outcome, PLAIN).mark} stage ${stage.stage} ${stage.outcome} in ${duration(stage.endedAt - stage.startedAt)}${summaryOf(stage)}`,
      );
    }
  });
  return events;
}

/**
 * The stages: those finished collapsed to a line with their time and outcome, those reused marked
 * `↺` with the attempt that ran them, the current one with each agent working in it, and those an
 * earlier attempt recorded still to come, dim. None for a run without stages.
 */
function stageLines(snapshot: WorkflowRunSnapshot, now: number, paint: Paint): string[] {
  // Once the run is closing, what it never reached isn't coming.
  const upcoming =
    snapshot.state === "closing" || snapshot.state === "closed" ? [] : snapshot.upcoming;
  const width = Math.max(
    ...snapshot.stages.map((stage) => stage.stage.length),
    ...upcoming.map((name) => name.length),
    0,
  );
  const lines: string[] = [];
  for (const stage of snapshot.stages) {
    const name = stage.stage.padEnd(width);
    if (stage.source === "reused") {
      lines.push(paint.dim(`↺ ${name}  attempt ${stage.attempt}${summaryOf(stage)}`));
      continue;
    }
    const took = duration((stage.endedAt ?? now) - stage.startedAt);
    if (stage.endedAt === undefined) {
      lines.push(`${paint.busy(spin(now))} ${name}  ${paint.dim(took)}`);
      const agents = snapshot.agents.filter((agent) => agent.turn?.stage === stage.stage);
      const keys = Math.max(...agents.map((agent) => agent.key.length), 0);
      lines.push(...agents.map((agent) => stageAgentLine(agent, keys, now, paint)));
      continue;
    }
    const { mark, note } = stageMark(stage.outcome, paint);
    lines.push(`${mark} ${name}  ${paint.dim(took)}${note}${paint.dim(summaryOf(stage))}`);
  }
  lines.push(...upcoming.map((name) => paint.dim(`· ${name}`)));
  return lines;
}

/** A finished stage's mark, and its outcome when it didn't succeed. */
function stageMark(
  outcome: StageOutcome | undefined,
  paint: Paint,
): { mark: string; note: string } {
  if (outcome === "succeeded") return { mark: paint.ok("✓"), note: "" };
  const tone = outcome === "stopped" ? paint.busy : paint.bad;
  return { mark: tone(outcome === "stopped" ? "■" : "✗"), note: tone(` · ${outcome}`) };
}

function summaryOf(stage: StageProgress): string {
  return stage.summary ? ` · ${oneLine(stage.summary)}` : "";
}

/** An agent in the current stage: its placement, its turn's label and time; done, it waits. */
function stageAgentLine(agent: Agent, keys: number, now: number, paint: Paint): string {
  const turn = agent.turn!;
  const [mark, note] =
    turn.outcome === "answered"
      ? [paint.dim("·"), paint.dim("waiting")]
      : agentState(agent, now, paint);
  const took = duration((turn.settledAt ?? now) - turn.startedAt);
  const label = turn.label ?? turn.kind;
  const labelled = label ? `  ${label}` : "";
  return `    ${mark} ${agent.key.padEnd(keys)}  ${paint.dim(`${agent.execution.model} · ${placementOf(agent.execution)}`)}${labelled}  ${took}${note ? `  ${note}` : ""}`;
}

function agentState(agent: Agent, now: number, paint: Paint): [string, string] {
  const turn = agent.turn;
  if (!turn) {
    return agent.state === "missing" || agent.state === "quarantined"
      ? [paint.bad("✗"), paint.bad(oneLine(agent.detail ?? agent.state))]
      : [paint.dim("·"), paint.dim(agent.state)];
  }
  if (turn.outcome === undefined) return [paint.busy(spin(now)), ""];
  if (turn.outcome === "answered") return [paint.ok("✓"), ""];
  return [
    paint.bad("✗"),
    paint.bad(`${turn.outcome}${turn.reason ? `: ${oneLine(turn.reason)}` : ""}`),
  ];
}

function isRunning(agent: Agent): boolean {
  return agent.turn !== undefined && agent.turn.outcome === undefined;
}

function isFailed(agent: Agent): boolean {
  if (!agent.turn) return agent.state === "missing" || agent.state === "quarantined";
  return agent.turn.outcome !== undefined && agent.turn.outcome !== "answered";
}

function spin(now: number): string {
  return SPINNER[Math.floor(now / 100) % SPINNER.length]!;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function clock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
