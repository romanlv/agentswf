import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type GraderEntry, SCORE_KIND } from "../format/records";
import { type CaseInfo, type DatasetInfo, folderDigest } from "./dataset";
import { buildCase, makeTrialFolders } from "./folders";
import {
  decidersOf,
  EXPECT_VERSION,
  expectDigestOf,
  failsIn,
  gradeTrial,
  keyFor,
  type LabGrader,
  previousFrom,
  staleBecause,
} from "./grading";
import { entryName, gradingSpend, newestEntries } from "./outcome";
import { median, usd } from "./report";
import { appendScore, inputDirOf, keepInput, type StoredTrial } from "./store";

/** One trial to grade again, and with what. */
export type ScoreItem = {
  trial: StoredTrial;
  info: CaseInfo;
  deciders: ReadonlySet<string>;
  expect: boolean;
  /** Cheap graders, then the costly ones that will run. */
  graders: LabGrader[];
  /** Costly graders skipped before, which run only if the cheap ones regraded now pass. */
  maybe: LabGrader[];
};

export type ScorePlan = {
  items: ScoreItem[];
  /** Trials whose case changed since they ran: graded again only by running them again. */
  changed: StoredTrial[];
  /** Grades per grader that will be made, and those that depend on the cheap graders. */
  counts: Map<string, number>;
  maybe: Map<string, number>;
  /** The costly graders' estimate, from their earlier grades; `upTo` with the maybes too. */
  estimate?: number;
  upTo?: number;
  /** A costly grader with no earlier grade to price it by. */
  unpriced: string[];
};

const add = (map: Map<string, number>, name: string) => map.set(name, (map.get(name) ?? 0) + 1);

/**
 * What `score` would grade again: on each trial graders run on (not leaked, errored, failed by
 * the workflow, or a draft's), each grader whose grade no longer stands (`staleBecause`); and a
 * costly grader skipped before, once the trial no longer fails a cheap one. A trial whose built
 * case no longer matches its `input` digest is left for a new run.
 */
