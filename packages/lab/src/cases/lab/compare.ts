import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "../../shared/compare";
import type { ComparedTrial } from "../env/compare";
import type { RunRecord } from "../format/records";
import { runHelper } from "./code-graders";
import { newestEntries, trialOutcome } from "./outcome";
import type { CaseBar } from "./runs";
import type { StoredTrial } from "./store";

/** What `compare` said of one column against the reference, or why it couldn't say. */
export type ColumnVerdict = { verdict: Verdict; version: string } | { error: string };

/** A stored trial as a comparison sees it; an errored or leaked one is left out, as missing. */
export function comparedTrial(
  trial: StoredTrial,
  deciders: ReadonlySet<string> | undefined,
): ComparedTrial | undefined {
  const { record, scores } = trial;
  const { outcome } = trialOutcome(record, scores, deciders);
  if (outcome === "errored" || outcome === "leaked") return undefined;
  const numbers: Record<string, number> = {};
  for (const entry of newestEntries(scores)) {
    if (entry.skipped || entry.errored) continue;
    if (deciders && !deciders.has(entry.grader)) continue;
    for (const [name, number] of Object.entries(entry.numbers ?? {})) {
      if ("value" in number) numbers[`${entry.grader}.${name}`] = number.value;
      else if (number.of > 0) numbers[`${entry.grader}.${name}`] = number.count / number.of;
    }
  }
  return {
    case: record.case,
    trial: record.trial,
    passed: outcome === "passed" ? true : outcome === "failed" ? false : null,
    workflowFailed: record.workflowError !== undefined || record.stopped !== undefined,
    numbers,
    cost: record.estimate ?? null,
    seconds: record.ms / 1000,
  };
}

/**
 * Each column but the reference, judged against it by the dataset's `compare` in `graders.ts`,
 * run in the helper process in your checkout. Undefined when the dataset says no `compare`.
 */
export async function compareColumns(args: {
  run: RunRecord;
  trials: readonly StoredTrial[];
  bars: ReadonlyMap<string, CaseBar>;
  datasetDir: string;
  root: string;
  tmp: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<ColumnVerdict[] | undefined> {
  const file = join(args.datasetDir, "graders.ts");
  if (args.run.columns.length < 2 || !existsSync(file)) return undefined;
  const of = (column: number) =>
    args.trials
      .filter((t) => t.record.column === column)
      .flatMap((t) => comparedTrial(t, args.bars.get(t.record.case)?.deciders) ?? []);
  const reference = of(0);
  const work = mkdtempSync(join(args.tmp, "awf-lab-compare-"));
  try {
    const verdicts: ColumnVerdict[] = [];
    for (let column = 1; column < args.run.columns.length; column++) {
      let answer: Record<string, unknown>;
      try {
        answer = await runHelper(
          {
            mode: "compare",
            file,
            input: { reference, column: of(column), planned: args.run.asked.length },
          },
          { root: args.root, work, env: args.env, timeoutMs: args.timeoutMs, name: "compare" },
        );
      } catch (error) {
        verdicts.push({ error: (error as Error).message });
        continue;
      }
      if (answer.none) return undefined;
      if (typeof answer.error === "string") verdicts.push({ error: answer.error });
      else verdicts.push({ verdict: answer.verdict as Verdict, version: String(answer.version) });
    }
    return verdicts;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
