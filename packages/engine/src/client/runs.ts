import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ClientError,
  type Ending,
  type Run as RunHandle,
  type RunStatus,
  type StartResult,
} from "@agentswf/contract/client";
import type { AttemptRecord, ClaimedAttempt, OutputRecord } from "@agentswf/contract/records";
import { isEventWorkflow, type JsonValue } from "@agentswf/contract/workflow";
import { canonical } from "../canonical-json";
import { messageOf } from "../errors";
import { exists } from "../files";
import { recordProject } from "../projects";
import { shellLine } from "../run-commands";
import { lockHeld, runLockFile, withRunLock } from "../run-lock";
import { type RunState, runStatus, statusOf, stuckOf } from "../run-state";
import {
  claimedOf,
  createRun,
  generateId,
  idProblem,
  openRun,
  outFile,
  type Run,
  RunRefused,
  RunTaken,
  readAttemptFiles,
} from "../runs";
import { wake } from "../wake";
import { type AnyWorkflow, assertJsonValue } from "../workflow-loader";
import type { ClientContext } from "./index";
import { locate } from "./locate";

/** How often a wait reads the run's files. */
const POLL_MILLISECONDS = 500;

/**
 * `start`: makes sure the run with these args exists and has been launched. A run there with the
 * same args is `exists`, launched only if it never had an attempt; with other args, or none
 * recorded, `other-args`.
 */
export async function start(
  workflow: AnyWorkflow,
  args: JsonValue,
  given: { id?: string },
  context: ClientContext,
): Promise<StartResult<JsonValue>> {
  const found = await locate(workflow, context.home);
  const name = workflow.meta.name;
  try {
    assertJsonValue(args, `${name} arguments`);
  } catch (error) {
    throw new ClientError("prepare", messageOf(error));
  }
  const named = given.id ?? derivedId(workflow, args);
  if (named !== undefined) {
    const problem = idProblem(named);
    if (problem) throw new ClientError("id", `the run's id: ${problem}`, `${name}/${named}`);
  }
  // Without one, a new id, as awf run makes one: no sender names this run.
  const id = named ?? (await unusedId(found.runRoot, name));
  const create = async (id: string): Promise<StartResult<JsonValue> | undefined> => {
    let run: Run;
    try {
      run = await createRun(found.runRoot, {
        id,
        workflow: name,
        argv: [],
        args,
        cwd: found.project,
        sandbox: null,
        ...(isEventWorkflow(workflow) ? { events: true as const } : {}),
        env: { PATH: context.environment.PATH ?? "" },
        file: found.file,
      });
    } catch (error) {
      // A generated id an `awf run` took meanwhile, which takes no lock: drawn again.
      if (named === undefined && error instanceof RunTaken) return undefined;
      // A named id an `awf run` took meanwhile: begun with no args recorded, as a moment later.
      if (error instanceof RunTaken && (await exists(join(found.runRoot, name, id, "run.json"))))
        throw new ClientError(
          "other-args",
          `${name}/${id} is there already, begun by awf run or an event, with no args recorded`,
          `${name}/${id}`,
        );
      // An id taken in another case is the caller's; a disk that fails is not.
      if (error instanceof RunRefused)
        throw new ClientError("id", messageOf(error), `${name}/${id}`);
      throw error;
    }
    await recordProject(context.home, found.project);
    return launched(run, "started");
  };
  const launched = async (run: Run, did: "started" | "exists"): Promise<StartResult<JsonValue>> => {
    const woken = await wake(run, { ...context, file: found.file });
    const handle = runHandle(run, context);
    if (woken.why === "launch-failed")
      return {
        ok: false,
        run: handle,
        did: "launch-failed",
        ...(woken.error ? { error: woken.error } : {}),
      };
    if (woken.why === "stuck") return { ok: false, run: handle, did: "stuck" };
    return { ok: true, run: handle, did };
  };
  const ref = `${name}/${id}`;
  if (named === undefined)
    // A generated id another caller drew the same minute is drawn again, never taken as theirs.
    for (let candidate = id; ; candidate = await unusedId(found.runRoot, name)) {
      const made = await withRunLock(runLockFile(found.runRoot, name, candidate), async () =>
        (await exists(join(found.runRoot, name, candidate))) ? undefined : create(candidate),
      );
      if (made) return made;
    }
  return withRunLock(runLockFile(found.runRoot, name, id), async () => {
    // Named, so never drawn again: create returns a result or throws.
    if (!(await exists(join(found.runRoot, name, id, "run.json")))) return (await create(id))!;
    const run = await openRun(found.runRoot, name, id);
    if (run.record.id !== id)
      throw new ClientError("id", `${ref} differs only in case from ${run.record.id}`, ref);
    if (run.record.args === undefined)
      throw new ClientError(
        "other-args",
        `${ref} is there already, started by an event or by awf run, with no args recorded; get reads it`,
        ref,
      );
    if (JSON.stringify(canonical(run.record.args)) !== JSON.stringify(canonical(args)))
      throw new ClientError(
        "other-args",
        `${ref} is there already, started with other args; another id starts these`,
        ref,
      );
    const files = await readAttemptFiles(run);
    if (claimedOf(files).length > 0)
      return { ok: true, run: runHandle(run, context), did: "exists" };
    // Never launched, or its launch failed: launched now, as a wake would, unless it is stuck.
    if (stuckOf(files)) return { ok: false, run: runHandle(run, context), did: "stuck" };
    return launched(run, "exists");
  });
}

