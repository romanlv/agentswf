import { join } from "node:path";
import { criteriaOf } from "../format/key";
import type { Agent, Key } from "../format/settings";
import { JUDGE_VERSION } from "../judge/version";
import { sha256 } from "./dataset";
import { canonical, type LabGrader } from "./grading";
import { besideName } from "./outcome";
import { graderWorkflow, type WorkflowGraderLab } from "./workflow-graders";

/** The criteria judge's workflow, which this checkout's own `awf` runs. */
const JUDGE_FILE = join(import.meta.dir, "../judge/criteria.workflow.ts");

const hasCriteria = (key: Key) => criteriaOf(key).length > 0;

/**
 * The criteria judge, a grader workflow the lab ships, named `criteria`: it applies to a case
 * whose key has `must` or `must-not`, its grades are kept against those sentences alone, and it
 * records the `judgeAgent` it judged with, so a change of agent judges every criterion again.
 */
export function criteriaJudge(
  lab: Pick<WorkflowGraderLab, "runner" | "runRoot" | "now">,
  agent: Agent,
  /** Graded beside the deciding judge, by `score --judge`: on demand, never in the verdict. */
  beside = false,
): LabGrader {
  const name = beside ? besideName(agent) : "criteria";
  const run = graderWorkflow(
    { ...lab, awf: async () => undefined },
    {
      name,
      file: JUDGE_FILE,
      readsFacts: true,
      onDemand: beside,
      timeout: "20m",
      argv: [
        "--harness",
        agent.harness,
        "--model",
        agent.model,
        ...(agent.voters ? ["--voters", String(agent.voters)] : []),
      ],
    },
  );
  return {
    ...run,
    version: JUDGE_VERSION,
    agent,
    ...(beside ? { beside: true } : {}),
    appliesTo: hasCriteria,
    keyOf: (info) => sha256(canonical(criteriaOf(info.key).map((c) => `${c.field}: ${c.text}`))),
    async grade(call) {
      // Its grade folder holds the criteria alone: no `expect`, no `key/`. Its voters work beside
      // it, so nothing there may be more than what they are shown anyway.
      const { keyDir: _, ...shown } = call.case;
      const key = {
        kind: call.case.key.kind,
        ...(call.case.key.must ? { must: call.case.key.must } : {}),
        ...(call.case.key["must-not"] ? { "must-not": call.case.key["must-not"] } : {}),
      };
      try {
        return { ...(await run.grade({ ...call, case: { ...shown, key } })), agent };
      } catch (error) {
        throw Object.assign(error as Error, { version: JUDGE_VERSION });
      }
    },
  };
}
