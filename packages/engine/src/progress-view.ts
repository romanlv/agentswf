import { duration } from "./accounting/format";
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

/** The live block: one line per stage, and under the active ones, the agents worth watching. */
export function renderProgress(
  snapshot: WorkflowRunSnapshot,
  view: { name: string; startedAt: number; now: number; paint: Paint },
): string[] {
  const { now, paint } = view;
  const working = snapshot.agents.filter(isRunning).length;
  const lines = [
    `${view.name} ${paint.dim(`· ${duration(now - view.startedAt)}`)}${working ? paint.dim(` · ${working} working`) : ""}`,
  ];
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

  snapshot.stages.forEach((stage, index) => {
    const agents = snapshot.agents.filter((agent) => agent.stage === index);
    const failed = agents.filter(isFailed).length;
    const failures = failed ? paint.bad(` · ${failed} failed`) : "";
    if (stage.endedAt !== undefined) {
      const mark = failed ? paint.bad("✗") : paint.ok("✓");
      lines.push(
        `${mark} ${stage.label} ${paint.dim(`${stage.done}/${stage.total} · ${duration(stage.endedAt - stage.startedAt)}`)}${failures}`,
      );
      listAgents(agents.filter(isFailed));
      return;
    }
    const queued = stage.total - stage.started;
    lines.push(
      `${paint.busy(spin(now))} ${stage.label} ${paint.dim(`${stage.done}/${stage.total}${queued ? ` · ${queued} queued` : ""}`)}${failures}`,
    );
    listAgents(agents);
  });
  // Agents opened outside any labelled stage.
  const loose = snapshot.agents.filter((agent) => agent.stage === undefined);
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
  after.stages.forEach((stage, index) => {
    if (!before?.stages[index]) events.push(`${at} ▶ ${stage.label} (${stage.total})`);
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
  // After the agents, so a stage's end follows the turns that ended it.
  after.stages.forEach((stage, index) => {
    if (stage.endedAt !== undefined && before?.stages[index]?.endedAt === undefined) {
      const failed = after.agents.filter((a) => a.stage === index && isFailed(a)).length;
      events.push(
        `${at} ■ ${stage.label} done ${stage.done}/${stage.total} in ${duration(stage.endedAt - stage.startedAt)}${failed ? `, ${failed} failed` : ""}`,
      );
    }
  });
  return events;
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
