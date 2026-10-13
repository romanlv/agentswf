import type { RunJson, RunsJson } from "@agentswf/contract/records";
import { messageOf } from "./errors";
import {
  clockTime,
  command,
  continueOf,
  estimateOf,
  failed,
  masked,
  money,
  nextLogs,
  type Out,
  parsePlace,
  type ReadPlace,
  said,
  shellLine,
  span,
  stateWord,
} from "./run-commands";
import { encodeCursor } from "./run-read";
import { findRun, listRuns, type RunStatus, runStatus } from "./run-state";
import { type AgentView, describeActivity, duration, type RunView, viewRun } from "./run-view";

export const runsUsage = [
  "usage: awf runs [--all] [--cwd <directory>] [--run-root <directory>] [--json]",
  "       awf runs <run> [--cwd <directory>] [--run-root <directory>] [--json]",
  "",
  "The runs here, newest first, or one run in depth: its attempts, the stages of the last, what",
  "each agent is doing, and what to run next. A run is <workflow>/<id>, or an <id> only one",
  "workflow here has. Runs are read under --cwd's .awf/runs, or --run-root, as awf run keeps them.",
  "",
  "--json prints one document, the interface for scripts. Exits 0 on any read that worked, 1 when",
  "there is no such run, 2 on a usage error, 3 when the run's files could not be read.",
].join("\n");

const LISTED = 20;

export async function runsCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  now: number = Date.now(),
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    out.stdout(runsUsage);
    return 0;
  }
  let parsed: ReturnType<typeof parsePlace>;
  let all = false;
  let ref: string | undefined;
  try {
    parsed = parsePlace(argv, shellCwd);
    for (const arg of parsed.rest) {
      if (arg === "--all") all = true;
      else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
      else if (ref === undefined) ref = arg;
      else throw new Error(`one run at a time: ${ref} and ${arg}`);
    }
    if (ref !== undefined && all) throw new Error("--all lists runs; it takes no run");
  } catch (error) {
    out.stderr(`awf: ${messageOf(error)}\n\n${runsUsage}`);
    return 2;
  }
  const { place, json } = parsed;
  try {
    if (ref === undefined) return await list(place, all, json, out, now);
    const view = await viewRun((await findRun(place.runRoot, ref)).status);
    out.stdout(
      json ? JSON.stringify(runJson(view, place, now), null, 2) : describe(view, place, now),
    );
    return 0;
  } catch (error) {
    return failed(error, place, out, messageOf(error));
  }
}

/** A run listed, or why it could not be read: one bad run does not hide the others. */
type Listed = { status: RunStatus } | { ref: string; unreadable: string };

async function list(place: ReadPlace, all: boolean, json: boolean, out: Out, now: number) {
  const runs = await listRuns(place.runRoot);
  const shown = all ? runs : runs.slice(0, LISTED);
  const listed: Listed[] = await Promise.all(
    shown.map((run) =>
      runStatus(run, undefined, now).then(
        (status) => ({ status }),
        (error: unknown) => ({
          ref: `${run.record.workflow}/${run.record.id}`,
          unreadable: said(messageOf(error), 400),
        }),
      ),
    ),
  );
  const older = runs.length - shown.length;
  if (json) {
    const runsJson: RunsJson["runs"] = listed.map((each) => {
      if (!("status" in each)) return each;
      const { status } = each;
      const { started, ended } = span(status, now);
      const estimate = estimateOf(status.attempts);
      return {
        ref: status.ref,
        state: status.state,
        checked: status.checked,
        started: new Date(started).toISOString(),
        ...(ended === undefined ? {} : { duration: ended - started }),
        ...(estimate === undefined ? {} : { estimate }),
      };
    });
    const document: RunsJson = { v: 1, runs: runsJson, more: { older: older > 0 } };
    out.stdout(JSON.stringify(document, null, 2));
    return 0;
  }
  if (listed.length === 0) {
    out.stdout(`no runs under ${place.runRoot}; started elsewhere? awf runs --cwd {dir}`);
    return 0;
  }
  const refOf = (each: Listed) => ("status" in each ? each.status.ref : each.ref);
  const width = Math.max(...listed.map((each) => refOf(each).length)) + 2;
  const states = listed.map((each) => ("status" in each ? stateWord(each.status) : ""));
  const stateWidth = Math.max(13, ...states.map((each) => each.length + 2));
  const lines = listed.map((each, index) => {
    if (!("status" in each)) return `${each.ref.padEnd(width)}unreadable: ${each.unreadable}`;
    const { status } = each;
    const { started, ms } = span(status, now);
    const estimate = estimateOf(status.attempts);
    return [
      status.ref.padEnd(width),
      states[index]!.padEnd(stateWidth),
      dayTime(started).padEnd(13),
      duration(ms).padEnd(8),
      money(estimate).join(""),
    ]
      .join("")
      .trimEnd();
  });
  if (older > 0) lines.push(`… ${older} older (--all)`);
  out.stdout(lines.join("\n"));
  return 0;
}

