// What the commands that read runs say of one: its state, span and cost, and the commands that go
// on from it.
import { resolve } from "node:path";
import type { RunLogLine } from "@agentswf/contract/records";
import { runEstimate, unknownOps } from "./accounting/spent";
import { continueCommand } from "./attempt-view";
import { command, type Out, placeFlags, type ReadPlace, shellLine } from "./command-line";
import { NO_JSON, readFailureCode, refusalLine } from "./refusals";
import type { RunCommand } from "./run-command";
import { type Cursor, encodeCursor } from "./run-read";
import { RunNotFound, type RunStatus } from "./run-state";
import { clockTime } from "./run-text";
import { runRootOf } from "./runs";
import { readSpent } from "./spend";

/** Says a run that is not there, and exits 1; anything else is the run's files, exit 3. */
export function failed(
  error: unknown,
  place: ReadPlace,
  out: Out,
  message: string,
  json: { json: boolean; v: number } = NO_JSON,
): number {
  // The error's own code; else a file that couldn't be read, exit 3's, or a failure of awf's.
  const code = readFailureCode(error);
  if (json.json) out.stdout(refusalLine(json.v, code, message));
  if (error instanceof RunNotFound) {
    out.stderr(`${error.message}; runs here: ${shellLine(command(place, "awf", "runs"))}`);
    return 1;
  }
  out.stderr(`awf: ${message}`);
  return 3;
}

/**
 * What `awf run` says first where no person watches its progress: the run's reference, the one
 * route a calling agent has to its own run. Its prefix, `awf: {workflow}/{id} started`, is stable.
 */
export function startedLine(
  workflow: string,
  id: string,
  run: Pick<RunCommand, "cwd" | "cwdGiven" | "runRoot" | "runRootGiven">,
): string {
  const ref = `${workflow}/${id}`;
  return `awf: ${ref} started · watch: ${shellLine(["awf", "logs", ref, ...placeFlags(run)])}`;
}

/** `awf logs` from `cursor`: with `--wait` unless the page stopped short of the newest. */
export function nextLogs(
  status: RunStatus,
  place: ReadPlace,
  cursor: Cursor,
  filters: string[] = [],
  wait = true,
): string[] {
  return [
    ...command(place, "awf", "logs", status.ref),
    ...filters,
    "--after",
    encodeCursor(cursor),
    ...(wait ? ["--wait", "90s"] : []),
  ];
}

/** The command an interrupted run goes on with, as `awf run` would print it. */
export function continueOf(
  status: RunStatus,
  lines: readonly { line: RunLogLine }[],
  place: ReadPlace,
): string | undefined {
  const { run } = status;
  const last = status.attempts.at(-1);
  if (!last) return undefined;
  const entered = lines.flatMap(({ line }) =>
    line.attempt === last.attempt &&
    (line.kind === "stage-started" || (line.kind === "stage-ended" && line.source))
      ? [{ stage: line.stage }]
      : [],
  );
  return continueCommand(
    {
      shellCwd: place.shellCwd,
      cwd: run.record.cwd,
      cwdGiven: resolve(run.record.cwd) !== resolve(place.shellCwd),
      runRoot: run.root,
      runRootGiven: resolve(run.root) !== resolve(runRootOf(run.record.cwd)),
      workflowFile: last.file,
      ...(last.flags.fromStage === undefined ? {} : { fromStage: last.flags.fromStage }),
    },
    run.record.id,
    undefined,
    entered,
  );
}

/** The stage the last attempt is in: open, or the one it ended in. */
export function currentStage(
  status: RunStatus,
  lines: readonly { line: RunLogLine }[],
): string | undefined {
  const last = status.attempts.at(-1);
  if (!last) return undefined;
  const open = new Set<string>();
  for (const { line } of lines) {
    if (line.attempt !== last.attempt) continue;
    if (line.kind === "stage-started") open.add(line.stage);
    if (line.kind === "stage-ended") open.delete(line.stage);
  }
  return [...open].at(-1) ?? last.stage;
}

/** `running`, or `running (unchecked, last event 09:41:07)` where its process could not be asked. */
export function stateWord(status: RunStatus, lastEventAt?: number): string {
  if (status.state !== "running" || status.checked) return status.state;
  return `running (unchecked${lastEventAt === undefined ? "" : `, last event ${clockTime(lastEventAt)}`})`;
}

/** From the first attempt's start to the last's end, or to now while it runs. */
export function span(
  status: RunStatus,
  now: number,
): { started: number; ended?: number; ms: number } {
  const started = Date.parse(status.attempts[0]?.started ?? status.run.record.created);
  const last = status.attempts.at(-1);
  const ended = last?.ended ? Date.parse(last.ended) : undefined;
  return { started, ...(ended === undefined ? {} : { ended }), ms: (ended ?? now) - started };
}

/**
 * At list prices, today's, over the run's agent operations that recorded their spend, never what
 * was billed; and how many operations' usage isn't known, which makes it a floor.
 */
export async function estimateOf(
  status: RunStatus,
): Promise<{ estimate?: number; unknown: number }> {
  const spent = await readSpent(status.run.dir, status.attempts, { decisions: false }).catch(
    () => undefined,
  );
  if (!spent) return { unknown: 0 };
  const estimate = runEstimate(spent);
  // A running attempt's operations are read as it ends: not yet unknown.
  const live = status.state === "running" ? status.attempts.at(-1)?.attempt : undefined;
  return {
    ...(estimate === undefined ? {} : { estimate }),
    unknown: unknownOps(
      spent.map((each) => (each.attempt === live ? { ...each, unsettled: 0 } : each)),
    ),
  };
}
