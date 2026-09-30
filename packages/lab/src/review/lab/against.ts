import type { ScorerSettings, VariantSettings } from "../format/variant";
import {
  type CaseInfo,
  executePlan,
  type Lab,
  type Outcomes,
  type Planned,
  planRun,
  type Subject,
  statesOf,
} from "./execute";
import { buildReport, type ReportComparison, type ReportSubject } from "./report";
import type { Workspace } from "./workspace";

/** A variant's rows as `report` reads them, over the given cases. */
export async function reportSubject(
  workspace: Workspace,
  dataset: string,
  variant: Subject<VariantSettings>,
  cases: readonly CaseInfo[],
  entries: readonly { id: string; at: string }[],
): Promise<ReportSubject> {
  const states = await statesOf(workspace, dataset, variant.key, cases);
  return {
    name: variant.name,
    sandbox: workspace.sandbox,
    label: variant.label,
    version: variant.version,
    key: variant.key,
    commit: variant.commit,
    ...(variant.defined?.tunedOn ? { tunedOn: variant.defined.tunedOn } : {}),
    rows: cases.map((info, index) => ({
      case: info.id,
      digest: info.digest,
      key: info.key,
      at: entries.find((e) => e.id === info.id)?.at ?? info.fixture.request.asOf,
      stored: states[index]!.stored,
    })),
  };
}

export type Against = {
  dataset: string;
  trials: number;
  challenger: Subject<VariantSettings>;
  baseline: Subject<VariantSettings>;
  scorer: Subject<ScorerSettings>;
  /** The cases to run, the first n of the dataset's seeded order. */
  cases: readonly CaseInfo[];
  entries: readonly { id: string; at: string }[];
  comparison: ReportComparison;
  budget?: number;
  jobs?: number;
};

/**
 * Where a run against a baseline stands over the selected cases, as `report` would say: the verdict
 * over the longest start of the seeded order both have whole, how long that start is, and why the
 * first case past it isn't whole.
 */
async function standing(lab: Lab, options: Against) {
  const { workspace } = lab;
  const subjects: ReportSubject[] = [];
  for (const variant of [options.challenger, options.baseline]) {
    subjects.push(
      await reportSubject(workspace, options.dataset, variant, options.cases, options.entries),
    );
  }
  const build = (of: typeof subjects, comparison?: ReportComparison) =>
    buildReport({
      dataset: options.dataset,
      trials: options.trials,
      subjects: of,
      scorers: [
        { name: options.scorer.label, version: options.scorer.version, key: options.scorer.key },
      ],
      baseline: options.baseline.label,
      ...(comparison ? { comparison } : {}),
    });
  const document = build(subjects, options.comparison);
  const counted = new Set(document.comparison?.cases ?? []);
  let whole = 0;
  while (whole < options.cases.length && counted.has(options.cases[whole]!.id)) whole += 1;
  const next = options.cases[whole]?.id;
  // Each variant alone, so one that counts no case still says why.
  const why = subjects.flatMap((subject) => {
    const gap = build([subject]).columns[0]!.missing.find((g) => g.id === next);
    return gap ? [`${subject.label}: ${gap.why}`] : [];
  });
  return { verdict: document.comparison?.against[0]?.verdict, whole, next, why };
}

/**
 * Runs a challenger and its baseline case by case, in the dataset's seeded order: each case's
 * missing trials of both, then their scores, then the comparison over the cases both have whole,
 * as `report` gives it. Cases already whole are not walked again, so `run` and `report` agree on
 * the verdict. It stops when the comparison says to stop, before spending anything if the stored
 * records already decide; when a case can't be made whole (a trial that couldn't run, a score
 * that failed), so later cases would count towards no look; or at the budget, shared by every
 * case. `--jobs` runs one case's steps at once, never two cases, so a stop never leaves later
 * cases half run.
 */
export async function runAgainst(lab: Lab, options: Against) {
  const variants = [options.challenger, options.baseline];
  const outcomes: Outcomes = { trials: new Map(), scores: new Map(), errors: new Map() };
  const steps = new Map(variants.map((v) => [v.key, [] as Planned["variants"][number]["steps"]]));
  let planned: Planned | undefined;
  let listPrice = 0;
  let exitCode: 0 | 1 | 3 = 0;
  let now = await standing(lab, options);
  if (now.verdict?.stop) {
    lab.log(`already decided by the records: ${now.verdict.verdict}, ${now.verdict.reason}`);
  }
  for (const info of options.cases.slice(now.whole)) {
    if (now.verdict?.stop) break;
    const one = await planRun(lab, {
      command: "run",
      trials: options.trials,
      dataset: options.dataset,
      variants: variants.map((variant) => ({
        variant,
        chosen: new Map([
          [info.id, new Map(Array.from({ length: options.trials }, (_, i) => [i + 1, {}]))],
        ]),
      })),
      scorer: options.scorer,
      cases: [info],
    });
    planned ??= one;
    for (const plan of one.variants) steps.get(plan.variant.key)!.push(...plan.steps);
    const result = await executePlan(lab, {
      dataset: options.dataset,
      scorer: options.scorer,
      cases: [info],
      planned: one,
      spent: listPrice,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    });
    listPrice = result.listPrice;
    for (const kind of ["trials", "scores", "errors"] as const) {
      for (const [id, value] of result.outcomes[kind]) {
        (outcomes[kind] as Map<string, unknown>).set(id, value);
      }
    }
    if (result.exitCode === 3) {
      exitCode = 3;
      break;
    }
    if (result.exitCode === 1) exitCode = 1;
    const before = now.whole;
    now = await standing(lab, options);
    if (now.whole <= before) {
      lab.log(`${info.id} isn't whole, so no later case would count: ${now.why.join("; ")}`);
      exitCode = 1;
      break;
    }
    if (now.verdict) lab.log(`${info.id}: ${now.verdict.verdict}, ${now.verdict.reason}`);
  }
  const merged: Planned | undefined = planned && {
    ...planned,
    variants: planned.variants.map((v) => ({ ...v, steps: steps.get(v.variant.key)! })),
  };
  return {
    exitCode,
    listPrice,
    verdict: now.verdict,
    whole: now.whole,
    planned: merged,
    outcomes,
  };
}