function dayTime(at: number): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${clockTime(at).slice(0, 5)}`;
}

const busy = (agent: AgentView) => agent.state === "working" || agent.state === "was working";

function agentLine(agent: AgentView, indent: string, now: number, width: number): string {
  const { live } = agent;
  const parts = [
    said(agent.key, 60).padEnd(width),
    (live?.phase === "waiting" ? "waiting" : live ? "awaiting" : agent.state).padEnd(11),
    busy(agent) ? `turn ${agent.turns + 1}` : `${agent.turns} turn${agent.turns === 1 ? "" : "s"}`,
    ...(live?.phase === "waiting"
      ? [
          [
            live.reason ? `"${said(live.reason)}"` : "",
            live.until ? `(check-in due ${clockTime(live.until).slice(0, 5)})` : "",
          ]
            .filter(Boolean)
            .join(" "),
        ]
      : live
        ? [
            `${said(live.peer, 60)}'s reply${live.until ? ` (until ${clockTime(live.until).slice(0, 5)})` : ""}`,
          ]
        : []),
    ...(agent.since && agent.state === "working" ? [duration(now - agent.since)] : []),
    ...(agent.last
      ? [`last: ${describeActivity(agent.last.activity)} (${clockTime(agent.last.at)})`]
      : []),
  ];
  return `${indent}    ${parts.filter(Boolean).join("  ")}`;
}

/** Past this many, agents numbered alike, `fix:lens-1` to `fix:lens-8`, take one line. */
const GROUPED = 4;

function agentLines(agents: readonly AgentView[], indent: string, now: number): string[] {
  const prefix = (agent: AgentView) => (/\d$/.test(agent.key) ? agent.key.replace(/\d+$/, "") : "");
  const width = Math.max(16, ...agents.map((agent) => said(agent.key, 60).length + 1));
  const groups = new Map<string, AgentView[]>();
  for (const agent of agents) {
    if (prefix(agent)) groups.set(prefix(agent), [...(groups.get(prefix(agent)) ?? []), agent]);
  }
  const lines: string[] = [];
  const done = new Set<string>();
  for (const agent of agents) {
    const group = groups.get(prefix(agent)) ?? [agent];
    if (group.length <= GROUPED) {
      lines.push(agentLine(agent, indent, now, width));
      continue;
    }
    if (done.has(prefix(agent))) continue;
    done.add(prefix(agent));
    const states = new Map<string, number>();
    for (const each of group) states.set(each.state, (states.get(each.state) ?? 0) + 1);
    const counts = [...states].map(([state, n]) => `${n} ${state}`).join(", ");
    lines.push(
      `${indent}    ${said(group[0]!.key, 60)} … ${said(group.at(-1)!.key, 60)}   ${group.length} agents: ${counts}`,
    );
  }
  return lines;
}

function describe(view: RunView, place: ReadPlace, now: number): string {
  const { status, attempt } = view;
  const lines: string[] = [
    [
      status.ref,
      stateWord(status, view.lastEventAt),
      ...(attempt && status.attempts.length > 1
        ? [
            `attempt ${attempt.attempt}${attempt.flags.fromStage ? ` (from stage ${attempt.flags.fromStage})` : ""}`,
          ]
        : []),
      ...(view.stage ? [`stage ${view.stage}`] : []),
      status.state === "interrupted" && view.lastEventAt
        ? `last event ${clockTime(view.lastEventAt)}`
        : duration(span(status, now).ms),
      ...money(view.estimate),
    ].join("  "),
  ];
  for (const earlier of status.attempts.slice(0, -1)) {
    const took = earlier.ended
      ? `  ${duration(Date.parse(earlier.ended) - Date.parse(earlier.started))}`
      : "";
    const how = `${earlier.outcome ?? "interrupted"}${earlier.stage ? ` in ${earlier.stage}` : ""}`;
    lines.push(`  attempt ${earlier.attempt}  ${how}${took}`);
  }
  const indent = status.attempts.length > 1 ? "  " : "";
  if (indent && attempt) lines.push(`  attempt ${attempt.attempt}`);
  const shown = new Set<string>();
  for (const stage of view.stages) {
    const took =
      stage.state === "reused" || stage.state === "provided" || stage.startedAt === undefined
        ? ""
        : duration((stage.endedAt ?? now) - stage.startedAt);
    lines.push(
      `${indent}  stage ${stage.stage.padEnd(8)} ${stage.state.padEnd(10)} ${took}`.trimEnd(),
    );
    const own = view.agents.filter((each) => each.stage === stage.stage);
    for (const agent of own) shown.add(agent.key);
    lines.push(...agentLines(own, indent, now));
  }
  lines.push(
    ...agentLines(
      view.agents.filter((each) => !shown.has(each.key)),
      indent,
      now,
    ),
  );
  for (const decision of view.decisions) {
    lines.push(
      `${indent}    decision "${said(decision.key)}"  asked ${clockTime(decision.askedAt).slice(0, 5)}, ${decision.outcome ?? "open"}`,
    );
  }
  lines.push(...trailer(view, place));
  return lines.join("\n");
}

