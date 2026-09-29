import type { AnswerKey } from "./format";
import { type ReviewFinding, SCORER_RESULT_FORMAT, type ScorerResult } from "./scoring";

/**
 * The sanity bounds every scorer and judge is checked on. The oracle finds exactly the key's
 * issues, each once, in the key's own words: it must score full recall with nothing wrong. Nop
 * finds nothing and must score zero.
 */
export function oracleFindings(key: AnswerKey): ReviewFinding[] {
  return key.issues.map((issue) => {
    const at = issue.locations[0];
    return {
      ...(at ? { path: at.path, line: at.start } : {}),
      text: issue.mechanism,
      severity: issue.severity,
    };
  });
}

/** What a perfect judge makes of `oracleFindings`: each finding hits its own issue. */
export function oracleScorerResult(key: AnswerKey): ScorerResult {
  return {
    format: SCORER_RESULT_FORMAT,
    labels: key.issues.map((issue, finding) => ({
      finding,
      label: "hit" as const,
      issue: issue.id,
      why: "the key's own mechanism",
      read: issue.locations.map(({ path, start, end }) => ({ path, start, end })),
    })),
    missed: "",
  };
}

export const NOP_FINDINGS: readonly ReviewFinding[] = [];

export const NOP_SCORER_RESULT: ScorerResult = {
  format: SCORER_RESULT_FORMAT,
  labels: [],
  missed: "",
};

/** A review note as the fixture's GitLab evidence keeps it, as far as a comment input needs. */
export type Note = {
  id: number;
  body: string;
  position?: { new_path?: string | null; new_line?: number | null } | null;
};

/** A comment the key cites, as a finding, with every label a right judge could give it. */
export type Cited = { finding: ReviewFinding; accepted: string[] };

/**
 * The review comments the key cites, oldest first, as findings: a judge's check on inputs whose
 * labels the key already gives. One comment can be the source of several items, so each lists what
 * it may rightly get: a hit on an issue it raised, or a duplicate once an earlier comment raised it;
 * `wrong` for a refuted claim; `noise` for praise, questions and taste; `unsettled` for a claim
 * nobody could settle; `noise` or `wrong` for one about code the frozen head does not have yet.
 */
export function citedComments(
  key: AnswerKey,
  discussions: readonly { id: string; notes: readonly Note[] }[],
): Cited[] {
  const notes = new Map<string, Note>(
    discussions.flatMap((d) => d.notes.map((note) => [`${d.id}:${note.id}`, note] as const)),
  );
  const accepted = new Map<string, Set<string>>();
  const accept = (sources: AnswerKey["issues"][number]["sources"], ...labels: string[]) => {
    for (const source of sources) {
      if (!("discussion" in source)) continue;
      const at = `${source.discussion}:${source.note}`;
      if (!notes.has(at)) continue;
      const set = accepted.get(at) ?? new Set<string>();
      for (const label of labels) set.add(label);
      accepted.set(at, set);
    }
  };
  for (const issue of key.issues) accept(issue.sources, `hit:${issue.id}`);
  for (const claim of key.refuted) accept(claim.sources, "wrong");
  for (const exclusion of key.excluded) {
    const labels =
      exclusion.reason === "unconfirmed"
        ? ["unsettled"]
        : exclusion.reason === "not-in-snapshot"
          ? ["noise", "wrong"]
          : ["noise"];
    accept(exclusion.sources, ...labels);
  }
  const ordered = [...accepted.keys()].sort((a, b) => notes.get(a)!.id - notes.get(b)!.id);
  const raised = new Set<string>();
  return ordered.map((at) => {
    const note = notes.get(at)!;
    const labels = [...accepted.get(at)!];
    const earlier = labels.filter((label) => label.startsWith("hit:") && raised.has(label));
    for (const label of labels) if (label.startsWith("hit:")) raised.add(label);
    const path = note.position?.new_path ?? undefined;
    const line = note.position?.new_line ?? undefined;
    return {
      finding: { ...(path ? { path } : {}), ...(path && line ? { line } : {}), text: note.body },
      accepted: earlier.length > 0 ? [...labels, "duplicate"] : labels,
    };
  });
}
