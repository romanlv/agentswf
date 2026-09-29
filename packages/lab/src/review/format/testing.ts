import { type AnswerKey, KEY_FORMAT, type KnownIssue } from "./format";
import {
  FINDINGS_FORMAT,
  type FindingLabel,
  type FindingsRecord,
  JUDGEMENT_FORMAT,
  type Judgement,
  type ReviewFinding,
  type RunSummary,
  SCORE_FORMAT,
  type ScoreRecord,
} from "./scoring";

/**
 * A hand-built fixture for tests: a key with an issue of every severity and source and one outside
 * the change, and a review with a finding for every label.
 */

const SHA = "a".repeat(40);

function issue(
  id: string,
  severity: KnownIssue["severity"],
  category: KnownIssue["category"],
  sources: KnownIssue["sources"],
  scope: KnownIssue["scope"] = "change",
): KnownIssue {
  return {
    id,
    mechanism: `${id}: what goes wrong`,
    visibleIn: "diff",
    severity,
    category,
    scope,
    locations: [{ path: "src/app.ts", start: 1, end: 2 }],
    confirmation: { basis: "verified", how: "traced" },
    sources,
  };
}

const comment = { discussion: "d1", note: 1 };
const commit = { commit: SHA };
const run = { run: "r1", finding: 0 };

export const EXAMPLE_KEY: AnswerKey = {
  format: KEY_FORMAT,
  fixture: "app-1",
  revision: 1,
  draftedBy: "codex/gpt",
  procedure: "p1",
  issues: [
    issue("K1", "must-fix", "correctness", [comment]),
    issue("K2", "must-fix", "security", [commit]),
    issue("K3", "should-fix", "tests", [comment, commit]),
    issue("K4", "could-fix", "design", [run]),
    issue("K5", "nit", "docs-style", [comment]),
    issue("K6", "could-fix", "performance", [comment], "context"),
    issue("K7", "must-fix", "correctness", [comment]),
  ],
  refuted: [
    {
      id: "R1",
      claim: "the lock is dropped early",
      reason: "false-premise",
      why: "held",
      sources: [comment],
    },
  ],
  excluded: [
    { sources: [comment], reason: "preference", claim: "names" },
    { sources: [comment], reason: "unconfirmed", claim: "maybe a race" },
  ],
};

const read = [{ path: "src/app.ts", start: 1, end: 2 }];
const why = "because";

/** One finding per label, and the label cases the rules name: a symptom, a repeated false claim. */
export const EXAMPLE_LABELS: FindingLabel[] = [
  { finding: 0, label: "hit", issue: "K1", why, read },
  { finding: 1, label: "duplicate", of: 0, why, read: [] },
  {
    finding: 2,
    label: "wrong",
    refutes: "the lock is held",
    symptomOf: "K2",
    repeats: "R1",
    why,
    read,
  },
  { finding: 3, label: "hit", issue: "K2", why, read },
  {
    finding: 4,
    label: "new",
    severity: "should-fix",
    category: "correctness",
    scope: "change",
    mechanism: "retries forever",
    why,
    read,
  },
  { finding: 5, label: "noise", why, read },
  { finding: 6, label: "hit", issue: "K5", why, read },
  { finding: 7, label: "unsettled", excluded: 1, why, read: [] },
  { finding: 8, label: "hit", issue: "K6", why, read },
  {
    finding: 9,
    label: "new",
    severity: "nit",
    category: "docs-style",
    scope: "change",
    mechanism: "a typo",
    why,
    read,
  },
  { finding: 10, label: "duplicate", of: 2, why, read: [] },
];

export const EXAMPLE_FINDINGS: ReviewFinding[] = EXAMPLE_LABELS.map((label) => ({
  path: "src/app.ts",
  line: 1,
  text: `finding ${label.finding} words`,
}));

export const EXAMPLE_JUDGEMENT: Judgement = {
  format: JUDGEMENT_FORMAT,
  labels: EXAMPLE_LABELS,
  missed: "K3, K4 and K7",
};

const DIGEST = `sha256:${"0".repeat(64)}`;

export const EXAMPLE_RUN: RunSummary = {
  id: "run-1",
  outcome: "succeeded",
  models: ["claude-sonnet-5"],
  ms: 60_000,
  estimate: 0.5,
  billing: "subscription",
  complete: true,
};

export const EXAMPLE_FINDINGS_RECORD: FindingsRecord = {
  format: FINDINGS_FORMAT,
  id: "20260927T010000-ab12",
  at: "2026-09-27T01:00:00Z",
  variant: { name: "one-agent", hash: "v1-0123456789abcdef", commit: SHA, dirty: false },
  set: "first",
  fixture: { id: "app-1", digest: DIGEST },
  restoreMs: 1_200,
  run: EXAMPLE_RUN,
  findings: EXAMPLE_FINDINGS,
};

export const EXAMPLE_SCORE_RECORD: ScoreRecord = {
  format: SCORE_FORMAT,
  at: "2026-09-27T01:05:00Z",
  judge: { name: "panel", hash: "v1-fedcba9876543210", commit: null, dirty: false },
  set: "first",
  fixture: { id: "app-1", digest: DIGEST },
  review: EXAMPLE_FINDINGS_RECORD.id,
  key: { revision: 1, procedure: "p1", digest: DIGEST },
  run: { ...EXAMPLE_RUN, id: "run-2", models: ["gpt-6-sol", "claude-sonnet-5"] },
  agreement: 1,
  result: { status: "judged", judgement: EXAMPLE_JUDGEMENT },
};