function trailer(view: RunView, place: ReadPlace): string[] {
  const { status } = view;
  if (status.state === "running") {
    return [`next: ${shellLine(nextLogs(status, place, view.cursor))}`];
  }
  const go = status.state === "completed" ? undefined : continueOf(status, view.lines, place);
  if (status.state === "interrupted") return go ? [`continue: ${go}`] : [];
  const lines: string[] = [];
  if (view.attempt?.reason) lines.push(`reason: ${said(view.attempt.reason, 400)}`);
  lines.push(`records: ${status.run.dir} (report.md, output.json)`);
  if (status.state === "failed") {
    const stuck = view.agents.find((each) => each.state === "failed" || each.state === "timed-out");
    const look = command(place, "awf", "logs", status.ref);
    lines.push(
      // A key a shell line cannot carry on one line is left out.
      `see: ${shellLine([...look, ...(stuck && !/[\r\n]/.test(stuck.key) ? ["--agent", stuck.key] : []), "--limit", "30"])}`,
    );
  }
  if (go) lines.push(`continue: ${go}`);
  return lines;
}

/** `awf runs {ref} --json`: durable fields at the top, best-effort ones under `live`. */
function runJson(view: RunView, place: ReadPlace, now: number): RunJson {
  const { status } = view;
  const { ended, started } = span(status, now);
  const go =
    status.state === "completed" || status.state === "running"
      ? undefined
      : continueOf(status, view.lines, place);
  return {
    v: 1,
    run: {
      ref: status.ref,
      state: status.state,
      checked: status.checked,
      ...(view.stage ? { stage: view.stage } : {}),
      ...(status.state !== "running" && ended !== undefined ? { duration: ended - started } : {}),
      ...(view.estimate === undefined ? {} : { estimate: view.estimate }),
      dir: status.run.dir,
    },
    attempts: status.attempts.map(({ attempt, started, ended, outcome, stage, reason }) => ({
      attempt,
      started,
      ...(ended ? { ended } : {}),
      state:
        outcome ?? (attempt === status.attempts.at(-1)?.attempt ? status.state : "interrupted"),
      ...(stage ? { stage } : {}),
      ...(reason ? { reason: masked(reason, 1_000) as string } : {}),
    })),
    stages: view.stages.map(({ stage, state, startedAt, endedAt }) => ({
      stage,
      state,
      ...(startedAt ? { started: new Date(startedAt).toISOString() } : {}),
      ...(endedAt ? { ended: new Date(endedAt).toISOString() } : {}),
    })),
    agents: view.agents.map((agent) => ({
      key: agent.key,
      ...(agent.harness ? { harness: agent.harness } : {}),
      ...(agent.caller ? { caller: true } : {}),
      ...(agent.stage ? { stage: agent.stage } : {}),
      state: agent.state,
      turns: agent.turns,
      sessions: agent.sessions,
      live: {
        ...(agent.live
          ? {
              phase: agent.live.phase,
              ...(agent.live.phase === "awaiting-reply"
                ? { peer: agent.live.peer }
                : agent.live.reason === undefined
                  ? {}
                  : { reason: masked(agent.live.reason, 1_000) as string }),
              ...(agent.live.until === undefined
                ? {}
                : { until: new Date(agent.live.until).toISOString() }),
            }
          : {}),
        ...(agent.last ? { lastActivity: agent.last } : {}),
        observedAt: new Date(now).toISOString(),
      },
    })),
    decisions: view.decisions.map(({ decision, key, askedAt, outcome }) => ({
      decision,
      key,
      asked: new Date(askedAt).toISOString(),
      ...(outcome ? { outcome } : {}),
    })),
    cursor: encodeCursor(view.cursor),
    ...(status.state === "running" ? { next: nextLogs(status, place, view.cursor) } : {}),
    ...(go ? { continue: go } : {}),
  };
}
