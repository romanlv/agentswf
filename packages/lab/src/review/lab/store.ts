import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkWith,
  type PartialScore,
  PartialScoreSchema,
  readPartial,
  readScore,
  readTrial,
  type Score,
  ScoreSchema,
  type Trial,
} from "../format/records";
import { type Checked, describeProblems } from "../format/validate";
import { digestOf } from "./identity";
import type { ScoreOnFile, Stored } from "./plan";
import { keyOf, parseKey } from "./version";

/**
 * The records, in the workspace's results, written once and never edited:
 * `{results}/{dataset}/{variant}@{major}.{minor}/{case}/{trial-id}/findings.json`, and beside it
 * one `score.{scorer}@{major}.{minor}.k{revision}.{n}.json` per score and one
 * `partial.{scorer}@{major}.{minor}.k{revision}.{n}.json` per partial score. A record written
 * before versions has none in it; its folder or file name gives it one, `{major}.{minor}.0`.
 */

const TRIAL_FILE = "findings.json";
const SCORE_FILE = /^score\.(.+@\d+\.\d+)\.k\d+\.\d+\.json$/;
const PARTIAL_FILE = /^partial\.(.+@\d+\.\d+)\.k\d+\.\d+\.json$/;

/** An identity as stored, with the version its folder or file name gives a record without one. */
function versioned<I extends { version?: string }>(identity: I, key: string): I {
  return identity.version ? identity : { ...identity, version: `${parseKey(key)!.series}.0` };
}

function folders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function readRaw<T>(
  file: string,
  read: (value: unknown) => Checked<T>,
): Promise<{ value: T; raw: unknown }> {
  const raw = await Bun.file(file).json();
  const checked = read(raw);
  if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
  return { value: checked.value, raw };
}

async function readStored(dir: string, variantKey: string): Promise<Stored> {
  const { value: read } = await readRaw(join(dir, TRIAL_FILE), readTrial);
  const trial = { ...read, variant: versioned(read.variant, variantKey) };
  const scores: ScoreOnFile[] = [];
  const partials: PartialScore[] = [];
  for (const name of readdirSync(dir).sort()) {
    const score = SCORE_FILE.exec(name);
    const partial = PARTIAL_FILE.exec(name);
    if (score) {
      const { value, raw } = await readRaw(join(dir, name), readScore);
      scores.push({ ...value, scorer: versioned(value.scorer, score[1]!), digest: digestOf(raw) });
    } else if (partial) {
      const { value } = await readRaw(join(dir, name), readPartial);
      partials.push({ ...value, scorer: versioned(value.scorer, partial[1]!) });
    }
  }
  return { trial, scores, partials };
}

/** Every trial of a case under one variant key, `{name}@{major}.{minor}`, with its scores. */
export async function storedTrials(
  results: string,
  dataset: string,
  variantKey: string,
  caseId: string,
): Promise<Stored[]> {
  const base = join(results, dataset, variantKey, caseId);
  const stored: Stored[] = [];
  for (const id of folders(base)) {
    if (existsSync(join(base, id, TRIAL_FILE)))
      stored.push(await readStored(join(base, id), variantKey));
  }
  return stored;
}

/** A variant key's trials across cases: what its next trial is estimated from. */
export async function trialsOf(results: string, dataset: string, variantKey: string) {
  const trials: Trial[] = [];
  for (const caseId of folders(join(results, dataset, variantKey))) {
    for (const { trial } of await storedTrials(results, dataset, variantKey, caseId)) {
      trials.push(trial);
    }
  }
  return trials;
}

/**
 * Everything on file for a dataset: each variant key's trials and each scorer key's scores, with
 * the versions and content hashes their records came from.
 */
