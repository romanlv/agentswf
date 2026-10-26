import { join } from "node:path";
import type { AttemptRecord, MailboxRecord, WaitingJson } from "@agentswf/contract/records";
import type { AttemptOutcome } from "@agentswf/contract/workflow";
import { exists } from "./files";
import { foldMailbox, readMailbox } from "./mailbox";
import { listProjects, projectRunRoot } from "./projects";
import {
  entries,
  idProblem,
  openRun,
  probeProcess,
  type Run,
  readAttempts,
  sameStart,
} from "./runs";

/** What `ps` says of a process: its start, `gone`, or `unknown`. */
export type ProcessStatus = (pid: number) => string | "gone" | "unknown";

/**
 * A run as `awf runs` and `awf logs` see it: its last attempt still open and its process there,
 * `running`; open and its process gone, `interrupted`; or how its last attempt ended. Read from
 * `run.json` and the attempt files, never the event log, so a run an older awf wrote reads too.
 */
export type RunState = "running" | "interrupted" | "stuck" | AttemptOutcome;

export type RunStatus = {
  run: Run;
  /** `{workflow}/{id}`. */
  ref: string;
  attempts: AttemptRecord[];
  state: RunState;
  /** False for a `running` whose process could not be asked about. */
  checked: boolean;
  /** A run of a workflow with `events` at its wait, live or parked: what its mailbox says. */
  waiting?: WaitingJson;
};

/** How long a run folder with no attempt yet may be an `awf run` still starting. */
const STARTING_MS = 60_000;

export async function runStatus(
  run: Run,
  probe: ProcessStatus = probeProcess,
  at = Date.now(),
): Promise<RunStatus> {
  const status = statusOf(run, await readAttempts(run), probe, at);
  const waiting = await waitingOf(status);
  const stuck =
    run.record.key !== undefined &&
    status.state !== "running" &&
    stuckOf(status.attempts, await readMailbox(run.dir));
  return { ...status, ...(waiting ? { waiting } : {}), ...(stuck ? { state: "stuck" } : {}) };
}

/** A keyed run's wait, while it is running or parked there: its label and `until`. */
async function waitingOf(status: RunStatus): Promise<WaitingJson | undefined> {
  if (status.run.record.key === undefined) return undefined;
  if (status.state !== "running" && status.state !== "parked") return undefined;
  const wait = foldMailbox(await readMailbox(status.run.dir)).lastWait;
  // A wait an earlier attempt died in is not this one's.
  if (!wait?.waiting || wait.attempt !== status.attempts.at(-1)?.attempt) return undefined;
  return {
    ...(wait.label === undefined ? {} : { label: wait.label }),
    ...(wait.until === undefined ? {} : { until: wait.until }),
  };
}

/** As `runStatus`, from its attempts as already read. */
export function statusOf(
  run: Run,
  attempts: AttemptRecord[],
  probe: ProcessStatus = probeProcess,
  at = Date.now(),
): RunStatus {
  const last = attempts.at(-1);
  const ref = `${run.record.workflow}/${run.record.id}`;
  // Between its folder and its first attempt's claim: an `awf run` starting, or, past a minute,
  // one refused or killed before it claimed one.
  if (!last) {
    const starting = at - Date.parse(run.record.created) < STARTING_MS;
    return { run, ref, attempts, state: starting ? "running" : "interrupted", checked: !starting };
  }
  if (last.outcome !== undefined) return { run, ref, attempts, state: last.outcome, checked: true };
  const now = probe(last.pid);
  if (now === "unknown") return { run, ref, attempts, state: "running", checked: false };
  const same = now !== "gone" && sameStart(now, last.processStart);
  return { run, ref, attempts, state: same ? "running" : "interrupted", checked: true };
}

const ALSO_RUNNING_CHECKED = 20;

/** A reference the commands take, or why there is none to read. */
export class RunNotFound extends Error {}

/**
 * Every run under `runRoot`, newest `created` first. A folder whose `run.json` cannot be read is
 * not a run this awf can show, and is passed over. One `known` has, by its folder, is not read
 * again: a run's record never changes.
 */
export async function listRuns(
  runRoot: string,
  known?: (dir: string) => Run | undefined,
): Promise<Run[]> {
  const runs: Run[] = [];
  for (const workflow of await entries(runRoot).catch(() => [])) {
    for (const id of await entries(join(runRoot, workflow)).catch(() => [])) {
      const run =
        known?.(join(runRoot, workflow, id)) ??
        (await openRun(runRoot, workflow, id).catch(() => undefined));
      if (run) runs.push(run);
    }
  }
  return runs.sort((a, b) => b.record.created.localeCompare(a.record.created));
}

/**
 * The run `ref` names, `{workflow}/{id}` or an `{id}` only one workflow here has; with none, the
 * newest here, and whichever others are still running beside it.
 */
