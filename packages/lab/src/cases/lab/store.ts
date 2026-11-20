import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type Type from "typebox";
import { type Checked, checkSchema, describeProblems } from "../../shared/validate";
import {
  type RunRecord,
  RunRecordSchema,
  retiredRecord,
  type ScoreRecord,
  ScoreRecordSchema,
  type TrialRecord,
  TrialRecordSchema,
} from "../format/records";

// The store: `{store}/runs/{id}/run.json`; a trial at `runs/{id}/trials/{case}/{column}-{trial}/`,
// with `trial.json`, `kept/`, `trial.jsonl` (its trial file) and `scores.jsonl` (every score,
// newest last); each built case once, at `inputs/{digest}/`; the workflows' runs under
// `{store}/awf-runs`.

export const RUN_FILE = "run.json";
export const TRIAL_FILE = "trial.json";
export const SCORES_FILE = "scores.jsonl";
/** In a run's trial folder in place of `trial.json`: the trial it reuses, where that one ran. */
export const REUSED_FILE = "reused.json";

export type TrialRef = { run: string; column: number; trial: number };

export const awfRunsOf = (store: string) => join(store, "awf-runs");
export const runDirOf = (store: string, id: string) => join(store, "runs", id);
export const trialDirOf = (
  store: string,
  id: string,
  name: string,
  column: number,
  trial: number,
) => join(runDirOf(store, id), "trials", name, `${column}-${trial}`);
/** A built case folder, kept once by its digest however many trials ran on it. */
export const inputDirOf = (store: string, digest: string) => join(store, "inputs", digest);

/** Keeps a built case folder under its digest, unless it is kept already; made whole, then moved. */
export function keepInput(store: string, digest: string, from: string): string {
  const target = inputDirOf(store, digest);
  if (existsSync(target)) return target;
  const making = `${target}.${process.pid}-${randomUUID()}`;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(from, making, { recursive: true, verbatimSymlinks: true });
  try {
    renameSync(making, target);
  } catch (error) {
    rmSync(making, { recursive: true, force: true });
    if (!existsSync(target)) throw error;
  }
  return target;
}

/** An `awf run --id` unique among every workflow's runs in the store. */
export function newRunId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * A trial's file, which its process appends to, in the lab's home: named by this process, so a
 * later `run` sweeps what a dead one left.
 */
export function trialFileOf(labHome: string): string {
  return join(labHome, "trials", `${process.pid}-${randomUUID()}.jsonl`);
}

/** Removes trial files whose lab is gone; never one still owned, or not named by a process. */
export function clearStaleTrialFiles(labHome: string): number {
  const dir = join(labHome, "trials");
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const pid = /^([1-9][0-9]*)-/.exec(name)?.[1];
    if (pid !== undefined && !alive(Number(pid))) {
      rmSync(join(dir, name), { force: true });
      removed++;
    }
  }
  return removed;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a lock file holds; undefined when it holds none this lab wrote. */
