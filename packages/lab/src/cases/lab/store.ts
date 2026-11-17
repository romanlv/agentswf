import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Checked, checkSchema, describeProblems } from "../../shared/validate";
import {
  type RunRecord,
  RunRecordSchema,
  type ScoreRecord,
  ScoreRecordSchema,
  type TrialRecord,
  TrialRecordSchema,
} from "../format/records";

// The store: `{store}/runs/{n}/run.json`; a trial at `runs/{n}/trials/{case}/{column}-{trial}/`,
// with `trial.json`, `input/` (the built case folder), `kept/`, `trial.jsonl` (its trial file)
// and `scores.jsonl` (every score, newest last); the workflows' runs under `{store}/awf-runs`.

export const RUN_FILE = "run.json";
export const TRIAL_FILE = "trial.json";
export const SCORES_FILE = "scores.jsonl";

export const awfRunsOf = (store: string) => join(store, "awf-runs");
export const runDirOf = (store: string, n: number) => join(store, "runs", String(n));
export const trialDirOf = (store: string, n: number, name: string, column: number, trial: number) =>
  join(runDirOf(store, n), "trials", name, `${column}-${trial}`);

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

/** The next run's number, its folder claimed: taken under the lock. */
export function claimRun(store: string): number {
  mkdirSync(join(store, "runs"), { recursive: true });
  const taken = runNumbers(store);
  const next = (taken.at(-1) ?? 0) + 1;
  mkdirSync(runDirOf(store, next));
  return next;
}

export function runNumbers(store: string): number[] {
  const dir = join(store, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^[1-9][0-9]*$/.test(name))
    .map(Number)
    .sort((a, b) => a - b);
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
  const file = join(runDirOf(store, run.number), RUN_FILE);
  writeFileSync(
    file,
    `${JSON.stringify(checked(file, checkSchema(RunRecordSchema, run)), null, 2)}\n`,
  );
}

export function readRunRecord(store: string, n: number): RunRecord | undefined {
  const file = join(runDirOf(store, n), RUN_FILE);
  if (!existsSync(file)) return undefined;
  return checked(file, checkSchema(RunRecordSchema, readJson(file)));
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
export function readTrials(store: string, n: number): StoredTrial[] {
  const root = join(runDirOf(store, n), "trials");
  if (!existsSync(root)) return [];
  const found: StoredTrial[] = [];
  for (const name of readdirSync(root).sort()) {
    for (const slot of readdirSync(join(root, name)).sort()) {
      const dir = join(root, name, slot);
      const file = join(dir, TRIAL_FILE);
      if (!existsSync(file)) continue;
      const record = checked(file, checkSchema(TrialRecordSchema, readJson(file)));
      const scoresFile = join(dir, SCORES_FILE);
      const scores = existsSync(scoresFile)
        ? readFileSync(scoresFile, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) =>
              checked(scoresFile, checkSchema(ScoreRecordSchema, parseJson(scoresFile, line))),
            )
        : [];
      found.push({ dir, record, scores });
    }
  }
  return found.sort((a, b) => a.record.trial - b.record.trial || a.record.column - b.record.column);
}
