// awf run packages/lab/src/review/judge/match.workflow.ts --cwd {checkout} -- \
//   [--sure 0.9] [--rest codex/gpt-6-sol,pi/openai-codex/gpt-5.6-terra] [--tiebreak codex/gpt-6-luna] \
//   [--sandbox srt] [--turn 6] [--settled {file}] --fixture {fixture dir} --findings {findings.json}
//
// Match first, the review scorer (story 011, decision 4). Jev matches each finding, text against
// text, to what the key already knows and to the earlier findings (`matching.ts`); voters with the
// code label only what it leaves (`voting.ts`). Every Jev answer, each option's probability, is in
// the run's `decisions/`, so a script can re-settle them at another cut without asking again.
//
//   --sure {p}                       the cut a match must reach to settle a finding (default 0.9);
//                                    1 settles nothing, so the voters label every finding: the panel
//   --rest none                      leave the rest `unsettled`: matching alone
//   --rest {runtime}                 one voter labels the rest
//   --rest {a},{b} [--tiebreak {c}]  two vote on the rest; the tiebreak takes their splits
//   --sandbox srt|docker|none        each voter in a private sandbox reading its checkout only
//   --settled {file}                 awf-lab's `score --only`: keep these labels, the voters label the rest
//   --turn {minutes}                 a turn's bound; past it, one more turn in a fresh session (default 6)
//
// Jev's known failure: it can match a new problem to the nearest known issue (p 0.97 seen), and it
// passes the right symptom with a false cause, which the question asks it not to.
import { resolve } from "node:path";
import {
  choice,
  defineExecutableWorkflow,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import { runtimeName, runtimeOf } from "../format/runtime";
import { type FindingLabel, SCORER_RESULT_FORMAT, type ScorerResult } from "../format/scoring";
import { describeProblems } from "../format/validate";
import { flagsOf, readJudgedCase } from "./case";
import { checkScorerResult } from "./check";
import {
  EARLIER_QUESTION,
  earlierOptions,
  KNOWN_QUESTION,
  knownOptions,
  settleMatches,
} from "./matching";
import { type Voters, voteOnRest } from "./voting";

/** Codex voters for now (decision 3): sol in codex, terra in pi, luna to break their ties. */
export const MATCH_DEFAULTS = {
  rest: "codex/gpt-6-sol,pi/openai-codex/gpt-5.6-terra",
  tiebreak: "codex/gpt-6-luna",
  sure: 0.9,
  sandbox: "srt",
  turn: 6,
} as const;

type Args = { fixture: string; findings: string; settled?: string; sure: number } & Voters;

const executable = defineExecutableWorkflow<Args, ScorerResult>({
  definition: {
    meta: {
      name: "review-match-judge",
      description:
        "Label a review's findings against a case's key: Jev matches what the key knows, voters with the code label the rest.",
      whenToUse: "Run by awf-lab to score a review run (story 011).",
    },
    async run(workflow, args) {
      const input = await readJudgedCase(args.fixture, args.findings);
      const { key, findings } = input;
      if (findings.length === 0) {
        return { format: SCORER_RESULT_FORMAT, labels: [], missed: "The review found nothing." };
      }
      // Given settled labels (`score --only`), the chosen findings go to the voters, not to Jev:
      // they are the ones worth a voter, and Jev's hits beside given ones could claim an issue twice.
      if (args.settled) {
        const given: FindingLabel[] = await Bun.file(args.settled).json();
        const settled = new Map(given.map((label) => [label.finding, label]));
        const { labels, votes, missed } = await voteOnRest(workflow, input, settled, args);
        return whole(labels, votes, missed, () => "not asked");
      }
      let settled = new Map<number, FindingLabel>();
      let left = findings.map((_, finding) => ({ finding, why: "not matched" }));
      if (args.sure < 1) {
        const known = knownOptions(key);
        const matched = await Promise.all(
          findings.map(async (finding, index) => {
            const { answers } = await workflow.decisions.decide({
              key: `match:${index}`,
              model: "jev",
              state: { finding: finding.text },
              questions: {
                known: choice(KNOWN_QUESTION, known),
                earlier: choice(EARLIER_QUESTION, earlierOptions(findings, index)),
              },
            });
            return { known: answers.known.probabilities, earlier: answers.earlier.probabilities };
          }),
        );
        ({ settled, left } = settleMatches(matched, key, args.sure));
        workflow.log(`Jev settled ${settled.size} of ${findings.length}; ${left.length} left`);
      }
      const { labels, votes, missed } = await voteOnRest(workflow, input, settled, args);
      return whole(
        labels,
        votes,
        missed,
        (index) => left.find((l) => l.finding === index)?.why ?? "",
      );

      /** Every finding labelled, one nobody labelled `unsettled` with why; checked. */
      function whole(
        labels: ReadonlyMap<number, FindingLabel>,
        votes: NonNullable<ScorerResult["votes"]>,
        missed: string,
        whyLeft: (index: number) => string,
      ): ScorerResult {
        const judgement: ScorerResult = {
          format: SCORER_RESULT_FORMAT,
          labels: findings.map(
            (_, index): FindingLabel =>
              labels.get(index) ?? {
                finding: index,
                label: "unsettled",
                why: `no match; ${whyLeft(index)}`,
                read: [],
              },
          ),
          missed,
          ...(votes.length > 0 ? { votes } : {}),
        };
        const checked = checkScorerResult(judgement, findings, key);
        if (!checked.ok) {
          throw new Error(describeProblems("the settled judgement", checked.problems));
        }
        return checked.value;
      }
    },
  },
  prepare: parseArgs,
  present: (judgement) =>
    judgement.labels
      .map(
        (label) =>
          `${label.finding}: ${label.label === "hit" ? `hit ${label.issue}` : label.label}`,
      )
      .join("\n"),
});

function parseArgs(invocation: WorkflowInvocation): Args {
  const values = flagsOf(invocation.argv, [
    "sure",
    "rest",
    "tiebreak",
    "sandbox",
    "turn",
    "fixture",
    "findings",
    "settled",
  ]);
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return resolve(invocation.cwd, value);
  };
  const turn = Number(values.get("turn") ?? MATCH_DEFAULTS.turn);
  if (!(turn > 0)) throw new Error(`--turn is minutes, not ${values.get("turn")}`);
  const sure = Number(values.get("sure") ?? MATCH_DEFAULTS.sure);
  if (!(sure > 0 && sure <= 1))
    throw new Error(`--sure is a probability, not ${values.get("sure")}`);
  const sandbox = values.get("sandbox") ?? MATCH_DEFAULTS.sandbox;
  if (sandbox !== "srt" && sandbox !== "docker" && sandbox !== "none") {
    throw new Error(`--sandbox is srt, docker or none, not ${sandbox}`);
  }
  const rest = values.get("rest") ?? MATCH_DEFAULTS.rest;
  const voters = rest === "none" ? [] : rest.split(",").map((spec) => runtimeOf(spec.trim()));
  if (voters.length > 2) throw new Error(`--rest names one or two voters, not ${voters.length}`);
  const tiebreak =
    values.get("tiebreak") ?? (values.has("rest") ? undefined : MATCH_DEFAULTS.tiebreak);
  if (tiebreak && voters.length !== 2) throw new Error("--tiebreak needs two voters in --rest");
  const names = voters.map(runtimeName);
  if (new Set(names).size < names.length) throw new Error(`--rest names ${names[0]} twice`);
  return {
    fixture: required("fixture"),
    findings: required("findings"),
    ...(values.has("settled") ? { settled: required("settled") } : {}),
    sure,
    turnMs: turn * 60_000,
    voters,
    ...(tiebreak ? { tiebreak: runtimeOf(tiebreak) } : {}),
    ...(sandbox === "none" ? {} : { sandbox }),
  };
}

export const matchJudge = executable.definition;
export default executable;
