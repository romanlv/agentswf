import { dirname, join } from "node:path";
import type { AttemptRecord, ClaimedAttempt, WaitingJson } from "@agentswf/contract/records";
import type { AttemptOutcome } from "@agentswf/contract/workflow";
import { exists } from "./files";
import { checkProjectEngine } from "./project-engine";
import { listProjects, projectOf, projectRunRoot, rootProject } from "./projects";
import { lockHeld, runLockFile } from "./run-lock";
import { nextTimer, untakenAtReturn, type WaitState } from "./run-policy/waits";
import {
  claimedOf,
  entries,
  idProblem,
  openRun,
  probeProcess,
  type Run,
  RunUnreadable,
  readAttemptFiles,
  sameStart,
} from "./runs";
import { readWaits } from "./waits";

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
  /** The attempts that ran, in order: what its state is decided from. */
  attempts: ClaimedAttempt[];
  /** Every attempt file, in order, a background launch that never claimed its number included. */
  files: AttemptRecord[];
  state: RunState;
  /** False for a `running` whose process could not be asked about. */
  checked: boolean;
  /** A run of a workflow with `events` at its wait, live or parked: what its last `wait` line says. */
  waiting?: WaitingJson;
  /**
   * A completed run of a workflow with `events`: how many events no wait took by when it returned,
   * from its lines. Its last batch taken was handled, as the code returned after it.
   */
  unacknowledged?: number;
};

/** How long a run folder with no attempt yet may be an `awf run` still starting. */
const STARTING_MS = 60_000;

export async function runStatus(
  run: Run,
  probe: ProcessStatus = probeProcess,
  at = Date.now(),
): Promise<RunStatus> {
  let status = statusOf(run, await readAttemptFiles(run), probe, at);
  if (status.attempts.length === 0 && (status.files.length > 0 || status.state === "interrupted")) {
    // Its launch failed, or is past the minute an attempt has to claim it: unless a live sender
    // holds its lock, launching it, nothing runs it.
    const { workflow, id } = run.record;
    const launching = await lockHeld(runLockFile(run.root, workflow, id));
    status = { ...status, state: launching ? "running" : "interrupted", checked: true };
  }
  if (!run.record.events) {
    // A plain run's failed attempt is final; only a program's start, whose launches failed, sticks.
    const stuck = status.state !== "running" && launchesFailed(status.files) >= STUCK_AFTER;
    return stuck ? { ...status, state: "stuck" } : status;
  }
  // A `run.jsonl` that can't be read shows no wait; `awf runs` says why it can't be read.
  const waiting =
    status.state === "running" || status.state === "parked"
      ? await readWaits(run.dir, at).then(
          (state) => waitingOf(status, state),
          () => undefined,
        )
      : undefined;
  const returned = status.state === "completed" ? status.attempts.at(-1)?.ended : undefined;
  const unacknowledged =
    returned === undefined
      ? undefined
      : await readWaits(run.dir, Date.parse(returned)).then(untakenAtReturn, () => undefined);
  const stuck = status.state !== "running" && stuckOf(status.files);
  return {
    ...status,
    ...(waiting ? { waiting } : {}),
    ...(unacknowledged === undefined ? {} : { unacknowledged }),
    ...(stuck ? { state: "stuck" } : {}),
  };
}

/** An event run's wait, while it is running or parked there: its label and `until`. */
function waitingOf(status: RunStatus, state: WaitState): WaitingJson | undefined {
  const wait = state.lastWait;
  // A wait an earlier attempt died in is not this one's.
  if (!wait?.waiting || wait.attempt !== status.attempts.at(-1)?.attempt) return undefined;
  const until = nextTimer(state, wait.takes);
  return {
    ...(wait.label === undefined ? {} : { label: wait.label }),
    ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
  };
}

/**
 * As `runStatus`, from its attempt files as already read: decided from the attempts that ran, so a
 * launch that never claimed its number leaves a parked run parked.
 */
