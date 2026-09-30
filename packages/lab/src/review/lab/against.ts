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

/** Where a run against a baseline stands: the verdict over the cases both have whole, and why a case isn't. */
async function standing(lab: Lab, options: Against, through: number) {
  const { workspace } = lab;
  const cases = options.cases.slice(0, through);
  const subjects = [];
  for (const variant of [options.challenger, options.baseline]) {
    subjects.push(await reportSubject(workspace, options.dataset, variant, cases, options.entries));
  }
  const document = buildReport({
    dataset: options.dataset,
    trials: options.trials,
    subjects,
    scorers: [
      { name: options.scorer.label, version: options.scorer.version, key: options.scorer.key },
    ],
    baseline: options.baseline.label,
    comparison: options.comparison,
  });
  const verdict = document.comparison?.against[0]?.verdict;
  const missing = new Map(
    document.columns.flatMap((column) => column.missing.map((gap) => [gap.id, gap.why] as const)),
  );
  return { verdict, whole: document.comparison?.cases.length ?? 0, missing };
}

/**
 * Runs a challenger and its baseline case by case, in the dataset's seeded order: each case's
 * missing trials of both, then their scores, then the comparison over the cases both have whole.
 * It stops when the comparison says to stop, before spending anything if the stored records
 * already decide; when a case can't be made whole (a trial that couldn't run, a score that
 * failed), so later cases would count towards no look; or at the budget. `--jobs` runs one case's
 * steps at once, never two cases, so a stop never leaves later cases half run.
 */
export async function runAgainst(lab: Lab, options: Against) {
  const variants = [options.challenger, options.baseline];
  const outcomes: Outcomes = { trials: new Map(), scores: new Map(), errors: new Map() };
  const steps = new Map(variants.map((v) => [v.key, [] as Planned["variants"][number]["steps"]]));
  let planned: Planned | undefined;
  let listPrice = 0;
  let exitCode: 0 | 1 | 3 = 0;
  let ran = 0;
  let walked = 0;
  let { verdict } = await standing(lab, options, options.cases.length);
  const log = (text: string) => lab.log(text);
  if (verdict?.stop) {
    log(`already decided by the records: ${verdict.verdict}, ${verdict.reason}`);
  } else {
    for (const [index, info] of options.cases.entries()) {
      walked = index + 1;
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
      const spends = one.variants.some((v) =>
        v.steps.some(
          (s) => s.trial.do === "run" || s.score.do === "run" || s.score.do === "record",
        ),
      );
      if (spends) {
        ran += 1;
        const result = await executePlan(lab, {
          dataset: options.dataset,
          scorer: options.scorer,
          cases: [info],
          planned: one,
          ...(options.budget === undefined ? {} : { budget: options.budget - listPrice }),
          ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
        });
        listPrice += result.listPrice;
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
      }
      const now = await standing(lab, options, index + 1);
      verdict = now.verdict;
      if (now.whole < index + 1) {
        const why = [...now.missing].map(([id, why]) => `${id} ${why}`).join("; ");
        log(`${info.id} isn't whole, so no later case would count: ${why}`);
        exitCode = 1;
        break;
      }
      if (verdict) log(`${info.id}: ${verdict.verdict}, ${verdict.reason}`);
      if (verdict?.stop) break;
    }
  }
  const merged: Planned | undefined = planned && {
    ...planned,
    variants: planned.variants.map((v) => ({ ...v, steps: steps.get(v.variant.key)! })),
  };
  return { exitCode, listPrice, verdict, ran, walked, planned: merged, outcomes };
}
