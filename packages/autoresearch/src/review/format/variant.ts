import type { ExecutableWorkflow, JsonValue } from "@wf/contract/workflow";
import type { Judgement, ReviewFinding } from "./scoring";

export const REVIEW_VARIANT_KIND = "awf.review-variant/1";
export const REVIEW_JUDGE_KIND = "awf.review-judge/1";

/**
 * Any executable workflow, whatever its arguments: they are its own, and `awf-lab` passes them as
 * command-line arguments, never typed.
 */
// biome-ignore lint/suspicious/noExplicitAny: a workflow's Args sit in both variances, so only `any` admits every one.
type AnyWorkflow = ExecutableWorkflow<any, JsonValue>;

export type ResultOf<W extends AnyWorkflow> =
  W extends ExecutableWorkflow<infer _, infer R> ? R : never;

/** A workflow run as it is: the file, and the command line `awf run` gives it after `--`. */
type Run = {
  /** The workflow file, as `new URL("./workflow.ts", import.meta.url)`. */
  workflow: URL;
  /**
   * In a variant, `{base}`, `{head}`, `{request}` and `{dataset}` anywhere in a string become the
   * snapshot's base and head commits, the path of the request and the dataset's folder; `{{` and
   * `}}` are literal braces.
   */
  argv: readonly string[];
  /** As `awf run --timeout` takes it, such as `30m`. */
  timeout: string;
  /**
   * In semver; absent, `1.0.0`. Results belong to `{major}.{minor}`: bump the patch for a change
   * that keeps the behaviour, so earlier results still count, and the minor or major for one
   * that doesn't.
   */
  version?: string;
};

/** One way of reviewing: a workflow, how to hand it a fixture, and how to read what it returns. */
export type ReviewVariant<Result = JsonValue> = Run & {
  read(result: Result): ReviewFinding[];
  /**
   * Every fixture that influenced it: written from, tuned on, or used to pick it over another
   * variant. Given as fixtures from before a date, or named ones. The rest is its holdout.
   */
  tunedOn?: { before?: string; fixtures?: string[] };
};

/**
 * A judge: a workflow that `awf-lab` runs with `--fixture {dir} --findings {file}` after `argv`,
 * in a fresh checkout of the frozen code, and whose value is a `Judgement`. Scoring chosen
 * findings adds `--settled {file}`, labels to return unchanged; a judge without it can't do that.
 */
export type ReviewJudge = Run;

export type DefinedVariant = ReviewVariant & { kind: typeof REVIEW_VARIANT_KIND };
export type DefinedJudge = ReviewJudge & { kind: typeof REVIEW_JUDGE_KIND };

/**
 * A variant file's default export. Given the workflow's type, `read` is checked against its
 * result, so a workflow whose result changes shape fails `tsc` on the variant file:
 * `defineReviewVariant<typeof review>({ workflow: new URL("./review.ts", import.meta.url), … })`.
 * The type argument is what is checked, not the file `workflow` names: keep the two the same.
 */
export function defineReviewVariant<
  W extends AnyWorkflow = ExecutableWorkflow<JsonValue, JsonValue>,
>(variant: ReviewVariant<ResultOf<W>>): DefinedVariant {
  return { ...variant, kind: REVIEW_VARIANT_KIND } as unknown as DefinedVariant;
}

/**
 * A judge file's default export. Given the workflow's type, one whose result is not a
 * `Judgement` fails `tsc`: `defineReviewJudge<typeof judge>({ … })`. Whatever the types say,
 * `awf-lab` checks every judgement it reads.
 */
// biome-ignore lint/suspicious/noExplicitAny: as `AnyWorkflow`; only the result is constrained.
export function defineReviewJudge<_W extends ExecutableWorkflow<any, Judgement> = never>(
  judge: ReviewJudge,
): DefinedJudge {
  return { ...judge, kind: REVIEW_JUDGE_KIND };
}
