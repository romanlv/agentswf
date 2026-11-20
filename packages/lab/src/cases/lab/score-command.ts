import { checkSchema, describeProblems } from "../../shared/validate";
import { SCORED_KIND, type Scored, ScoredSchema } from "../format/output";
import {
  budgetExit,
  type Context,
  checkoutFolder,
  chooseRun,
  confirmPlan,
  datasetGraders,
  envOf,
  externalsOf,
  loadDataset,
  tagged,
  tmpOf,
  withLock,
  workspaceOf,
} from "./command-context";
import { criteriaJudge } from "./criteria";
import { clearStale } from "./folders";
import type { LabGrader } from "./grading";
import { checkEnvFile } from "./inspect";
import { writeRecords } from "./record-copies";
import { Refusal } from "./refusal";
import { runReport } from "./run-report";
import { barsOf, criteriaCount } from "./runs";
import { describePlan, regradePlan, runScore, type ScoreDone } from "./score";
import { awfRunsOf, readTrials } from "./store";
import { usd } from "./text";

/**
 * Grades a kept run again, without running a trial: never `env.ts`, the workflow or `observe`.
 * Cheap graders first; a grader workflow is skipped again when the trial still fails a cheap one.
 */
export async function score(context: Context, names: readonly string[]): Promise<number> {
  const { options, environment, stderr } = context;
  const workspace = workspaceOf(context);
  const run = chooseRun(workspace, names, "score");
  const { info, cases } = loadDataset(workspace, run.dataset, "all");
  const now = environment.now ?? (() => new Date());
  const graders = await datasetGraders(
    context,
    workspace,
    info,
    checkoutFolder(context, workspace, () => checkEnvFile(info.dir)),
    now,
  );
  let chosen: LabGrader[];
  if (options.judges.length > 0) {
    if (options.grader) throw new Refusal("score takes --grader or --judge, not both");
    // Judges graded beside the one that decides: kept to compare, never in the verdict.
    chosen = options.judges.map((given) => {
      const [harness, ...model] = given.split("/");
      if (!harness || model.length === 0) {
        throw new Refusal(
          `--judge ${given}: give {harness}/{model}, such as claude/claude-sonnet-5-5`,
        );
      }
      const agent = {
        harness,
        model: model.join("/"),
        ...(options.voters ? { voters: options.voters } : {}),
      };
      return criteriaJudge(
        { runner: externalsOf(environment).runner, runRoot: awfRunsOf(workspace.store), now },
        agent,
        true,
      );
    });
  } else if (options.grader) {
    const one = graders.find((g) => g.name === options.grader);
    if (!one) {
      throw new Refusal(
        `no grader ${options.grader} in ${info.name}; its graders: ${graders.map((g) => g.name).join(", ") || "none"}`,
      );
    }
    chosen = [one];
  } else chosen = graders.filter((g) => !g.onDemand);
  const tmp = tmpOf(context);
  const trials = readTrials(workspace.store, run.id);
  const byCase = new Map(cases.map((c) => [c.name, c]));
  const plan = regradePlan({
    trials: options.tags
      ? trials.filter((t) => {
          const info = byCase.get(t.record.case);
          return info !== undefined && tagged(info, options.tags!);
        })
      : trials,
    store: workspace.store,
    info,
    cases,
    graders,
    tmp,
    only: {
      graders: chosen,
      expect: options.grader === undefined && options.judges.length === 0,
    },
  });
  const described = describePlan(plan, run.id);
  const planJson: Scored["plan"] = {
    run: run.id,
    trials: plan.items.length,
    grades: Object.fromEntries(plan.counts),
    maybe: Object.fromEntries(plan.maybe),
    ...(plan.estimate !== undefined ? { estimate: plan.estimate } : {}),
    ...(plan.upTo !== undefined ? { upTo: plan.upTo } : {}),
    unpriced: plan.unpriced,
    changed: plan.changed.map((t) => ({ case: t.record.case, trial: t.record.trial })),
  };
  const print = (scored: Scored) => {
    const checked = checkSchema(ScoredSchema, scored);
    if (!checked.ok) throw new Error(describeProblems("score --json", checked.problems));
    context.stdout(JSON.stringify(scored, null, 2));
  };
  if (options.dryRun) {
    if (options.json) print({ kind: SCORED_KIND, plan: planJson });
    else context.stdout(described);
    return 0;
  }
  let done: ScoreDone | undefined;
  if (plan.items.length > 0) {
    if (!(await confirmPlan(context, described, "grade them?"))) {
      stderr("declined; nothing graded");
      return 2;
    }
    done = await withLock(workspace, async () => {
      try {
        clearStale(tmp);
        return await runScore({
          plan,
          tmp,
          run: run.id,
          store: workspace.store,
          env: envOf(context),
          ...(options.budget !== undefined ? { budget: options.budget } : {}),
          now,
          progress: stderr,
        });
      } finally {
        if (workspace.records) writeRecords(workspace.store, workspace.records, run.id);
      }
    });
  } else stderr(described);
  const rendered = await runReport(context, workspace, {
    info,
    run,
    trials: readTrials(workspace.store, run.id),
    bars: barsOf(info, cases, graders),
    graders,
    criteria: criteriaCount(
      cases,
      run.asked.map((a) => a.case),
    ),
  });
  const exit = budgetExit(done?.stopped ?? false, rendered.exit);
  if (options.json) {
    print({
      kind: SCORED_KIND,
      plan: planJson,
      ...(done
        ? {
            done: {
              graded: Object.fromEntries(done.graded),
              errored: Object.fromEntries(done.errored),
              estimate: done.estimate,
              stopped: done.stopped,
            },
          }
        : {}),
      report: rendered.json(exit),
    });
    return exit;
  }
  const lines: string[] = [];
  if (done) {
    const counted = (map: Map<string, number>) =>
      [...map].map(([name, n]) => `${name} ×${n}`).join(", ");
    lines.push(
      [
        `graded again: ${counted(done.graded) || "nothing"}`,
        ...(done.errored.size > 0 ? [`errored: ${counted(done.errored)}`] : []),
        ...(done.estimate > 0 ? [`est. ${usd(done.estimate)}`] : []),
        ...(done.stopped
          ? [`stopped at the budget, ${usd(options.budget!)}: the rest is not graded`]
          : []),
      ].join(" · "),
      "",
    );
  }
  const text =
    done?.stopped && rendered.exit === 0
      ? rendered.text.replace(/exit 0: .*$/, "exit 3: score stopped at its budget")
      : rendered.text;
  context.stdout([...lines, text].join("\n"));
  return exit;
}