export function statusOf(
  run: Run,
  files: readonly AttemptRecord[],
  probe: ProcessStatus = probeProcess,
  at = Date.now(),
): RunStatus {
  const attempts = claimedOf(files);
  const head = { run, ref: `${run.record.workflow}/${run.record.id}`, attempts, files: [...files] };
  const last = attempts.at(-1);
  // Between its folder and its first attempt's claim: an `awf run` starting, or, past a minute,
  // one refused or killed before it claimed one.
  if (!last) {
    const starting = at - Date.parse(run.record.created) < STARTING_MS;
    return { ...head, state: starting ? "running" : "interrupted", checked: !starting };
  }
  if (last.outcome !== undefined) return { ...head, state: last.outcome, checked: true };
  const now = probe(last.pid);
  if (now === "unknown") return { ...head, state: "running", checked: false };
  const same = now !== "gone" && sameStart(now, last.processStart);
  return { ...head, state: same ? "running" : "interrupted", checked: true };
}

const ALSO_RUNNING_CHECKED = 20;

/**
 * A reference the commands take, or why there is none to read: `no-run`, none by that ref; `id`, a
 * ref no run could have; `ambiguous`, one naming runs of two workflows or projects.
 */
export class RunNotFound extends Error {
  constructor(
    message: string,
    readonly code: "no-run" | "id" | "ambiguous" = "no-run",
  ) {
    super(message);
  }
}

/**
 * Every run under `runRoot`, newest `created` first. A folder whose `run.json` cannot be read is
 * not a run this awf can show, and is passed over. One `known` has, by its folder, is not read
 * again: a run's record never changes.
 */
export async function listRuns(
  runRoot: string,
  known?: (dir: string) => Run | undefined,
): Promise<Run[]> {
  return (await listRunEntries(runRoot, known)).filter(
    (each): each is Run => !(each instanceof RunUnreadable),
  );
}

/**
 * The same, with each run of a `format` this awf does not read in its place by `created`, the
 * last when it has none: `awf runs` lists them `unreadable`.
 */
export async function listRunEntries(
  runRoot: string,
  known?: (dir: string) => Run | undefined,
): Promise<(Run | RunUnreadable)[]> {
  const runs: (Run | RunUnreadable)[] = [];
  for (const workflow of await entries(runRoot).catch(() => [])) {
    for (const id of await entries(join(runRoot, workflow)).catch(() => [])) {
      const run =
        known?.(join(runRoot, workflow, id)) ??
        (await openRun(runRoot, workflow, id).catch((error: unknown) =>
          error instanceof RunUnreadable ? error : undefined,
        ));
      if (run) runs.push(run);
    }
  }
  const created = (each: Run | RunUnreadable) =>
    each instanceof RunUnreadable ? (each.created ?? "") : each.record.created;
  return runs.sort((a, b) => created(b).localeCompare(created(a)));
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
    if (problem) throw new RunNotFound(`no run ${ref}: ${problem}`, "id");
    // A record that is there but cannot be read is not a missing run, and says why itself.
    if (!(await exists(join(runRoot, workflow, id, "run.json")))) {
      const missing = await openRun(runRoot, workflow, id).catch((error: unknown) => error);
      throw new RunNotFound(missing instanceof Error ? missing.message : `no run ${ref}`);
    }
    const run = await openRun(runRoot, workflow, id);
    return { status: await runStatus(run, probe), alsoRunning: [] };
  }
  const listed = await listRunEntries(runRoot);
  const found = listed.filter(
    (run): run is Run => !(run instanceof RunUnreadable) && run.record.id === ref,
  );
  if (found.length === 0) {
    // A run of an earlier format says so, as it does named by its workflow.
    const old = listed.find((run) => run instanceof RunUnreadable && run.ref.endsWith(`/${ref}`));
    if (old) throw old;
    throw new RunNotFound(`no run ${ref} under ${runRoot}`);
  }
  if (found.length > 1) {
    const refs = found.map((run) => `${run.record.workflow}/${ref}`).join(", ");
    throw new RunNotFound(`${ref} names a run of more than one workflow: ${refs}`, "ambiguous");
  }
  return { status: await runStatus(found[0]!, probe), alsoRunning: [] };
}

/** Failed or crashed attempts in a row, counted together, after which a run is `stuck` (Q13). */
export const STUCK_AFTER = 3;

