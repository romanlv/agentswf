import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScorerSettings, VariantSettings } from "../../format/variant";
import { type CaseInfo, type Subject, statesOf } from "../execute";
import { currentTrials, passingScore } from "../plan";
import { caseMetrics } from "../report";
import type { Workspace } from "../workspace";
import type { Try } from "./format";

export type BundleInput = {
  workspace: Workspace;
  dataset: string;
  incumbent: Subject<VariantSettings>;
  /** The incumbent's workflow file, as the proposer reads it. */
  source: string;
  program: string;
  scorer: Subject<ScorerSettings>;
  /** Tuning cases only: the holdout never reaches a bundle. */
  cases: readonly CaseInfo[];
  trials: number;
  history: readonly Try[];
  rules: Record<string, unknown>;
};

type Tally = { issues: number; hits: number };

/**
 * The proposer's folder: the program, the incumbent's source, its feedback on every scored trial of
 * the tuning cases, the history of tries and the rules. Returns how many trials it holds; with none
 * there is nothing to learn from yet.
 */
export async function writeBundle(dir: string, input: BundleInput): Promise<number> {
  mkdirSync(dir, { recursive: true });
  copyFileSync(input.program, join(dir, "program.md"));
  copyFileSync(input.source, join(dir, "incumbent.ts"));
  const states = await statesOf(input.workspace, input.dataset, input.incumbent.key, input.cases);
  const byCategory: Record<string, Tally> = {};
  const bySeverity: Record<string, Tally> = {};
  let scored = 0;
  const cases = states.flatMap((state, index) => {
    const info = input.cases[index]!;
    const trials = currentTrials(state)
      .slice(0, input.trials)
      .flatMap((stored, n) => {
        const score = passingScore(stored, input.scorer.key, info.key.revision);
        if (score?.result.status !== "scored") return [];
        scored += 1;
        const { labels, missed } = score.result.judgement;
        const hit = new Set(labels.flatMap((l) => (l.label === "hit" ? [l.issue] : [])));
        for (const issue of info.key.issues) {
          for (const [tally, by] of [
            [byCategory, issue.category],
            [bySeverity, issue.severity],
          ] as const) {
            tally[by] ??= { issues: 0, hits: 0 };
            tally[by].issues += 1;
            if (hit.has(issue.id)) tally[by].hits += 1;
          }
        }
        const m = caseMetrics(stored.trial, score, info.key);
        return [
          {
            trial: n + 1,
            outcome: stored.trial.failure ? `failed: ${stored.trial.failure}` : "scored",
            weightedRecall: m.weightedRecall,
            precision: m.precision,
            wrong: m.wrong,
            findings: stored.trial.findings.length,
            labels: Object.fromEntries(
              ["hit", "new", "wrong", "noise", "duplicate"].map((l) => [
                l,
                labels.filter((x) => x.label === l).length,
              ]),
            ),
            hit: [...hit],
            missed,
            seconds: Math.round(stored.trial.run.ms / 1000),
            usd: stored.trial.run.estimate ?? null,
          },
        ];
      });
    if (trials.length === 0) return [];
    return [
      {
        case: info.id,
        issues: info.key.issues.map((issue) => ({
          id: issue.id,
          severity: issue.severity,
          category: issue.category,
          visibleIn: issue.visibleIn,
        })),
        trials,
      },
    ];
  });
  const rate = (tally: Record<string, Tally>) =>
    Object.fromEntries(
      Object.entries(tally).map(([k, t]) => [k, { ...t, rate: t.hits / t.issues }]),
    );
  const feedback = {
    incumbent: input.incumbent.key,
    summary: { trials: scored, byCategory: rate(byCategory), bySeverity: rate(bySeverity) },
    cases,
  };
  writeFileSync(join(dir, "feedback.json"), `${JSON.stringify(feedback, null, 2)}\n`);
  const history = input.history.map((t) => ({
    n: t.n,
    parent: t.parent,
    candidate: t.candidate,
    ...(t.hypothesis ?? {}),
    decision: t.decision,
    why: t.why,
  }));
  writeFileSync(join(dir, "history.json"), `${JSON.stringify(history, null, 2)}\n`);
  writeFileSync(join(dir, "rules.json"), `${JSON.stringify(input.rules, null, 2)}\n`);
  return scored;
}
