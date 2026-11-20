import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GRADE_KIND, type Previous } from "../format/records";
import { GRADE_FILES, TRIAL_ENV } from "../format/trial-env";
import type { FactsInput, GradeInput } from "./grader";

/** What a grader workflow is given: a code grader's input, the parameters and earlier parts. */
export type GradeCase<R = unknown> = GradeInput<R> &
  Partial<FactsInput> & {
    /** The trial's parameters. */
    params: Record<string, string>;
    /**
     * This grader's parts from its newest grade of the trial, and the key digest they were graded
     * on, when that grade did not error and has this grader's `{major}.{minor}`: judge only what
     * the key's change touched. Absent otherwise.
     */
    previous?: Previous;
  };

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Reads the grade folder the lab names in `AWF_LAB_GRADE`: a grader workflow calls it in its
 * `run`, and returns a grade (`verdict`, `numbers`, `reasons`, `parts` or `notApplies`) as its
 * result. Typed as `R`, the workflow's result, as `observe`'s is.
 */
export function gradeCase<R = unknown>(): GradeCase<R> {
  const dir = process.env[TRIAL_ENV.grade];
  if (!dir) {
    throw new Error(
      `gradeCase() reads the grade folder awf-lab names in ${TRIAL_ENV.grade}: run this grader through awf-lab run or score`,
    );
  }
  const grade = readJson(join(dir, GRADE_FILES.grade)) as {
    kind?: unknown;
    case: string;
    scratch: string | null;
    params: Record<string, string>;
    readsFacts: boolean;
  };
  if (grade.kind !== GRADE_KIND) {
    throw new Error(
      `${join(dir, GRADE_FILES.grade)} is ${String(grade.kind)}, not ${GRADE_KIND}: this grader's @agentswf/lab is another version than the lab's`,
    );
  }
  const caseDir = join(dir, GRADE_FILES.case);
  const inputFile = join(caseDir, "input.json");
  const keyDir = join(dir, GRADE_FILES.keyDir);
  const previousFile = join(dir, GRADE_FILES.previous);
  const facts = grade.readsFacts
    ? (readJson(join(dir, GRADE_FILES.facts)) as FactsInput)
    : undefined;
  return {
    case: {
      name: grade.case,
      dir: caseDir,
      input: existsSync(inputFile) ? readJson(inputFile) : {},
      key: readJson(join(dir, GRADE_FILES.key)) as GradeInput["case"]["key"],
      ...(existsSync(keyDir) ? { keyDir } : {}),
    },
    result: readJson(join(dir, GRADE_FILES.result)) as R,
    scratch: grade.scratch,
    kept: join(dir, GRADE_FILES.kept),
    params: grade.params,
    ...(facts ? { facts: facts.facts, stages: facts.stages } : {}),
    ...(existsSync(previousFile) ? { previous: readJson(previousFile) as Previous } : {}),
  };
}
