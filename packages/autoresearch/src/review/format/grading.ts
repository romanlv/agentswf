import { SEVERITIES, type Severity } from "./format";

export type { Severity };

/** Shared by the drafter and the graders, so every grade is given on the same scale. */
export const SEVERITY_RUBRIC = `Severity says what should happen to the MR, judged by consequence, not by how confident or alarming the comment sounded. Judge it against the base the MR branched from: what matters is what merging changes. Decide by these tests, in order:
- \`must-fix\`: harm happens after merge with today's code and data (wrong behaviour users hit, a security hole, lost or corrupted data, a broken build or deploy) that the base did not have, and you can name the input or state that triggers it.
- \`should-fix\`: you can name a concrete, likely next trigger: an existing caller due to move onto this code, a value a user can enter through a validated path today, or a new API or pattern others are meant to copy. Missing tests count here only when a behaviour the MR changes is not exercised at all.
- \`could-fix\`: real, but the trigger needs data that validation elsewhere already rejects, a deliberate cast or misuse, a contrived combination of settings, or it only adds log or monitoring noise.
- \`nit\`: no effect on behaviour: naming, duplicated docs, formatting only an advisory linter flags, CI step order.
A problem the MR neither causes nor makes worse (scope \`context\`) is \`could-fix\` at most, however bad it is: it is not a reason to hold this MR.`;

/**
 * The median vote. With an even count it leans to the less severe of the middle two, since the
 * grades most likely to be wrong are the inflated ones.
 */
export function settleSeverity(votes: readonly Severity[]): Severity {
  if (votes.length === 0) throw new Error("no severity votes");
  const ranked = votes.toSorted((a, b) => SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b));
  return ranked[Math.floor(ranked.length / 2)]!;
}

/** A strict majority: a tie is not enough to keep a claim either way. */
export function majority(votes: readonly boolean[]): boolean {
  return votes.filter(Boolean).length * 2 > votes.length;
}

/** What is wrong with a grader's answer: every item must get exactly one vote, and only items asked. */
export function ballotProblems(
  answer: { issues: readonly { id: string }[]; refuted: readonly { id: string }[] },
  asked: { issues: readonly string[]; refuted: readonly string[] },
): string[] {
  const problems: string[] = [];
  for (const kind of ["issues", "refuted"] as const) {
    const given = answer[kind].map((vote) => vote.id);
    for (const id of asked[kind]) {
      const count = given.filter((g) => g === id).length;
      if (count !== 1) problems.push(`${id} has ${count} votes`);
    }
    for (const id of new Set(given)) {
      if (!asked[kind].includes(id)) problems.push(`${id} is not one of the ${kind} asked about`);
    }
  }
  return problems;
}