export async function inventory(results: string, dataset: string) {
  type Version = {
    versions: Set<string>;
    cases: Set<string>;
    at: string;
    /** The latest record's. */
    version: string;
    commit: string | null;
    dirty: boolean;
  };
  const variants = new Map<string, Version & { trials: number }>();
  const scorers = new Map<string, Version & { scores: number }>();
  const fresh = () => ({
    versions: new Set<string>(),
    cases: new Set<string>(),
    at: "",
    version: "",
    commit: null,
    dirty: false,
  });
  for (const key of folders(join(results, dataset)).filter((f) => parseKey(f))) {
    for (const caseId of folders(join(results, dataset, key))) {
      for (const stored of await storedTrials(results, dataset, key, caseId)) {
        const v = variants.get(key) ?? { ...fresh(), trials: 0 };
        v.versions.add(stored.trial.variant.version!);
        v.cases.add(caseId);
        v.trials += 1;
        if (stored.trial.at > v.at) {
          v.at = stored.trial.at;
          v.version = stored.trial.variant.version!;
          v.commit = stored.trial.variant.commit;
          v.dirty = stored.trial.variant.dirty;
        }
        variants.set(key, v);
        for (const score of stored.scores) {
          const s = scorers.get(keyOf(score.scorer)) ?? { ...fresh(), scores: 0 };
          s.versions.add(score.scorer.version!);
          s.cases.add(caseId);
          s.scores += 1;
          if (score.at > s.at) {
            s.at = score.at;
            s.version = score.scorer.version!;
            s.commit = score.scorer.commit;
            s.dirty = score.scorer.dirty;
          }
          scorers.set(keyOf(score.scorer), s);
        }
      }
    }
  }
  return { variants, scorers };
}

/** A scorer's scores in a dataset, whichever variant they scored. */
export async function scoresBy(results: string, dataset: string, scorerKey: string) {
  const scores: Score[] = [];
  if (!existsSync(join(results, dataset))) return scores;
  const glob = new Bun.Glob(`*/*/*/score.${scorerKey}.k*.json`);
  for await (const file of glob.scan({ cwd: join(results, dataset), absolute: true })) {
    scores.push((await readRaw(file, readScore)).value);
  }
  return scores;
}

/** Where a run keeps its files, by its id under the run root; null once it is gone. */
export async function runDirOf(runs: string, runId: string | undefined): Promise<string | null> {
  if (!runId || !existsSync(runs)) return null;
  for await (const dir of new Bun.Glob(`*/${runId}`).scan({ cwd: runs, onlyFiles: false })) {
    return join(runs, dir);
  }
  return null;
}

function writeOnce(file: string, value: unknown): void {
  // `wx` fails on an existing file: a record is never overwritten.
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

export function trialDir(results: string, trial: Trial): string {
  return join(results, trial.dataset, keyOf(trial.variant), trial.case.id, trial.id);
}

export function writeTrial(results: string, trial: Trial): string {
  const checked = readTrial(trial);
  if (!checked.ok) throw new Error(describeProblems(TRIAL_FILE, checked.problems));
  const dir = trialDir(results, trial);
  mkdirSync(dir, { recursive: true });
  writeOnce(join(dir, TRIAL_FILE), trial);
  return dir;
}

/** Writes a score beside its trial, numbered after the scorer's earlier ones on that key. */
export function writeScore(dir: string, score: Score): string {
  const checked = checkWith(ScoreSchema, score);
  if (!checked.ok) throw new Error(describeProblems("score", checked.problems));
  return writeNumbered(dir, "score", `${keyOf(score.scorer)}.k${score.key.revision}.`, score);
}

/** Writes a partial score beside its trial, numbered as a score is. */
export function writePartial(dir: string, partial: PartialScore): string {
  const checked = checkWith(PartialScoreSchema, partial);
  if (!checked.ok) throw new Error(describeProblems("partial", checked.problems));
  return writeNumbered(
    dir,
    "partial",
    `${keyOf(partial.scorer)}.k${partial.key.revision}.`,
    partial,
  );
}

/** `{kind}.{rest}{n}.json`, n after every earlier one. */
function writeNumbered(dir: string, kind: string, rest: string, record: unknown): string {
  const taken = readdirSync(dir)
    .filter((f) => f.startsWith(`${kind}.${rest}`))
    .map((f) => Number(f.slice(`${kind}.${rest}`.length, -".json".length)));
  const n = Math.max(0, ...taken.filter(Number.isInteger)) + 1;
  const file = join(dir, `${kind}.${rest}${n}.json`);
  writeOnce(file, record);
  return file;
}
