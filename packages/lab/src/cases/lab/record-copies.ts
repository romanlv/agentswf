import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RUN_FILE, RUN_ID, runDirOf, SCORES_FILE, TRIAL_FILE } from "./store";

// `records` in awf-lab.json: a folder inside evals/ that holds a copy of each run's records, at
// `{records}/runs/{id}/` as the store holds them, to be committed. Only what grading needs is
// copied: the run, each trial's record, its scores and its kept files. The built case is built
// again from the case folder and checked against the trial's digest; the agents' logs stay in
// the store, since a grader's run can hold a key.

const KEPT = "kept";

const runsOf = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => RUN_ID.test(n))
        .sort()
    : [];

/** Each trial folder of a run, relative to the run's folder. */
function trialSlots(runDir: string): string[] {
  const trials = join(runDir, "trials");
  if (!existsSync(trials)) return [];
  return readdirSync(trials).flatMap((name) =>
    readdirSync(join(trials, name)).map((slot) => join("trials", name, slot)),
  );
}

/** Copies a run's records from one folder of runs to another, replacing what is there. */
function copyRun(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(join(from, RUN_FILE), join(to, RUN_FILE));
  for (const slot of trialSlots(from)) {
    const source = join(from, slot);
    if (!existsSync(join(source, TRIAL_FILE))) continue;
    const target = join(to, slot);
    mkdirSync(target, { recursive: true });
    cpSync(join(source, TRIAL_FILE), join(target, TRIAL_FILE));
    if (existsSync(join(source, SCORES_FILE))) {
      cpSync(join(source, SCORES_FILE), join(target, SCORES_FILE));
    }
    rmSync(join(target, KEPT), { recursive: true, force: true });
    if (existsSync(join(source, KEPT))) {
      cpSync(join(source, KEPT), join(target, KEPT), { recursive: true });
    }
  }
}

/** Writes a run's records into the records folder. */
export function writeRecords(store: string, records: string, id: string): void {
  const from = runDirOf(store, id);
  if (!existsSync(join(from, RUN_FILE))) return;
  copyRun(from, join(records, "runs", id));
}

/**
 * Brings the records folder's runs into the store: a run the store lacks is copied whole, as a
 * fresh clone's are; for a run it has, a trial's scores are taken from the records when they
 * extend the store's, as when the run was graded again elsewhere.
 */
export function readRecords(store: string, records: string): void {
  const from = join(records, "runs");
  for (const id of runsOf(from)) {
    const theirs = join(from, id);
    const ours = runDirOf(store, id);
    if (!existsSync(join(theirs, RUN_FILE))) continue;
    if (!existsSync(join(ours, RUN_FILE))) {
      copyRun(theirs, ours);
      continue;
    }
    for (const slot of trialSlots(theirs)) {
      const recorded = join(theirs, slot, SCORES_FILE);
      const kept = join(ours, slot, SCORES_FILE);
      if (!existsSync(recorded) || !existsSync(join(ours, slot, TRIAL_FILE))) continue;
      const longer = readFileSync(recorded, "utf8");
      const shorter = existsSync(kept) ? readFileSync(kept, "utf8") : "";
      if (longer.length > shorter.length && longer.startsWith(shorter)) cpSync(recorded, kept);
    }
  }
}