async function unusedId(runRoot: string, workflow: string): Promise<string> {
  for (;;) {
    const id = generateId();
    if (!(await exists(join(runRoot, workflow, id)))) return id;
  }
}

/** The id `id(args)` gives, checked; a workflow with `starts` and none is refused. */
function derivedId(workflow: AnyWorkflow, args: JsonValue): string | undefined {
  const name = workflow.meta.name;
  if (!workflow.id) {
    if (isEventWorkflow(workflow) && workflow.starts !== undefined)
      throw new ClientError(
        "no-id",
        `a run of ${name}, which starts on events, is named by its senders: start(${name}, args, { id }), or an id(args) on the workflow`,
      );
    return undefined;
  }
  let id: unknown;
  try {
    id = workflow.id(args as never);
  } catch (error) {
    throw new ClientError("prepare", `${name}'s id(args) failed: ${messageOf(error)}`);
  }
  const problem = typeof id === "string" ? idProblem(id) : `it returned a ${typeof id}`;
  if (problem) throw new ClientError("id", `${name}'s id(args): ${problem}`);
  return id as string;
}

/** `get`: the run `id` of `workflow`, or `no-run`. */
export async function get(
  workflow: AnyWorkflow,
  id: string,
  context: ClientContext,
): Promise<RunHandle<JsonValue>> {
  const found = await locate(workflow, context.home);
  const ref = `${workflow.meta.name}/${id}`;
  const problem = idProblem(id);
  if (problem) throw new ClientError("id", `the run's id: ${problem}`, ref);
  if (!(await exists(join(found.runRoot, workflow.meta.name, id, "run.json"))))
    throw new ClientError("no-run", `no run ${ref} in ${found.project}`, ref);
  const run = await openRun(found.runRoot, workflow.meta.name, id);
  if (run.record.id !== id)
    throw new ClientError("no-run", `no run ${ref}; ${run.record.id} differs only in case`, ref);
  return runHandle(run, context);
}

/** A run, read from its files whenever asked. */
function runHandle(run: Run, context: Pick<ClientContext, "pollMs">): RunHandle<JsonValue> {
  const { id, workflow } = run.record;
  return {
    id,
    ref: `${workflow}/${id}`,
    status: () => statusNow(run),
    wait: (options = {}) =>
      waitFor(run, options.final === true, options.signal, context.pollMs ?? POLL_MILLISECONDS),
  };
}

/** Whether nothing continues a run in `state` on its own. */
export function isFinal(state: RunState, events: boolean): boolean {
  switch (state) {
    case "completed":
    case "stopped":
    case "cancelled":
    case "stuck":
      return true;
    case "failed":
    case "timed-out":
    case "interrupted":
      // An event run's next event, or awf tick, continues it.
      return !events;
    case "parked":
    case "running":
      return false;
  }
}

