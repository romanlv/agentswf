import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { labelsFileOf } from "./labels";
import {
  REUSED_FILE,
  RUN_FILE,
  RUN_ID,
  runDirOf,
  SCORES_FILE,
  TRIAL_FILE,
  type TrialRef,
} from "./store";

// `records` in awf-lab.json: a folder inside evals/ holding a copy of each run's records, at
// `{records}/runs/{id}/` as the store holds them, to be committed. Only what grading needs is
// copied: the run, each trial's record or reuse pointer, its scores and its kept files. The built
// case is built again from the case folder and checked against the trial's digest; the agents'
// logs stay in the store, since a grader's run can hold a key.
//
// Copies go one way per command: every command reads the records into the store, and only `run`,
// `score` and `label` write the records folder. Scores and labels are only ever added, so both are
// merged as the union of their lines and no grade made elsewhere is lost. In the records each
// grade and each label is a file of its own (`scores/` in a trial's folder, `labels/{dataset}/`),
// so two branches that grade or label never touch the same file.

const KEPT = "kept";
/** A trial's grades in the records: a folder of one-line files, in place of `scores.jsonl`. */
const SCORES = "scores";

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

const linesOf = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
    : [];

const atOf = (line: string) => {
  try {
    return String((JSON.parse(line) as { at?: unknown }).at ?? "");
  } catch {
    return "";
  }
};

/** A line's own file name in the records: its time and a digest of the line. */
const ownFile = (line: string) =>
  `${atOf(line).replace(/[-:.]/g, "")}-${createHash("sha256").update(line).digest("hex").slice(0, 8)}.json`;

/** Writes each line of `file` that `dir` lacks as a file of its own. */
function linesToFiles(file: string, dir: string): void {
  for (const line of linesOf(file)) {
    const target = join(dir, ownFile(line));
    if (existsSync(target)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, `${line}\n`);
  }
}

/** The lines kept as files in `dir`, oldest first. */
const filesToLines = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .sort()
        .map((n) => readFileSync(join(dir, n), "utf8").trim())
        .filter(Boolean)
    : [];

/** Adds to a jsonl file each line it lacks, keeping them in time order. */
function addLines(into: string, lines: readonly string[]): void {
  const have = linesOf(into);
  const known = new Set(have);
  const missing = lines.filter((line) => !known.has(line));
  if (missing.length === 0) return;
  const all = [...have, ...missing].sort((x, y) => atOf(x).localeCompare(atOf(y)));
  mkdirSync(dirname(into), { recursive: true });
  writeFileSync(into, `${all.join("\n")}\n`);
}

/** A run of the store into the records: each grade a file of its own. */
function exportRun(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(join(from, RUN_FILE), join(to, RUN_FILE));
  for (const slot of trialSlots(from)) {
    const source = join(from, slot);
    const target = join(to, slot);
    if (existsSync(join(source, REUSED_FILE))) {
      mkdirSync(target, { recursive: true });
      cpSync(join(source, REUSED_FILE), join(target, REUSED_FILE));
      continue;
    }
    if (!existsSync(join(source, TRIAL_FILE))) continue;
    mkdirSync(target, { recursive: true });
    cpSync(join(source, TRIAL_FILE), join(target, TRIAL_FILE));
    linesToFiles(join(source, SCORES_FILE), join(target, SCORES));
    if (existsSync(join(source, KEPT)) && !existsSync(join(target, KEPT))) {
      cpSync(join(source, KEPT), join(target, KEPT), { recursive: true });
    }
  }
}

/** A run of the records into the store, or its grades made elsewhere into the store's run. */
function importRun(from: string, to: string): void {
  const whole = !existsSync(join(to, RUN_FILE));
  if (whole) {
    mkdirSync(to, { recursive: true });
    cpSync(join(from, RUN_FILE), join(to, RUN_FILE));
  }
  for (const slot of trialSlots(from)) {
    const source = join(from, slot);
    const target = join(to, slot);
    if (existsSync(join(source, REUSED_FILE))) {
      if (whole) {
        mkdirSync(target, { recursive: true });
        cpSync(join(source, REUSED_FILE), join(target, REUSED_FILE));
      }
      continue;
    }
    if (!existsSync(join(source, TRIAL_FILE))) continue;
    if (whole) {
      mkdirSync(target, { recursive: true });
      cpSync(join(source, TRIAL_FILE), join(target, TRIAL_FILE));
      if (existsSync(join(source, KEPT))) {
        cpSync(join(source, KEPT), join(target, KEPT), { recursive: true });
      }
    }
    if (existsSync(join(target, TRIAL_FILE))) {
      addLines(join(target, SCORES_FILE), filesToLines(join(source, SCORES)));
    }
  }
}

/** The runs a run's reused trials ran in. */
function reusedRuns(runDir: string): string[] {
  return [
    ...new Set(
      trialSlots(runDir).flatMap((slot) => {
        const pointer = join(runDir, slot, REUSED_FILE);
        return existsSync(pointer)
          ? [(JSON.parse(readFileSync(pointer, "utf8")) as TrialRef).run]
          : [];
      }),
    ),
  ];
}

/** Writes a run's records into the records folder, with the runs it reuses, and the labels. */
export function writeRecords(store: string, records: string, id: string): void {
  const from = runDirOf(store, id);
  if (!existsSync(join(from, RUN_FILE))) return;
  for (const run of [...reusedRuns(from), id]) {
    if (existsSync(join(runDirOf(store, run), RUN_FILE))) {
      exportRun(runDirOf(store, run), join(records, "runs", run));
    }
  }
  writeLabels(store, records);
}

/** Each label of the store not yet in the records, as a file of its own. */
export function writeLabels(store: string, records: string): void {
  const dir = join(store, "labels");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
    linesToFiles(join(dir, name), join(records, "labels", name.replace(/\.jsonl$/, "")));
  }
}

/**
 * Brings the records folder into the store, and writes nothing in the records: a run the store
 * lacks is copied whole, as a fresh clone's are; for a run it has, the scores made elsewhere are
 * added to its own; labels the same.
 */
export function readRecords(store: string, records: string): void {
  const from = join(records, "runs");
  for (const id of runsOf(from)) {
    if (existsSync(join(from, id, RUN_FILE))) importRun(join(from, id), runDirOf(store, id));
  }
  const labels = join(records, "labels");
  if (!existsSync(labels)) return;
  for (const dataset of readdirSync(labels)) {
    addLines(labelsFileOf(store, dataset), filesToLines(join(labels, dataset)));
  }
}
