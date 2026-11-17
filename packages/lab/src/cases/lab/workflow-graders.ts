import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AwfBin, Runner } from "../../shared/runner";
import { checkSchema, describeProblems } from "../../shared/validate";
import { GRADE_KIND, type GradeFile, GradeFileSchema, PreviousSchema } from "../format/records";
import { GRADE_FILES, TRIAL_ENV } from "../format/trial-env";
import { checkAnswer } from "./answer";
import type { DatasetInfo, GraderSpec } from "./dataset";
import type { GradeCall, LabGrader } from "./grading";
import { newRunId } from "./store";

type WorkflowSpec = Extract<GraderSpec, { kind: "workflow" }>;

/** Writes a grade folder: what `gradeCase()` reads. The key in it has no marker. */
export function writeGradeFolder(dir: string, call: GradeCall, readsFacts: boolean): void {
  mkdirSync(dir, { recursive: true });
  const file: GradeFile = {
    kind: GRADE_KIND,
    case: call.case.name,
    scratch: call.scratch,
    params: call.params,
    readsFacts,
  };
  const checked = checkSchema(GradeFileSchema, file);
  if (!checked.ok) throw new Error(describeProblems(GRADE_FILES.grade, checked.problems));
  writeFileSync(join(dir, GRADE_FILES.grade), JSON.stringify(file, null, 2));
  cpSync(call.case.dir, join(dir, GRADE_FILES.case), { recursive: true });
  writeFileSync(join(dir, GRADE_FILES.key), JSON.stringify(call.case.key, null, 2));
  if (call.case.keyDir)
    cpSync(call.case.keyDir, join(dir, GRADE_FILES.keyDir), { recursive: true });
  writeFileSync(join(dir, GRADE_FILES.result), JSON.stringify(call.result ?? null));
  if (readsFacts) {
    writeFileSync(
      join(dir, GRADE_FILES.facts),
      JSON.stringify({ facts: call.facts, stages: call.stages }),
    );
  }
  if (existsSync(call.kept)) cpSync(call.kept, join(dir, GRADE_FILES.kept), { recursive: true });
  else mkdirSync(join(dir, GRADE_FILES.kept));
  if (call.previous) {
    const previous = checkSchema(PreviousSchema, call.previous);
    if (!previous.ok) throw new Error(describeProblems(GRADE_FILES.previous, previous.problems));
    writeFileSync(join(dir, GRADE_FILES.previous), JSON.stringify(call.previous));
  }
}

export type WorkflowGraderLab = {
  dataset: DatasetInfo;
  /**
   * Your checkout's `awf`, which runs every grader workflow; never with the trials' preload. Asked
   * for when the first grade needs it.
   */
  awf: () => Promise<AwfBin>;
  runner: Runner;
  runRoot: string;
  now: () => Date;
};

/**
 * The dataset's grader workflows: each graded by its own `awf run`, in an empty working folder,
 * with `AWF_LAB_GRADE` naming a grade folder made beside it and deleted after.
 */
export function workflowGraders(lab: WorkflowGraderLab, specs: readonly GraderSpec[]): LabGrader[] {
  return specs
    .filter((spec): spec is WorkflowSpec => spec.kind === "workflow")
    .map((spec) => workflowGrader(lab, spec));
}

function workflowGrader(lab: WorkflowGraderLab, spec: WorkflowSpec): LabGrader {
  const timeout = spec.timeout ?? lab.dataset.dataset.timeout ?? "30m";
  return {
    name: spec.name,
    costly: true,
    ...(spec.onDemand ? { onDemand: true } : {}),
    async grade(call) {
      // Each its own, whatever the grader's name: `a/b` and `a_b` never share one.
      const dir = join(mkdtempSync(join(call.work, "grade-")), "grade");
      const cwd = join(dirname(dir), "cwd");
      mkdirSync(cwd);
      const fail = (reason: string, more: object = {}) => Object.assign(new Error(reason), more);
      try {
        writeGradeFolder(dir, call, spec.readsFacts);
        const { preload: _, ...awf } = await lab.awf();
        const ran = await lab.runner({
          workflow: spec.file,
          cwd,
          timeout,
          argv: [],
          runRoot: lab.runRoot,
          id: newRunId(lab.now()),
          awf,
          quiet: true,
          env: { ...call.env, [TRIAL_ENV.grade]: dir },
        });
        const run = ran.record;
        if (!run) {
          const last = ran.unread ?? ran.stderr.trim().split("\n").at(-1);
          throw fail(`grader ${spec.name}'s run printed no record${last ? `: ${last}` : ""}`);
        }
        const spent = {
          runId: run.runId,
          ...(run.accounting.totals.estimate !== undefined
            ? { estimate: run.accounting.totals.estimate }
            : {}),
        };
        if (run.outcome !== "completed") {
          throw fail(`grader ${spec.name}'s run ${run.outcome}: ${run.reason}`, spent);
        }
        let answer: ReturnType<typeof checkAnswer>;
        try {
          answer = checkAnswer(spec.name, run.value);
        } catch (error) {
          throw fail((error as Error).message, spent);
        }
        const models = run.accounting.byModel.map((m) => m.model);
        return {
          ...answer,
          ...spent,
          ...(models.length > 0 ? { models } : {}),
          ms: run.accounting.wallMs,
        };
      } finally {
        rmSync(dirname(dir), { recursive: true, force: true });
      }
    },
  };
}
