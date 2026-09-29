import type { ExecutableWorkflow, JsonValue } from "@agentswf/contract/workflow";
import type { ReviewFinding, ScorerResult } from "./scoring";

export const REVIEW_VARIANT_KIND = "awf.review-variant/1";
export const REVIEW_SCORER_KIND = "awf.review-scorer/1";

/**
 * Any executable workflow, whatever its arguments: they are its own, and `awf-lab` passes them as
 * command-line arguments, never typed.
 */
// biome-ignore lint/suspicious/noExplicitAny: a workflow's Args sit in both variances, so only `any` admits every one.
type AnyWorkflow = ExecutableWorkflow<any, JsonValue>;

// biome-ignore lint/suspicious/noExplicitAny: as `AnyWorkflow`; only the result is constrained.
type ScorerWorkflow = ExecutableWorkflow<any, ScorerResult>;

export type ResultOf<W extends AnyWorkflow> =
  W extends ExecutableWorkflow<infer _, infer R> ? R : never;

/**
 * What `awf-lab` needs beside the workflow: the command line `awf run` gives it after `--`, how
 * long it may take, and its version.
 */
type Settings = {
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
export type ReviewVariant<W extends AnyWorkflow = AnyWorkflow> = Settings & {
  workflow: W;
  read(result: ResultOf<W>): ReviewFinding[];
  /**
   * Every fixture that influenced it: written from, tuned on, or used to pick it over another
   * variant. Given as fixtures from before a date, or named ones. The rest is its holdout.
   */
  tunedOn?: { before?: string; fixtures?: string[] };
};

/**
 * A scorer: a workflow that `awf-lab` runs with `--fixture {dir} --findings {file}` after `argv`,
 * in a fresh checkout of the frozen code, and whose value is a `ScorerResult`. Scoring chosen
 * findings adds `--settled {file}`, labels to return unchanged; a scorer without it can't do that.
 */
export type ReviewScorer<W extends ScorerWorkflow = ScorerWorkflow> = Settings & { workflow: W };

/** A variant as `awf-lab` reads it from the variant file: everything but the workflow. */
export type VariantSettings = Omit<ReviewVariant, "workflow"> & {
  kind: typeof REVIEW_VARIANT_KIND;
};
export type ScorerSettings = Settings & { kind: typeof REVIEW_SCORER_KIND };

/**
 * A variant file's default export: the workflow itself, so `awf run` runs the variant file, with
 * the rest under `review`. `read` is checked against the workflow's result, so a workflow whose
 * result changes shape fails `tsc` on the variant file.
 */
export function defineReviewVariant<W extends AnyWorkflow>({
  workflow,
  ...settings
}: ReviewVariant<W>): W & { review: VariantSettings } {
  const review = { ...settings, kind: REVIEW_VARIANT_KIND } as unknown as VariantSettings;
  return { ...workflow, review };
}

/**
 * A scorer file's default export, as `defineReviewVariant`'s. A workflow whose result is not a
 * `ScorerResult` fails `tsc`. Whatever the types say, `awf-lab` checks every result it reads.
 */
export function defineReviewScorer<W extends ScorerWorkflow>({
  workflow,
  ...settings
}: ReviewScorer<W>): W & { review: ScorerSettings } {
  return { ...workflow, review: { ...settings, kind: REVIEW_SCORER_KIND } };
}