function lockHolder(file: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One `run` or `score` at a time on a machine, under a lockfile in `~/.awf/lab/` whatever `store`
 * says, freed when its process is gone. The lock is made whole, a file with this pid linked into
 * place, so no lab ever reads it half written; a stale one is moved aside before it is removed,
 * and only when it still holds the pid found dead. Returns the release, or who holds it: a pid,
 * or `undefined` for a lock this lab can't read, which it never removes.
 */
export function takeLock(
  labHome: string,
): { release: () => void } | { heldBy: number | undefined } {
  mkdirSync(labHome, { recursive: true });
  const file = join(labHome, "lock");
  const mine = join(labHome, `lock.${process.pid}-${randomUUID()}`);
  writeFileSync(mine, JSON.stringify({ pid: process.pid }));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(mine, file);
        return {
          release: () => {
            if (lockHolder(file) === process.pid) rmSync(file, { force: true });
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const pid = lockHolder(file);
      if (pid === undefined || alive(pid)) return { heldBy: pid };
      const aside = join(labHome, `lock.stale-${randomUUID()}`);
      try {
        renameSync(file, aside);
      } catch {
        continue;
      }
      if (lockHolder(aside) === pid) rmSync(aside, { force: true });
      else {
        // Another lab took the lock between the read and the move: put its lock back.
        try {
          linkSync(aside, file);
        } catch {}
        rmSync(aside, { force: true });
        return { heldBy: lockHolder(file) };
      }
    }
    throw new Error(`could not take the lock ${file}`);
  } finally {
    rmSync(mine, { force: true });
  }
}

/**
 * A new run's id, its folder claimed: the time and four random hex digits, unique across machines
 * so records from two of them never clash, and ordered by time as text.
 */
export function claimRun(store: string, now: Date): string {
  mkdirSync(join(store, "runs"), { recursive: true });
  // Claimed under the lock: a second run within a second takes the next second, so ids stay in
  // the order the runs were made.
  const last = runIds(store).at(-1);
  let at = now.getTime() - (now.getTime() % 1000);
  if (last && stampOf(at) <= last.slice(0, 15)) at = timeOf(last) + 1000;
  const stamp = stampOf(at);
  for (;;) {
    const id = `${stamp}-${randomUUID().slice(0, 4)}`;
    try {
      mkdirSync(runDirOf(store, id));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

const stampOf = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** The time an id was claimed at, to the second. */
function timeOf(id: string): number {
  const [, y, mo, d, h, mi, se] = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id)!;
  return Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!);
}

/** The store's run ids, oldest first. */
export function runIds(store: string): string[] {
  const dir = join(store, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => RUN_ID.test(name))
    .sort();
}

export const RUN_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;

/**
 * The store's runs whose records read, each with its trials, oldest first unless `newest`; of one
 * dataset when named, and made before the run id `before` when given. A run whose records don't
 * read is left out: `runs` names it.
 */
export function* readableRuns(
  store: string,
  options: { dataset?: string; newest?: boolean; before?: string } = {},
): Generator<{ run: RunRecord; trials: StoredTrial[] }> {
  const { before } = options;
  const ids = runIds(store).filter((id) => before === undefined || id < before);
  for (const id of options.newest ? ids.reverse() : ids) {
    let read: { run: RunRecord; trials: StoredTrial[] } | undefined;
    try {
      const run = readRunRecord(store, id);
      if (!run || (options.dataset !== undefined && run.dataset !== options.dataset)) continue;
      read = { run, trials: readTrials(store, id) };
    } catch (error) {
      if (error instanceof UnreadableRecord) continue;
      throw error;
    }
    yield read;
  }
}

/**
 * When a run ran, for the grades it made: from its start to its finish. A run killed before it
 * stamped one ends when the next run's id says it started, so a `score` made in between counts as
 * its; with no next run, it is open.
 */
export function runSpan(store: string, run: RunRecord): { started: string; finished?: string } {
  if (run.finished !== undefined) return { started: run.started, finished: run.finished };
  const next = runIds(store).find((id) => id > run.id);
  return next
    ? { started: run.started, finished: new Date(timeOf(next)).toISOString() }
    : { started: run.started };
}

/**
 * A record this lab can't read: written before a `/0` format changed shape, or not JSON. History
 * leaves its run out; any other error is the lab's.
 */
export class UnreadableRecord extends Error {}

function checked<T>(file: string, result: Checked<T>): T {
  if (!result.ok) throw new UnreadableRecord(describeProblems(file, result.problems));
  return result.value;
}

/** A record read back: a retired `/0` one is named, any other checked against its schema. */
function readRecord<T>(file: string, schema: Type.TSchema, value: unknown): T {
  const retired = retiredRecord(file, value);
  if (retired) throw new UnreadableRecord(retired);
  return checked(file, checkSchema(schema, value)) as T;
}

function readJson(file: string): unknown {
  return parseJson(file, readFileSync(file, "utf8"));
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UnreadableRecord(`${file} is not valid:\n  ${(error as Error).message}`);
  }
}

export function writeRun(store: string, run: RunRecord): void {
  const file = join(runDirOf(store, run.id), RUN_FILE);
  writeFileSync(
    file,
    `${JSON.stringify(checked(file, checkSchema(RunRecordSchema, run)), null, 2)}\n`,
  );
}

export function readRunRecord(store: string, id: string): RunRecord | undefined {
  const file = join(runDirOf(store, id), RUN_FILE);
  if (!existsSync(file)) return undefined;
  return readRecord<RunRecord>(file, RunRecordSchema, readJson(file));
}

export function writeTrial(dir: string, trial: TrialRecord): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, TRIAL_FILE);
  writeFileSync(
    file,
    `${JSON.stringify(checked(file, checkSchema(TrialRecordSchema, trial)), null, 2)}\n`,
  );
}

export function appendScore(dir: string, score: ScoreRecord): void {
  const file = join(dir, SCORES_FILE);
  appendFileSync(file, `${JSON.stringify(checked(file, checkSchema(ScoreRecordSchema, score)))}\n`);
}

export type StoredTrial = { dir: string; record: TrialRecord; scores: ScoreRecord[] };

/** A run's trials, each with its scores, newest last. */
function readSlot(dir: string): Omit<StoredTrial, "dir"> | undefined {
  const file = join(dir, TRIAL_FILE);
  if (!existsSync(file)) return undefined;
  const record = readRecord<TrialRecord>(file, TrialRecordSchema, readJson(file));
  const scoresFile = join(dir, SCORES_FILE);
  const scores = existsSync(scoresFile)
    ? readFileSync(scoresFile, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) =>
          readRecord<ScoreRecord>(scoresFile, ScoreRecordSchema, parseJson(scoresFile, line)),
        )
    : [];
  return { record, scores };
}

/**
 * A run's trials, each with its scores, newest last. A reused trial is read where it ran, so its
 * grades are one list however many runs reuse it, and shown as this run's, marked `reused`.
 */
export function readTrials(store: string, id: string): StoredTrial[] {
  const root = join(runDirOf(store, id), "trials");
  if (!existsSync(root)) return [];
  const found: StoredTrial[] = [];
  for (const name of readdirSync(root).sort()) {
    for (const slot of readdirSync(join(root, name)).sort()) {
      const dir = join(root, name, slot);
      const pointer = join(dir, REUSED_FILE);
      if (existsSync(pointer)) {
        const ref = readJson(pointer) as TrialRef;
        const at = trialDirOf(store, ref.run, name, ref.column, ref.trial);
        const ran = readSlot(at);
        if (!ran) continue; // the run it reuses is gone from this store
        const [column, trial] = slot.split("-").map(Number) as [number, number];
        found.push({
          dir: at,
          record: { ...ran.record, run: id, column, trial, reused: ref },
          scores: ran.scores,
        });
        continue;
      }
      const ran = readSlot(dir);
      if (ran) found.push({ dir, ...ran });
    }
  }
  return found.sort((a, b) => a.record.trial - b.record.trial || a.record.column - b.record.column);
}
