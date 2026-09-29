export { restore } from "./fixtures/git";
export { digestFixture, sealSet, verifySet } from "./fixtures/seal";
export { fixtureId } from "./fixtures/set";
export { verifyFixture } from "./fixtures/verify";
export type {
  AnswerKey,
  CollectRecord,
  Fixture,
  FixtureSet,
  KnownIssue,
  Source,
} from "./format/format";
export type { FindingLabel, ReviewFinding, ScorerResult } from "./format/scoring";
export { SCORER_RESULT_FORMAT } from "./format/scoring";
export {
  type Checked,
  checkAnswerKey,
  checkCollectRecord,
  checkFixture,
  checkFixtureSet,
  describeProblems,
  type Problem,
} from "./format/validate";
export {
  defineReviewScorer,
  defineReviewVariant,
  type ReviewScorer,
  type ReviewVariant,
  type WorkflowFile,
} from "./format/variant";
export { checkScorerResult } from "./judge/check";

import type { WorkflowFile } from "./format/variant";
import panel from "./judge/judge.workflow";
import comments from "./lab/comments.workflow";
import nop from "./lab/nop.workflow";
import oracle from "./lab/oracle.workflow";

/** The package's own judge, the panel: spread into a `defineReviewScorer`, as `{ ...PANEL_JUDGE, argv, timeout }`. */
export const PANEL_JUDGE = {
  workflow: panel,
  file: new URL("./judge/judge.workflow.ts", import.meta.url),
} satisfies WorkflowFile;
/** The sanity bounds, spread into a variant file: the key's issues, and nothing. */
export const ORACLE_WORKFLOW = {
  workflow: oracle,
  file: new URL("./lab/oracle.workflow.ts", import.meta.url),
} satisfies WorkflowFile;
export const NOP_WORKFLOW = {
  workflow: nop,
  file: new URL("./lab/nop.workflow.ts", import.meta.url),
} satisfies WorkflowFile;
/** A judge's check: the review comments a fixture's key cites, as findings. */
export const COMMENTS_WORKFLOW = {
  workflow: comments,
  file: new URL("./lab/comments.workflow.ts", import.meta.url),
} satisfies WorkflowFile;
