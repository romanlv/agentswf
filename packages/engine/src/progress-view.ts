import { type JsonValue, placementOf, type StageOutcome } from "@agentswf/contract/workflow";
import { ago, duration } from "./accounting/format";
import { NO_STAGE } from "./accounting/summary";
import type { StageProgress } from "./stage-ledger";
import type { WorkflowRunHandle, WorkflowRunSnapshot } from "./workflow-runner";

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
  view: {
    name: string;
    startedAt: number;
    now: number;
    paint: Paint;
    /** Once the run is over: what each stage's agents cost, by stage. */
    figures?: ReadonlyMap<string, string>;
  },
): string[] {
  const { now, paint } = view;
  const working = snapshot.agents.filter(isRunning).length;
  const current = snapshot.stages.findLast((stage) => stage.endedAt === undefined);
  const lines = [
    `${view.name}${current ? ` · ${current.stage}` : ""} ${paint.dim(`· ${duration(now - view.startedAt)}`)}${working ? paint.dim(` · ${working} working`) : ""}`,
  ];
  lines.push(...stageLines(snapshot, now, paint, view.figures ?? new Map()));
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
      // A finished stage's line already says what went well in it.
      const folded = members.every((agent) =>
        snapshot.stages.some((stage) => stage.stage === agent.turn?.stage && stage.endedAt),
      );
      if (!failed && members.length > 0 && folded) return;
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

/** For a log rather than a terminal: one line per change between two snapshots, when it happened. */
export function progressEvents(
  before: WorkflowRunSnapshot | undefined,
  after: WorkflowRunSnapshot,
  view: { startedAt: number; now: number },
): string[] {
  // Each stamped and ordered by when it happened; at the same instant, what ends goes before what
  // starts, and the inner before the outer as each ends, the outer before the inner as each starts.
  const events: { time: number; rank: number; text: string }[] = [];
  const add = (time: number, rank: Rank, text: string) =>
    events.push({
      time,
      rank: RANKS.indexOf(rank),
      text: `[${clock(time - view.startedAt)}] ${text}`,
    });
  after.groups.forEach((group, index) => {
    const earlier = before?.groups[index];
    if (!earlier) add(group.startedAt, "group start", `▶ ${group.label} (${group.total})`);
    if (group.endedAt !== undefined && earlier?.endedAt === undefined) {
      const failed = after.agents.filter((a) => a.group === index && isFailed(a)).length;
      add(
        group.endedAt,
        group.endedAt === group.startedAt ? "zero-length end" : "group end",
        `${failed ? "✗" : "✓"} ${group.label} done ${group.done}/${group.total} in ${duration(group.endedAt - group.startedAt)}${failed ? `, ${failed} failed` : ""}`,
      );
    }
  });
  for (const agent of after.agents) {
    const earlier = before?.agents.find((a) => a.key === agent.key);
    const turn = agent.turn;
    if (agent.forkedFrom !== undefined && earlier?.forkedFrom === undefined) {
      add(turn?.startedAt ?? view.now, "fork", `↳ ${agent.key} forked from ${agent.forkedFrom}`);
    }
    if (!turn) continue;
    const fresh = earlier?.turns !== agent.turns;
    if (fresh && turn.outcome === undefined)
      add(turn.startedAt, "agent start", `▶ ${agent.key} · ${agent.execution.model}`);
    if (
      turn.outcome === undefined &&
      turn.phase &&
      (fresh
        ? turn.phase !== "working"
        : turn.phase !== earlier?.turn?.phase ||
          turn.waitingReason !== earlier?.turn?.waitingReason ||
          turn.checkInAt !== earlier?.turn?.checkInAt)
    ) {
      const note =
        turn.phase === "waiting"
          ? `waiting (agent-reported): ${oneLine(turn.waitingReason ?? "")}${turn.checkInAt === undefined ? "" : ` · check-in at ${clock(turn.checkInAt - view.startedAt)}`}`
          : oneLine(turn.phase.replaceAll("-", " "));
      add(view.now, "agent phase", `… ${oneLine(agent.key)} · ${note}`);
    }
    if (turn.outcome !== undefined && (fresh || earlier?.turn?.outcome === undefined)) {
      const settledAt = turn.settledAt ?? view.now;
      const took = duration(settledAt - turn.startedAt);
      add(
        settledAt,
        settledAt === turn.startedAt ? "zero-length end" : "agent end",
        turn.outcome === "answered"
          ? `✓ ${agent.key} · ${took}`
          : `✗ ${agent.key} · ${took} · ${turn.outcome}${turn.reason ? `: ${oneLine(turn.reason)}` : ""}`,
      );
    }
  }
  after.stages.forEach((stage, index) => {
    const earlier = before?.stages[index];
    if (stage.source === "reused") {
      if (!earlier) {
        add(
          stage.startedAt,
          "stage start",
          `↺ stage ${[stage.stage, ...summaryOf(stage), ...providedOf(stage), `attempt ${stage.attempt}`].join(" · ")}`,
        );
      }
      return;
    }
    const ended = stage.endedAt !== undefined && earlier?.endedAt === undefined;
    // A stage that ended as it was entered, as a stop before it does, is one line.
    const instant = ended && !earlier && stage.endedAt === stage.startedAt;
    if (!earlier && !instant) add(stage.startedAt, "stage start", `▶ stage ${stage.stage}`);
    if (ended) {
      add(
        stage.endedAt!,
        instant ? "stage start" : "stage end",
        `${stageMark(stage.outcome, PLAIN)} stage ${[stage.stage, duration(stage.endedAt! - stage.startedAt), ...summaryOf(stage)].join(" · ")}`,
      );
    }
  });
  return events
    .map((event, order) => ({ ...event, order }))
    .sort((a, b) => a.time - b.time || a.rank - b.rank || a.order - b.order)
    .map((event) => event.text);
}

const RANKS = [
  "agent end",
  "group end",
  "stage end",
  "stage start",
  "group start",
  "fork",
  "agent start",
  "agent phase",
  "zero-length end",
] as const;
type Rank = (typeof RANKS)[number];

/**
 * The stages, a row each in columns: the time; the summary; and what its agents cost once the run
 * is over, or for a reused one, marked `↺`, whether its value was given, the attempt that ran it,
 * and how long ago once that is over an hour. The current one lists each agent working in it; those an earlier attempt recorded
 * still to come are dim. Once the run is over, what ran between stages has a row of its own, so the
 * stages add up. None for a run without stages. A stage that did not succeed shows only its mark:
 * why is said once, where the run's ending is.
 */
function stageLines(
  snapshot: WorkflowRunSnapshot,
  now: number,
  paint: Paint,
  figures: ReadonlyMap<string, string>,
): string[] {
  // Once the run is closing, what it never reached isn't coming.
  const upcoming =
    snapshot.state === "closing" || snapshot.state === "closed" ? [] : snapshot.upcoming;
  const between = figures.get(NO_STAGE);
  const width = Math.max(
    ...snapshot.stages.map((stage) => stage.stage.length),
    ...upcoming.map((name) => name.length),
    between === undefined ? 0 : NO_STAGE.length,
    0,
  );
  type Row = { mark: string; name: string; cells: [string, string, string]; stage?: StageProgress };
  const rows: Row[] = snapshot.stages.map((stage) => {
    const summary = summaryOf(stage).join("");
    if (stage.source === "reused") {
      return { mark: "↺", name: stage.stage, cells: ["", summary, reusedTail(stage, now)], stage };
    }
    const took = duration((stage.endedAt ?? now) - stage.startedAt);
    const cost = figures.get(stage.stage);
    if (stage.endedAt === undefined) {
      return { mark: paint.busy(spin(now)), name: stage.stage, cells: [took, "", ""], stage };
    }
    return {
      mark: stageMark(stage.outcome, paint),
      name: stage.stage,
      cells: [took, summary, cost ?? ""],
      stage,
    };
  });
  if (between !== undefined) {
    rows.push({ mark: paint.dim("·"), name: NO_STAGE, cells: ["", "", between] });
  }
  const widths = [0, 1, 2].map((column) =>
    Math.max(0, ...rows.map((row) => row.cells[column]!.length)),
  );
  const lines: string[] = [];
  for (const { mark, name, cells, stage } of rows) {
    // Up to the last cell with anything in it, an empty column in no row taking no room.
    const last = cells.findLastIndex((cell) => cell !== "");
    const shown = cells
      .map((cell, column) => ({ cell, column }))
      .filter(({ column }) => column <= last && widths[column]! > 0)
      .map(({ cell, column }) => {
        const text = column === last ? cell : cell.padEnd(widths[column]!);
        // A stage that ran has its summary dim; a reused one is dim whole.
        return stage?.source !== "reused" && column === 1 ? paint.dim(text) : text;
      });
    const line = [name.padEnd(last < 0 ? 0 : width), ...shown].join(GAP);
    if (stage?.source === "reused") {
      lines.push(paint.dim(`${mark} ${line}`));
      continue;
    }
    if (stage !== undefined && stage.endedAt === undefined) {
      lines.push(`${mark} ${name.padEnd(width)}${GAP}${paint.dim(cells[0])}`);
      const agents = snapshot.agents.filter((agent) => agent.turn?.stage === stage.stage);
      const keys = Math.max(...agents.map((agent) => agent.key.length), 0);
      lines.push(...agents.map((agent) => stageAgentLine(agent, keys, now, paint)));
      continue;
    }
    lines.push(`${mark} ${line}`);
  }
  lines.push(...upcoming.map((name) => paint.dim(`· ${name}`)));
  return lines;
}

const GAP = "   ";

const HOUR_MS = 60 * 60_000;

/** The attempt that recorded a reused stage, and its record's age once that may make it stale. */
function reusedTail(stage: StageProgress, now: number): string {
  const age = stage.recordedAt === undefined ? 0 : now - stage.recordedAt;
  return [
    ...providedOf(stage),
    `attempt ${stage.attempt}`,
    ...(age > HOUR_MS ? [ago(age)] : []),
  ].join(" · ");
}

function providedOf(stage: StageProgress): string[] {
  return stage.provided ? ["provided"] : [];
}

/** A finished stage's mark. */
function stageMark(outcome: StageOutcome | undefined, paint: Paint): string {
  if (outcome === "succeeded") return paint.ok("✓");
  return outcome === "stopped" ? paint.busy("■") : paint.bad("✗");
}

function summaryOf(stage: StageProgress): string[] {
  return stage.summary ? [oneLine(stage.summary)] : [];
}

/** An agent in the current stage: its placement, its turn's label and time; done, it waits. */
function stageAgentLine(agent: Agent, keys: number, now: number, paint: Paint): string {
  const turn = agent.turn!;
  const [mark, note] =
    turn.outcome === "answered"
      ? [paint.dim("·"), paint.dim("waiting")]
      : agentState(agent, now, paint);
  const took = duration((turn.settledAt ?? now) - turn.startedAt);
  const label = turn.label ?? (turn.kind === "turn" ? undefined : turn.kind);
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
  if (turn.outcome === undefined) {
    const phase = turn.phase;
    const note =
      phase === "waiting"
        ? `waiting (agent-reported): ${oneLine(turn.waitingReason ?? "")}${turn.checkInAt === undefined ? "" : ` · check-in in ${duration(Math.max(0, turn.checkInAt - now))}`}`
        : phase && phase !== "working"
          ? phase.replaceAll("-", " ")
          : "";
    return [paint.busy(spin(now)), note];
  }
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
  const line = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip agent-supplied terminal styling from log lines.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: untrusted reasons must not contain terminal controls.
    .replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ")
    .trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function clock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Where progress is redrawn in place, and whether in color. */
export type Terminal = { write(text: string): void; color: boolean };

/**
 * Polls the run's snapshot. On a terminal it keeps one block redrawn under the log; elsewhere it
 * writes a line per change, so a log file or a calling agent reads what happened and when.
 */
export function watchProgress(
  name: string,
  startedAt: number,
  output: { stderr: (text: string) => void; terminal: Terminal | undefined; now: () => number },
) {
  const { stderr, terminal, now } = output;
  let handle: WorkflowRunHandle<JsonValue> | undefined;
  let last: WorkflowRunSnapshot | undefined;
  let drawn = 0;
  const clear = () => {
    if (terminal && drawn > 0) terminal.write(`\x1b[${drawn}F\x1b[0J`);
    drawn = 0;
  };
  const tick = (final = false, figures?: ReadonlyMap<string, string>) => {
    if (!handle) return;
    const snapshot = handle.inspect();
    if (terminal) {
      const lines = renderProgress(snapshot, {
        name,
        startedAt,
        now: now(),
        paint: terminal.color ? ANSI : PLAIN,
        ...(figures ? { figures } : {}),
      });
      // The header's name and clock are the command's and the accounting's once the run is over.
      if (final) lines.shift();
      clear();
      if (lines.length > 0) terminal.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    } else {
      for (const line of progressEvents(last, snapshot, { startedAt, now: now() })) stderr(line);
    }
    last = snapshot;
  };
  // Lines too long for the terminal are clipped rather than wrapped, so the redraw stays exact.
  terminal?.write("\x1b[?25l\x1b[?7l");
  const timer = setInterval(() => tick(), terminal ? 100 : 1000);
  return {
    watch(started: WorkflowRunHandle<JsonValue>) {
      handle = started;
      tick();
    },
    log(text: string) {
      clear();
      stderr(text);
      if (terminal) tick();
    },
    /** `figures`, what each stage's agents cost, once the run's usage is read. */
    stop(figures?: ReadonlyMap<string, string>) {
      clearInterval(timer);
      tick(true, figures);
      terminal?.write("\x1b[?7h\x1b[?25h");
    },
  };
}
