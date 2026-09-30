import type { AnswerKey } from "../format/format";
import type { FindingLabel, ReviewFinding, ScorerResult } from "../format/scoring";
import { type Checked, checkScorerResultShape, type Problem } from "../format/validate";

/**
 * A judgement is checked against the findings it labels and the key it labels them by, whichever
 * judge wrote it: the panel hands a failing answer back to its agent, and `awf-lab` records a
 * failing judgement as a failed judging, never as labels. Each vote is held to the same rules, a
 * tiebreak's over the findings it was asked about.
 */
export function checkScorerResult(
  value: unknown,
  findings: readonly ReviewFinding[],
  key: AnswerKey,
): Checked<ScorerResult> {
  const shaped = checkScorerResultShape(value);
  if (!shaped.ok) return shaped;
  const { labels, votes = [] } = shaped.value;
  const problems = labelProblems(labels, findings, key);
  votes.forEach((vote, index) => {
    const asked = vote.role === "panel" ? undefined : vote.labels.map((label) => label.finding);
    problems.push(
      ...labelProblems(vote.labels, findings, key, { asked, voter: true }).map((p) => ({
        path: `/votes/${index}${p.path}`,
        message: p.message,
      })),
    );
  });
  return problems.length === 0 ? shaped : { ok: false, problems };
}

export type LabelOptions = {
  /** The findings labelled, in order; all of them by default. */
  asked?: readonly number[];
  /** Issues other findings already hit, by the finding that hit each. */
  claimed?: ReadonlyMap<string, number>;
  /** One voter's labels: a bare `unsettled` is the panel's word for a split, not a voter's. */
  voter?: boolean;
  /** A voter's own answer, which reads the code before it calls a finding noise, too. */
  read?: boolean;
};

/**
 * Every finding asked about labelled once, in order; ids that exist; no known issue claimed twice;
 * the code read before a finding is called new or wrong, and by a voter, noise; a duplicate of an earlier
 * finding; an unsettled finding naming an `unconfirmed` exclusion, which a voter must name.
 */
export function labelProblems(
  labels: readonly FindingLabel[],
  findings: readonly ReviewFinding[],
  key: AnswerKey,
  options: LabelOptions = {},
): Problem[] {
  const asked = options.asked ?? findings.map((_, index) => index);
  const problems: Problem[] = [];
  const add = (index: number, message: string) =>
    problems.push({ path: `/labels/${index}`, message });
  if (labels.length !== asked.length) {
    problems.push({
      path: "/labels",
      message: `${labels.length} labels for ${asked.length} findings; label every finding once`,
    });
  }
  const issues = new Set(key.issues.map((issue) => issue.id));
  const refuted = new Set(key.refuted.map((claim) => claim.id));
  const claimed = new Map(options.claimed);
  let previous = -1;
  labels.forEach((label, index) => {
    const expected = asked[index];
    if (
      label.finding !== expected ||
      label.finding <= previous ||
      label.finding >= findings.length
    ) {
      add(index, `labels finding ${label.finding}; the labels go one per finding, in order`);
    }
    previous = label.finding;
    for (const read of label.read) {
      if (read.end < read.start) add(index, `read ${read.path} ends before it starts`);
    }
    // Whether a finding is vague is a matter of its text, so Jev may settle noise unread; a voter,
    // asked to read before it labels, still must.
    const needsRead =
      label.label === "new" || label.label === "wrong" || (label.label === "noise" && options.read);
    if (needsRead && label.read.length === 0) {
      add(index, `a finding labelled ${label.label} needs the lines read in the code`);
    }
    switch (label.label) {
      case "hit": {
        if (!issues.has(label.issue)) add(index, `${label.issue} is not an issue in the key`);
        const earlier = claimed.get(label.issue);
        if (earlier !== undefined) {
          add(
            index,
            `${label.issue} is already hit by finding ${earlier}; this one is a duplicate`,
          );
        } else claimed.set(label.issue, label.finding);
        break;
      }
      case "wrong":
        if (label.symptomOf !== undefined && !issues.has(label.symptomOf)) {
          add(index, `symptomOf ${label.symptomOf} is not an issue in the key`);
        }
        if (label.repeats !== undefined && !refuted.has(label.repeats)) {
          add(index, `repeats ${label.repeats}, which is not a refuted claim in the key`);
        }
        break;
      case "duplicate":
        if (label.of >= label.finding) {
          add(index, `a duplicate names an earlier finding, not ${label.of}`);
        }
        break;
      case "unsettled":
        if (options.voter && label.excluded === undefined) {
          add(index, "an unsettled finding names the unconfirmed claim it repeats, in excluded");
        }
        if (
          label.excluded !== undefined &&
          key.excluded[label.excluded]?.reason !== "unconfirmed"
        ) {
          add(index, `exclusion ${label.excluded} is not an unconfirmed one in the key`);
        }
        break;
    }
  });
  return problems;
}
