import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Params, TrialRecord } from "../format/records";
import type { Dataset } from "../format/settings";
import { type CaseInfo, folderDigest } from "./dataset";
import { buildCase } from "./folders";
import { trialOutcome } from "./outcome";
import {
  REUSED_FILE,
  readRunRecord,
  readTrials,
  runIds,
  type StoredTrial,
  type TrialRef,
  trialDirOf,
  UnreadableRecord,
} from "./store";
import type { CaseWorkspace } from "./workspace";

// A stored trial is reused when nothing that shaped it changed: the code, the parameters, the
// built case, the trial settings of dataset.json, and the awf and lab it ran on. What only grades
// it (keys, graders, bars, tags) is left out, so editing them grades again and runs nothing.

export const REUSE_DAYS = 14;

const sha = () => createHash("sha256");

/**
 * The code a folder's trials run: every file git would hold there (tracked, or new and not
 * ignored), less what only grades or records: each dataset's cases, `dataset.json`, graders and
 * `capture.ts`, `awf-lab.json`, and the records folder. `env.ts` and what it imports stay in.
 * Undefined outside git: such a folder's trials are never reused.
 */
export function codeDigest(root: string, workspace: CaseWorkspace): string | undefined {
  const listed = Bun.spawnSync(
    ["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  if (listed.exitCode !== 0) return undefined;
  const evals = relative(workspace.root, workspace.evals);
  const records = workspace.records ? relative(workspace.root, workspace.records) : undefined;
  const datasets = existsSync(workspace.evals)
    ? readdirSync(workspace.evals).filter((name) =>
        existsSync(join(workspace.evals, name, "dataset.json")),
      )
    : [];
  const left = (path: string) => {
    if (path === join(evals, "awf-lab.json")) return true;
    if (records && (path === records || path.startsWith(`${records}/`))) return true;
    return datasets.some((name) => {
      const at = join(evals, name);
      return (
        path === join(at, "dataset.json") ||
        path === join(at, "graders.ts") ||
        path === join(at, "capture.ts") ||
        path.startsWith(`${join(at, "cases")}/`) ||
        path.startsWith(`${join(at, "graders")}/`)
      );
    });
  };
  const hash = sha();
  const paths = [...new Set(listed.stdout.toString().split("\0").filter(Boolean))].sort();
  for (const path of paths) {
    if (left(path)) continue;
    const file = join(root, path);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(file);
    } catch {
      continue; // deleted in the working tree: not part of the code
    }
    if (!stat.isFile()) continue;
    hash.update(`${path}\0${stat.size}\0`).update(readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
}

let labDigest: string | undefined;

/** The lab's side of a trial: the code a trial's process runs from `@agentswf/lab/cases`. */
export function labSideDigest(): string {
  if (labDigest) return labDigest;
  const hash = sha();
  for (const folder of ["../env", "../format"]) {
    const dir = join(import.meta.dir, folder);
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      hash
        .update(`${folder}/${name}\0`)
        .update(readFileSync(join(dir, name)))
        .update("\0");
    }
  }
  labDigest = hash.digest("hex");
  return labDigest;
}

/** The settings of `dataset.json` that shape a trial, not its grading. */
export function trialShaping(dataset: Dataset): object {
  return {
    sandbox: dataset.sandbox,
    agentReach: dataset.agentReach,
    timeout: dataset.timeout ?? null,
    setupTimeout: dataset.setupTimeout ?? null,
    realHosts: dataset.realHosts ?? [],
    keep: dataset.keep ?? [],
  };
}

export function reuseKey(parts: {
  code: string;
  params: Params;
  input: string;
  settings: object;
  awf: string;
}): string {
  const params = Object.fromEntries(Object.entries(parts.params).sort());
  return sha()
    .update(JSON.stringify({ ...parts, params, lab: labSideDigest() }))
    .digest("hex");
}

/** A stored trial that may stand in for a new one: it ran to an end the workflow owns. */
function reusable(record: TrialRecord, now: Date, days: number): boolean {
  if (!record.reuse || !record.runId || record.leaked || record.errored) return false;
  if (record.stopped !== undefined) return false;
  return now.getTime() - Date.parse(record.at) <= days * 86_400_000;
}

/**
 * The stored trials of a dataset each reuse key may take, newest first, one per workflow run (a
 * reused trial is a copy, and never counts twice).
 */
export function reusableTrials(
  store: string,
  dataset: string,
  now: Date,
  days: number,
): Map<string, StoredTrial[]> {
  const byKey = new Map<string, StoredTrial[]>();
  const seen = new Set<string>();
  for (const id of runIds(store).reverse()) {
    let trials: StoredTrial[];
    try {
      if (readRunRecord(store, id)?.dataset !== dataset) continue;
      trials = readTrials(store, id);
    } catch (error) {
      if (error instanceof UnreadableRecord) continue;
      throw error;
    }
    for (const trial of trials.sort((a, b) => b.record.at.localeCompare(a.record.at))) {
      const { record } = trial;
      if (!reusable(record, now, days) || seen.has(record.runId!)) continue;
      seen.add(record.runId!);
      // A trial the lab couldn't grade for its own reasons is run again rather than kept.
      if (trialOutcome(record, trial.scores).outcome === "errored") continue;
      byKey.set(record.reuse!, [...(byKey.get(record.reuse!) ?? []), trial]);
    }
  }
  return byKey;
}

/** Puts a stored trial in a run as that run's trial: a pointer to where it ran, never a copy. */
export function reuseTrial(
  store: string,
  run: string,
  from: StoredTrial,
  column: number,
  trial: number,
): void {
  const dir = trialDirOf(store, run, from.record.case, column, trial);
  mkdirSync(dir, { recursive: true });
  const ref: TrialRef = from.record.reused ?? {
    run: from.record.run,
    column: from.record.column,
    trial: from.record.trial,
  };
  writeFileSync(join(dir, REUSED_FILE), `${JSON.stringify(ref)}\n`);
}

/** Each case built once, as a trial would see it, for its digest. */
export function caseDigests(
  datasetDir: string,
  cases: readonly CaseInfo[],
  tmp: string,
): Map<string, string> {
  const digests = new Map<string, string>();
  const scratch = mkdtempSync(join(tmp, "awf-lab-reuse-"));
  try {
    for (const [i, info] of cases.entries()) {
      const built = join(scratch, String(i));
      mkdirSync(built);
      buildCase(datasetDir, info, built);
      digests.set(info.name, folderDigest(built));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return digests;
}