export function planScore(args: {
  trials: readonly StoredTrial[];
  /** Where each built case is kept, for the graders to read. */
  store: string;
  datasetDir: string;
  cases: readonly CaseInfo[];
  /** The graders `score` may run: every deciding one, or the one `--grader` names. */
  graders: readonly LabGrader[];
  /** Whose grades decide, per case, from the current dataset and key. */
  decidersOf: (info: CaseInfo) => ReadonlySet<string>;
  /** Grade `expect` again where it is stale; false for `score --grader`. */
  expect: boolean;
  tmp: string;
}): ScorePlan {
  const byName = new Map(args.cases.map((c) => [c.name, c]));
  const items: ScoreItem[] = [];
  const changed: StoredTrial[] = [];
  const inputs = new Map<string, string>();
  const scratch = mkdtempSync(join(args.tmp, "awf-lab-score-plan-"));
  /** Each case built once, as a trial would see it, for its digest. */
  const inputOf = (info: CaseInfo) => {
    let digest = inputs.get(info.name);
    if (digest === undefined) {
      const built = join(scratch, String(inputs.size));
      mkdirSync(built);
      buildCase(args.datasetDir, info, built);
      digest = folderDigest(built);
      // A run read from committed records has no built case yet: this one is it, if unchanged.
      keepInput(args.store, digest, built);
      rmSync(built, { recursive: true, force: true });
      inputs.set(info.name, digest);
    }
    return digest;
  };
  try {
    for (const trial of args.trials) {
      const { record } = trial;
      const info = byName.get(record.case);
      if (!info || info.key.draft) continue;
      if (record.leaked || record.errored || record.workflowError || record.stopped !== undefined)
        continue;
      if (inputOf(info) !== record.input) {
        changed.push(trial);
        continue;
      }
      const deciders = args.decidersOf(info);
      const newest = new Map(newestEntries(trial.scores).map((e) => [entryName(e), e]));
      const expect =
        args.expect &&
        deciders.has("expect") &&
        staleBecause(newest.get("expect"), expectDigestOf(info.key), EXPECT_VERSION) !== undefined;
      const stale = (g: LabGrader) =>
        staleBecause(newest.get(g.name), keyFor(g, info), g.version, g.agent) !== undefined;
      const graders = args.graders.filter((g) => g.appliesTo?.(info.key) ?? true);
      const cheap = graders.filter((g) => !g.costly && stale(g));
      const regraded = new Set([...(expect ? ["expect"] : []), ...cheap.map((g) => g.name)]);
      const standing = [...newest.values()].filter((e) => !regraded.has(entryName(e)));
      const costly: LabGrader[] = [];
      const maybe: LabGrader[] = [];
      for (const g of graders.filter((g) => g.costly)) {
        const entry = newest.get(g.name);
        if (entry?.skipped) {
          // Skipped again while what stands fails the trial; known only after the cheap regrade.
          if (failsIn(standing, deciders)) continue;
          (regraded.size > 0 ? maybe : costly).push(g);
        } else if (stale(g)) {
          (regraded.size > 0 ? maybe : costly).push(g);
        }
      }
      if (expect || cheap.length > 0 || costly.length > 0 || maybe.length > 0) {
        items.push({ trial, info, deciders, expect, graders: [...cheap, ...costly], maybe });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const counts = new Map<string, number>();
  const maybeCounts = new Map<string, number>();
  for (const item of items) {
    if (item.expect) add(counts, "expect");
    for (const g of item.graders) add(counts, g.name);
    for (const g of item.maybe) add(maybeCounts, g.name);
  }
  let estimate: number | undefined;
  let upTo: number | undefined;
  const unpriced: string[] = [];
  for (const grader of args.graders.filter((g) => g.costly)) {
    const sure = counts.get(grader.name) ?? 0;
    const unsure = maybeCounts.get(grader.name) ?? 0;
    if (sure + unsure === 0) continue;
    const each = median(
      args.trials.flatMap((t) =>
        t.scores.flatMap((s) =>
          s.entries.flatMap((e) =>
            entryName(e) === grader.name && e.estimate !== undefined && !e.skipped
              ? [e.estimate]
              : [],
          ),
        ),
      ),
    );
    if (each === undefined) {
      unpriced.push(grader.name);
      continue;
    }
    estimate = (estimate ?? 0) + each * sure;
    upTo = (upTo ?? 0) + each * (sure + unsure);
  }
  return {
    items,
    changed,
    counts,
    maybe: maybeCounts,
    ...(estimate !== undefined ? { estimate } : {}),
    ...(upTo !== undefined && upTo !== estimate ? { upTo } : {}),
    unpriced,
  };
}

/**
 * What grading again plans with a dataset's graders: every one not marked onDemand and `expect`,
 * as a run's reused trials and a plain `score` grade them, unless `only` names the graders.
 */
export function regradePlan(args: {
  trials: readonly StoredTrial[];
  store: string;
  info: DatasetInfo;
  cases: readonly CaseInfo[];
  graders: readonly LabGrader[];
  tmp: string;
  only?: { graders: readonly LabGrader[]; expect: boolean };
}): ScorePlan {
  const { graders } = args;
  return planScore({
    trials: args.trials,
    store: args.store,
    datasetDir: args.info.dir,
    cases: args.cases,
    graders: args.only?.graders ?? graders.filter((g) => !g.onDemand),
    decidersOf: (c) => decidersOf(c.key, graders),
    expect: args.only?.expect ?? true,
    tmp: args.tmp,
  });
}

/** The plan in lines, for the operator. */
export function describePlan(plan: ScorePlan, run: string): string {
  const lines: string[] = [];
  if (plan.items.length === 0) lines.push(`nothing in run ${run} to grade again`);
  else {
    const graders = [
      ...[...plan.counts].map(([name, n]) => `${name} ×${n}`),
      ...[...plan.maybe].map(([name, n]) => `${name} ×${n} if the cheaper graders now pass`),
    ].join(", ");
    lines.push(
      `score run ${run}: ${plan.items.length} trial${plan.items.length === 1 ? "" : "s"} · ${graders}`,
    );
    const priced = [
      ...(plan.estimate !== undefined ? [`est. ${usd(plan.estimate)}`] : []),
      ...(plan.upTo !== undefined ? [`up to ${usd(plan.upTo)}`] : []),
    ];
    if (priced.length > 0) {
      lines.push(
        `from earlier grades: ${priced.join(", ")}${plan.unpriced.length > 0 ? `; ${plan.unpriced.join(", ")} unpriced` : ""}`,
      );
    } else if (plan.unpriced.length > 0) {
      lines.push(`${plan.unpriced.join(", ")}: no earlier grade to price by`);
    }
  }
  if (plan.changed.length > 0) {
    const names = [...new Set(plan.changed.map((t) => t.record.case))];
    lines.push(
      `${plan.changed.length} trial${plan.changed.length === 1 ? "" : "s"} left: the case changed since it ran; run it again: awf-lab run --cases ${names.join(",")}`,
    );
  }
  return lines.join("\n");
}

export type ScoreDone = {
  /** Grades written, by grader. */
  graded: Map<string, number>;
  /** Grades that errored, by grader. */
  errored: Map<string, number>;
  estimate: number;
  /** Stopped at the budget before a costly grader. */
  stopped: boolean;
};

/** Grades each planned trial again and appends one score record per trial graded. */
export async function runScore(args: {
  plan: ScorePlan;
  tmp: string;
  run: string;
  store: string;
  env: Record<string, string>;
  budget?: number;
  now: () => Date;
  progress?: (line: string) => void;
}): Promise<ScoreDone> {
  const graded = new Map<string, number>();
  const errored = new Map<string, number>();
  let spent = 0;
  let stopped = false;
  const cost = (entries: readonly GraderEntry[]) => gradingSpend([{ entries }]);
  for (const item of args.plan.items) {
    const { trial, info } = item;
    const newest = new Map(newestEntries(trial.scores).map((e) => [entryName(e), e]));
    const graders = [...item.graders, ...item.maybe];
    const regrading = new Set([...(item.expect ? ["expect"] : []), ...graders.map((g) => g.name)]);
    const standing = [...newest.values()].filter((e) => !regrading.has(entryName(e)));
    const byName = new Map(graders.map((g) => [g.name, g]));
    // Made as a trial's folders are, so a later run sweeps them if this process dies.
    const work = makeTrialFolders(args.tmp, args.run).parent;
    try {
      const result = await gradeTrial({
        info,
        facts: trial.record.facts ?? {},
        stages: trial.record.stages ?? {},
        result: trial.record.result ?? null,
        caseDir: inputDirOf(args.store, trial.record.input),
        scratch: null,
        kept: join(trial.dir, "kept"),
        work,
        env: args.env,
        params: trial.record.params,
        expect: item.expect,
        graders,
        deciders: item.deciders,
        standing,
        previousOf: (name) =>
          previousFrom(newest.get(name), byName.get(name)?.version, byName.get(name)?.agent),
        mayContinue: (made) => args.budget === undefined || spent + cost(made) < args.budget,
      });
      const entries: GraderEntry[] =
        "errored" in result
          ? [
              {
                grader: "expect",
                version: EXPECT_VERSION,
                key: expectDigestOf(info.key),
                reasons: [],
                errored: {
                  reason: `${result.errored.code ? `${result.errored.code}: ` : ""}${result.errored.reason}`,
                },
              },
            ]
          : // A grader skipped again over a skip says nothing new.
            result.entries.filter((e) => !(e.skipped && newest.get(entryName(e))?.skipped));
      if (entries.length > 0) {
        appendScore(trial.dir, { kind: SCORE_KIND, at: args.now().toISOString(), entries });
      }
      for (const entry of entries) {
        if (entry.skipped) continue;
        add(entry.errored ? errored : graded, entryName(entry));
      }
      spent += cost(entries);
      const said = entries.map(
        (e) =>
          `${entryName(e)} ${e.errored ? `errored: ${e.errored.reason}` : e.skipped ? "skipped" : (e.verdict ?? e.notApplies ?? "graded")}`,
      );
      args.progress?.(
        `  ${trial.record.case} ${trial.record.trial}: ${said.join(", ") || "nothing new"}`,
      );
      if ("stopped" in result && result.stopped) {
        stopped = true;
        break;
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return { graded, errored, estimate: spent, stopped };
}
