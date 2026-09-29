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
export type { FindingLabel, Judgement, ReviewFinding } from "./format/scoring";
export { JUDGEMENT_FORMAT } from "./format/scoring";
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
  defineReviewJudge,
  defineReviewVariant,
  type ReviewJudge,
  type ReviewVariant,
} from "./format/variant";
export { checkJudgement } from "./judge/check";

/** The package's own judge, the panel: a `defineReviewJudge` file's `workflow`. */
export const PANEL_JUDGE: URL = new URL("./judge/judge.workflow.ts", import.meta.url);
/** The sanity bounds as workflows for a variant file: the key's issues, and nothing. */
export const ORACLE_WORKFLOW: URL = new URL("./lab/oracle.workflow.ts", import.meta.url);
export const NOP_WORKFLOW: URL = new URL("./lab/nop.workflow.ts", import.meta.url);
/** A judge's check: the review comments a fixture's key cites, as findings. */
export const COMMENTS_WORKFLOW: URL = new URL("./lab/comments.workflow.ts", import.meta.url);