async function statusNow(run: Run): Promise<RunStatus<JsonValue>> {
  const status = await runStatus(run);
  const last = status.attempts.at(-1);
  const ending = last?.outcome === undefined ? undefined : await endingOf(run, last);
  return {
    state: status.state,
    final: isFinal(status.state, run.record.events === true),
    ...(ending ? { ending } : {}),
  };
}

/** An ended attempt's ending, from its record and, for the last one, `out.json`. */
async function endingOf(run: Run, attempt: ClaimedAttempt): Promise<Ending<JsonValue> | undefined> {
  const output = await readFile(outFile(run.dir), "utf8")
    .then((text) => JSON.parse(text) as OutputRecord)
    .catch(() => undefined);
  const own = output?.attempt === attempt.attempt ? output : undefined;
  const stages = own?.stages ?? [];
  switch (attempt.outcome) {
    case undefined:
      return undefined;
    case "completed":
      if (attempt.value !== undefined) return { kind: "completed", value: attempt.value, stages };
      return own?.outcome === "completed"
        ? { kind: "completed", value: own.value, stages }
        : undefined;
    case "parked":
      return {
        kind: "parked",
        stages,
        ...(own?.outcome === "parked" && own.label !== undefined ? { label: own.label } : {}),
        ...(own?.outcome === "parked" && own.until !== undefined ? { until: own.until } : {}),
      };
    default:
      return {
        kind: attempt.outcome,
        ...(attempt.stage === undefined ? {} : { stage: attempt.stage }),
        reason: attempt.reason ?? "",
        stages,
        continue: shellLine(["awf", "run", attempt.file, "--id", run.record.id, "--continue"]),
        ...(own && "needs" in own && own.needs ? { needs: own.needs } : {}),
      };
  }
}

/**
 * Waits for the run's next rest after the call, or, with `final`, the first rest nothing will
 * continue on its own. A rest is read from the attempt records, not by sampling the state: an
 * attempt current at the call, or any later one, ending or found dead; or a launch that failed
 * after the call, with the run's lock free.
 */
async function waitFor(
  run: Run,
  final: boolean,
  signal: AbortSignal | undefined,
  pollMs: number,
): Promise<RunStatus<JsonValue>> {
  signal?.throwIfAborted();
  const failedLaunches = (files: readonly AttemptRecord[]) =>
    files.filter((file) => file.kind === "failed-launch").length;
  // Read before the status: an attempt that rests and is continued between the two is still seen.
  const files = await readAttemptFiles(run);
  const at = claimedOf(files);
  let launches = failedLaunches(files);
  const now = await statusNow(run);
  if (final ? now.final : now.state !== "running") return now;
  const lockFile = runLockFile(run.root, run.record.workflow, run.record.id);
  // The attempt current at the call, or the first one after it.
  let watching =
    at.at(-1)?.outcome === undefined && at.length > 0
      ? at.at(-1)!.attempt
      : (files.at(-1)?.attempt ?? 0) + 1;
  for (;;) {
    await pause(pollMs, signal);
    const all = await readAttemptFiles(run);
    const attempts = claimedOf(all);
    let rested: ClaimedAttempt | undefined;
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]!;
      if (attempt.attempt < watching) continue;
      const state = statusOf(run, attempts.slice(0, i + 1)).state;
      if (state === "running") break;
      rested = attempt;
      watching = attempt.attempt + 1;
    }
    // A launch that failed is a rest once its sender has let the run go; a sender holding the lock
    // is launching it again.
    const launchFailed = failedLaunches(all) > launches && !(await lockHeld(lockFile));
    if (launchFailed) launches = failedLaunches(all);
    const current = await statusNow(run);
    if (final) {
      if (current.final) return current;
      continue;
    }
    if (current.state !== "running") return current;
    const events = run.record.events === true;
    if (rested) {
      // Rested, and continued since: the rest as it was.
      const state: RunState = rested.outcome ?? "interrupted";
      const ending = await endingOf(run, rested);
      return { state, final: isFinal(state, events), ...(ending ? { ending } : {}) };
    }
    // Unless an attempt has started since, by a sender that launched it again.
    if (launchFailed && !attempts.some((attempt) => attempt.attempt >= watching))
      return { state: "interrupted", final: isFinal("interrupted", events) };
  }
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    // Aborted meanwhile: a listener added now would never hear it.
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", done);
      resolve();
    }, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
