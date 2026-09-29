import type { AnswerKey, Fixture } from "../format/format";
import { SEVERITY_RUBRIC } from "../format/grading";
import type { FindingLabel, ReviewFinding } from "../format/scoring";
import type { Problem } from "../format/validate";

/** What a judge is shown of the key: everything a finding could match, and nothing about sources. */
function keyView(key: AnswerKey) {
  return {
    issues: key.issues.map(({ id, mechanism, severity, category, scope, locations }) => ({
      id,
      mechanism,
      severity,
      category,
      scope,
      locations,
    })),
    refuted: key.refuted.map(({ id, claim, why }) => ({ id, claim, why })),
    excluded: key.excluded.flatMap((exclusion, index) =>
      exclusion.reason === "unconfirmed" ? [{ index, claim: exclusion.claim }] : [],
    ),
  };
}

const LABEL_RULES = `Give every finding exactly one label:

- \`hit\`: it describes a known issue's mechanism. Name the issue in \`issue\`. Location is evidence, not a gate: a finding elsewhere that gives the mechanism is a hit, and one on the right lines that says something else is not. The right symptom with a false cause is not a hit: it is \`wrong\`, with \`symptomOf\` naming the issue, and a later finding with the real mechanism is the hit. Each issue is hit at most once: the first finding that gives its mechanism hits it; a later finding on the same issue is a \`duplicate\`.
- \`new\`: a real problem in this code that the key does not have. Absence from the key is not evidence that it is false. Give its \`severity\` by the rubric below, its \`category\`, its \`scope\` (\`change\` if this MR caused it or made it worse, \`context\` if it was already there), and its \`mechanism\`: what goes wrong, when, and what it causes, never the fix.
- \`wrong\`: a concrete claim the code refutes, however plausible it sounds. \`refutes\` names the code fact that shows it false. When it repeats one of the key's refuted claims, name it in \`repeats\`.
- \`noise\`: no concrete claim at all: vague, off-topic, restating the code, or a matter of preference. A concrete claim that is false is \`wrong\`, not noise.
- \`duplicate\`: the same point as an earlier finding, whatever that finding's label; \`of\` is the earlier finding's number. A false claim made twice is a duplicate of the first.
- \`unsettled\`: it repeats one of the key's unconfirmed claims, which count neither way; \`excluded\` is that claim's index.

Before you label a finding \`new\`, \`wrong\` or \`noise\`, open the code it points at and read it; list the lines you read in \`read\` as \`{path, start, end}\`, paths relative to the repository root. Give \`read\` for the other labels too when you read code for them. \`why\` says in a sentence why the label fits.`;

export function judgePrompt(options: {
  fixture: Fixture;
  request: string;
  key: AnswerKey;
  findings: readonly ReviewFinding[];
}): string {
  const { fixture, request, key, findings } = options;
  return `You are judging a code review against an answer key.

A reviewer reviewed a merge request and reported the findings below. The answer key lists the real problems known in this code, claims known to be wrong, and claims nobody could settle. Your job is to label each finding against the key and the code. You are judged on being right about the code.

## The code

The current directory is a git repository at the code as it was reviewed: branch \`review\`, head ${fixture.snapshot.head}. The change under review is \`git diff ${fixture.snapshot.base} review\`. Don't change anything in it.

## The request the reviewer had

${request.trim()}

## The answer key

${JSON.stringify(keyView(key), null, 2)}

## The findings, numbered from 0

${JSON.stringify(
  findings.map((finding, index) => ({ finding: index, ...finding })),
  null,
  2,
)}

## Labels

${LABEL_RULES}

## Severity, for a new finding

${SEVERITY_RUBRIC}

Answer with \`labels\`, one per finding in order (\`finding\` is its number), and \`missed\`: which known issues the review missed, and in a sentence or two what it would have had to look at to find them.`;
}

/** The tiebreak sees the whole review and the settled labels, and answers only the split findings. */
export function tiebreakPrompt(
  options: Parameters<typeof judgePrompt>[0] & {
    asked: readonly number[];
    settled: readonly FindingLabel[];
  },
): string {
  const claimed = options.settled.flatMap((label) =>
    label.label === "hit" && !options.asked.includes(label.finding)
      ? [`${label.issue} by finding ${label.finding}`]
      : [],
  );
  return `${judgePrompt(options)}

## What you are asked

Two other judges labelled every finding and agree on all but findings ${options.asked.join(", ")}. Label only those, in order: your answer's \`labels\` has exactly one label for each of them and none for the others. Known issues already hit by findings they agree on: ${claimed.length > 0 ? claimed.join("; ") : "none"}. Such an issue can't be hit again: a split finding that gives its mechanism is a duplicate of the finding that hit it when that one comes first, and otherwise takes whichever other label fits it. Judge from the code yourself; you are not told what the others said. \`missed\` can be empty.`;
}

export function retryPrompt(problems: readonly Problem[]): string {
  return [
    "Your answer was checked and has these problems:",
    ...problems.map((p) => `- ${p.path}: ${p.message}`),
    "",
    "Fix them and answer again with the whole answer.",
  ].join("\n");
}

export const NO_ANSWER = "You didn't answer. Label the findings as asked and answer.";