export async function findRun(
  runRoot: string,
  ref: string | undefined,
  probe: ProcessStatus = probeProcess,
): Promise<{ status: RunStatus; alsoRunning: string[] }> {
  if (ref === undefined) {
    const [newest, ...older] = await listRuns(runRoot);
    if (!newest) throw new RunNotFound(`no runs under ${runRoot}`);
    const alsoRunning: string[] = [];
    // The newest few: each open attempt is a `ps`, and a run root is never pruned.
    for (const run of older.slice(0, ALSO_RUNNING_CHECKED)) {
      // One that cannot be read is no reason to fail a read of another.
      const status = await runStatus(run, probe).catch(() => undefined);
      if (status?.state === "running") alsoRunning.push(status.ref);
    }
    return { status: await runStatus(newest, probe), alsoRunning };
  }
  const slash = ref.indexOf("/");
  if (slash >= 0) {
    const [workflow, id] = [ref.slice(0, slash), ref.slice(slash + 1)];
    const problem = idProblem(workflow) ?? idProblem(id);
    if (problem) throw new RunNotFound(`no run ${ref}: ${problem}`);
    // A record that is there but cannot be read is not a missing run, and says why itself.
    if (!(await exists(join(runRoot, workflow, id, "run.json")))) {
      const missing = await openRun(runRoot, workflow, id).catch((error: unknown) => error);
      throw new RunNotFound(missing instanceof Error ? missing.message : `no run ${ref}`);
    }
    const run = await openRun(runRoot, workflow, id);
    return { status: await runStatus(run, probe), alsoRunning: [] };
  }
  const found = (await listRuns(runRoot)).filter((run) => run.record.id === ref);
  if (found.length === 0) throw new RunNotFound(`no run ${ref} under ${runRoot}`);
  if (found.length > 1) {
    const refs = found.map((run) => `${run.record.workflow}/${ref}`).join(", ");
    throw new RunNotFound(`${ref} names a run of more than one workflow: ${refs}`);
  }
  return { status: await runStatus(found[0]!, probe), alsoRunning: [] };
}

/** Failed or crashed attempts in a row, counted together, after which a run is `stuck` (Q13). */
export const STUCK_AFTER = 3;

/**
 * Failed, timed-out or crashed attempts at the end of the run, and launches since the last attempt
 * that never claimed one, counted together; any other ending resets them.
 */
export function failuresInARow(
  attempts: readonly AttemptRecord[],
  records: readonly MailboxRecord[] = [],
): number {
  const since = attempts.at(-1)?.started ?? "";
  let n = records.filter((record) => record.kind === "launch-failed" && record.at > since).length;
  for (const attempt of [...attempts].reverse()) {
    const failed =
      attempt.outcome === undefined ||
      attempt.outcome === "failed" ||
      attempt.outcome === "timed-out";
    if (!failed) break;
    n++;
  }
  return n;
}

/**
 * Whether a keyed run is `stuck` (Q13): failed, crashed or failed to launch three times in a row,
 * whatever its last ending says, short of one the operator or the code chose.
 */
export function stuckOf(
  attempts: readonly AttemptRecord[],
  records: readonly MailboxRecord[],
): boolean {
  const last = attempts.at(-1)?.outcome;
  if (last === "completed" || last === "stopped" || last === "cancelled") return false;
  return failuresInARow(attempts, records) >= STUCK_AFTER;
}

/** A run by its ref, under `--cwd`'s runs or in a project awf started a keyed run in (Q15). */
export async function findKeyedRun(
  ref: string,
  place: { runRoot: string },
  home: string,
): Promise<RunStatus | undefined> {
  // Here first: what `--cwd` names wins.
  let here: RunNotFound;
  try {
    return (await findRun(place.runRoot, ref)).status;
  } catch (error) {
    if (!(error instanceof RunNotFound)) throw error;
    here = error;
  }
  const found: RunStatus[] = [];
  for (const project of await listProjects(home)) {
    try {
      found.push((await findRun(projectRunRoot(project), ref)).status);
    } catch (error) {
      if (!(error instanceof RunNotFound)) throw error;
    }
  }
  // Workflows of one name in two projects make the same ref: naming the project is the caller's.
  if (found.length > 1)
    throw new RunNotFound(
      `${ref} is a run in ${found.length} projects, ${found.map((each) => each.run.record.cwd).join(" and ")}; --cwd names one`,
    );
  if (found[0]) return found[0];
  // Nowhere: a ref that can't name a run, malformed or naming two workflows, says why.
  if (malformedRef(ref) || here.message.includes("more than one workflow")) throw here;
  return undefined;
}

/** Why `ref` can't name a run at all, whatever is on disk; undefined when it can. */
function malformedRef(ref: string): string | undefined {
  const slash = ref.indexOf("/");
  if (slash < 0) return idProblem(ref);
  return idProblem(ref.slice(0, slash)) ?? idProblem(ref.slice(slash + 1));
}