/** Launches that never claimed their number since the last attempt that did. */
function launchesFailed(files: readonly AttemptRecord[]): number {
  let n = 0;
  for (const file of [...files].reverse()) {
    if (file.kind !== "failed-launch") break;
    n++;
  }
  return n;
}

/**
 * Failed, timed-out or crashed attempts at the end of the run, a background launch that never
 * claimed its number among them, as its launcher wrote it failed; any other ending resets them.
 */
function failuresInARow(attempts: readonly AttemptRecord[]): number {
  let n = 0;
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
 * Whether an event run is `stuck` (Q13): failed, crashed or failed to launch three times in a row,
 * whatever its last ending says, short of one the operator or the code chose.
 */
export function stuckOf(attempts: readonly AttemptRecord[]): boolean {
  const last = attempts.at(-1)?.outcome;
  if (last === "completed" || last === "stopped" || last === "cancelled") return false;
  return failuresInARow(attempts) >= STUCK_AFTER;
}

/**
 * The run `ref` names, `{workflow}/{id}` or an `{id}` only one workflow has: under `--cwd`'s runs
 * first, then in each project awf started an event run in (Q15). Every command that takes a run
 * finds it here.
 */
export async function findRunByRef(
  ref: string,
  place: { runRoot: string },
  home: string,
): Promise<RunStatus> {
  const status = await findAnywhere(ref, place, home);
  await checkRunEngine(status, home);
  return status;
}

/**
 * Refuses a run this engine doesn't run: as `awf run` checked it, the project of the file it last
 * ran, not the folder a `--cwd` put it to work in; without a file, the project it is kept in.
 */
export async function checkRunEngine(
  status: Pick<RunStatus, "run" | "attempts">,
  home: string,
): Promise<void> {
  const file = status.attempts.at(-1)?.file ?? status.run.record.file;
  if (file === undefined) return checkProjectEngine(runProject(status.run));
  const project = await projectOf(file, home).catch(() => dirname(file));
  checkProjectEngine(project, { file });
}

/**
 * The project a run belongs to: the folder holding the `.awf/runs` it is kept in, else, under a
 * `--run-root` of the operator's, the directory it works in.
 */
function runProject(run: Pick<Run, "root" | "record">): string {
  return rootProject(run.root, run.record.cwd);
}

async function findAnywhere(
  ref: string,
  place: { runRoot: string },
  home: string,
): Promise<RunStatus> {
  // Here first: what `--cwd` names wins. A run an earlier awf made is said only where no run
  // that reads has the ref.
  let here: RunNotFound | RunUnreadable;
  let old: RunUnreadable | undefined;
  try {
    return (await findRun(place.runRoot, ref)).status;
  } catch (error) {
    if (error instanceof RunUnreadable) old = error;
    else if (!(error instanceof RunNotFound)) throw error;
    here = error;
  }
  const found: RunStatus[] = [];
  for (const project of await listProjects(home)) {
    try {
      found.push((await findRun(projectRunRoot(project), ref)).status);
    } catch (error) {
      if (error instanceof RunUnreadable) old ??= error;
      else if (!(error instanceof RunNotFound)) throw error;
    }
  }
  // Workflows of one name in two projects make the same ref: naming the project is the caller's.
  if (found.length > 1)
    throw new RunNotFound(
      `${ref} is a run in ${found.length} projects, ${found.map((each) => each.run.record.cwd).join(" and ")}; --cwd names one`,
      "ambiguous",
    );
  if (found[0]) return found[0];
  if (old) throw old;
  // Nowhere: a ref that can't name a run, malformed or naming two workflows, says why.
  const problem = malformedRef(ref);
  if (problem) throw new RunNotFound(`no run ${ref}: ${problem}`, "id");
  if (here.message.includes("more than one workflow")) throw here;
  throw new RunNotFound(`no run ${ref} under ${place.runRoot}, or in a project awf knows`);
}

/** Why `ref` can't name a run at all, whatever is on disk; undefined when it can. */
function malformedRef(ref: string): string | undefined {
  const slash = ref.indexOf("/");
  if (slash < 0) return idProblem(ref);
  return idProblem(ref.slice(0, slash)) ?? idProblem(ref.slice(slash + 1));
}
