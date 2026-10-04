// awf run packages/lab/src/review/judge/judge.workflow.ts --cwd {checkout} -- \
//   [--panel codex/gpt-6-sol,claude/claude-sonnet-5] [--tiebreak codex/gpt-6-luna] \
//   --fixture {fixture dir} --findings {findings.json}
//
// The panel judge (story 008), retired as a built-in scorer by story 011: match first with nothing
// settled, so two judges from different model families label every finding, a third voting on
// their splits (`voting.ts`). Kept for scorers that name it; its records read as `panel@1.0`.
import { resolve } from "node:path";
import { defineExecutableWorkflow, type WorkflowInvocation } from "@agentswf/contract/workflow";
import { runtimeOf } from "../format/runtime";
import { SCORER_RESULT_FORMAT, type ScorerResult } from "../format/scoring";
import { describeProblems } from "../format/validate";
import { flagsOf, readJudgedCase } from "./case";
import { checkScorerResult } from "./check";
import { MATCH_DEFAULTS } from "./match.workflow";
import { type Voters, voteOnRest } from "./voting";

type Args = { fixture: string; findings: string } & Voters;

const executable = defineExecutableWorkflow<Args, ScorerResult>({
  definition: {
    meta: {
      name: "review-panel-judge",
      description:
        "Label a review's findings against a fixture's answer key with a panel of judges.",
      whenToUse: "Run by a scorer that names the panel; match first is awf-lab's own.",
    },
    async run(workflow, args) {
      const input = await readJudgedCase(args.fixture, args.findings);
      if (input.findings.length === 0) {
        return { format: SCORER_RESULT_FORMAT, labels: [], missed: "The review found nothing." };
      }
      const { labels, votes, missed } = await voteOnRest(workflow, input, new Map(), args);
      const judgement: ScorerResult = {
        format: SCORER_RESULT_FORMAT,
        labels: input.findings.map((_, index) => labels.get(index)!),
        missed,
        votes,
      };
      const checked = checkScorerResult(judgement, input.findings, input.key);
      if (!checked.ok) {
        throw new Error(describeProblems("the settled judgement", checked.problems));
      }
      return checked.value;
    },
  },
  prepare: parseArgs,
  present: (ending) => {
    if (ending.kind !== "completed") return undefined;
    const judgement = ending.value;
    return judgement.labels
      .map(
        (label) =>
          `${label.finding}: ${label.label === "hit" ? `hit ${label.issue}` : label.label}`,
      )
      .join("\n");
  },
});

/** Two judges from different model families, so a majority isn't one model agreeing with itself. */
const PANEL = "codex/gpt-6-sol,claude/claude-sonnet-5";
const TIEBREAK = "codex/gpt-6-luna";

function parseArgs(invocation: WorkflowInvocation): Args {
  const values = flagsOf(invocation.argv, ["fixture", "findings", "panel", "tiebreak"]);
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return resolve(invocation.cwd, value);
  };
  const panel = (values.get("panel") ?? PANEL).split(",").map((spec) => runtimeOf(spec.trim()));
  if (panel.length !== 2) throw new Error("--panel names two judges, harness/model,harness/model");
  return {
    fixture: required("fixture"),
    findings: required("findings"),
    voters: panel,
    tiebreak: runtimeOf(values.get("tiebreak") ?? TIEBREAK),
    turnMs: MATCH_DEFAULTS.turn * 60_000,
  };
}

export const panelJudge = executable.definition;
export default executable;
