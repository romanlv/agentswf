import { checkVersion, DEFAULT_VERSION } from "../../shared/version";
import type { Key } from "../format/settings";
import type { Fact } from "./index";

/** What a code grader's export carries, checked by the helper that loads `graders.ts`. */
export const GRADER_KIND = "awf.case-grader/0";

/** What every grader is given. */
export type GradeInput<R = unknown> = {
  case: {
    name: string;
    /** The built case folder: the dataset's shared files and the case's own, and `input.json`. */
    dir: string;
    // biome-ignore lint/suspicious/noExplicitAny: typed by the reader, as `c.input` is.
    input: any;
    /** The case's key, without its marker. */
    key: Omit<Key, "marker">;
    /** The case's `key/` folder, the files a grader needs, when it has one. */
    keyDir?: string;
  };
  /**
   * The workflow's whole result. Typed as `R`, as `observe`'s is: a case that stops at `until`
   * gives `null`, and its grader says so itself.
   */
  result: R;
  /** The trial's working folder, as the workflow left it. */
  scratch: string;
  /** Where the dataset's `keep` paths were saved from the scratch folder. */
  kept: string;
};

/** What a grader that `readsFacts` is given besides. */
export type FactsInput = {
  /** What `observe` returned. */
  facts: Record<string, Fact>;
  /** The stages' values, by name. */
  stages: Record<string, unknown>;
};

/** A count out of a total, or a plain value; pooled per column in the report. */
export type GradeNumber = { count: number; of: number } | { value: number };

export type Grade = {
  verdict?: "passed" | "failed" | "undecided";
  numbers?: Record<string, GradeNumber>;
  /** Why, each about a field, a criterion or a part of the result. */
  reasons?: { about: string; text: string }[];
  /** The grader doesn't apply to this case, and why; given with no verdict and no numbers. */
  notApplies?: string;
};

export type CodeGrader = {
  readonly kind: typeof GRADER_KIND;
  readonly version: string;
  readonly readsFacts: boolean;
  grade(input: GradeInput & Partial<FactsInput>): Grade | Promise<Grade>;
};

/**
 * A dataset's own grader, a named export of its `graders.ts`, listed by name in `dataset.json`'s
 * `graders`. It runs after `expect`, in a process of its own in your checkout. `readsFacts: true`
 * gives it the facts `observe` returned and the stages' values.
 *
 * `version`, semver, `1.0.0` when left out, is stored on every grade: bump its minor when the
 * grader judges differently, so its grades are told apart; a patch says it judges the same.
 */
export function defineGrader<R = unknown>(spec: {
  version?: string;
  readsFacts: true;
  grade(input: GradeInput<R> & FactsInput): Grade | Promise<Grade>;
}): CodeGrader;
export function defineGrader<R = unknown>(spec: {
  version?: string;
  readsFacts?: false;
  grade(input: GradeInput<R>): Grade | Promise<Grade>;
}): CodeGrader;
export function defineGrader(spec: {
  version?: string;
  readsFacts?: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: either overload's input.
  grade(input: any): Grade | Promise<Grade>;
}): CodeGrader {
  const version = spec.version ?? DEFAULT_VERSION;
  const bad = checkVersion(version);
  if (bad) throw new Error(`defineGrader: ${bad}`);
  return { kind: GRADER_KIND, version, readsFacts: spec.readsFacts === true, grade: spec.grade };
}
