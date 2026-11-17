import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Errored, GraderEntry, Previous } from "../format/records";
import type { Fact, Key } from "../format/settings";
import type { Answer } from "./answer";
import { type CaseInfo, sha256 } from "./dataset";
import { gradeExpect } from "./expect";

/** `expect`'s version: its minor goes up when it compares facts differently. */
export const EXPECT_VERSION = "1.0.0";

/** What a grader is called with, during a trial or under `score`. */
export type GradeCall = {
  case: {
    name: string;
    /** The built case folder: the trial's, or the copy kept in its `input/`. */
    dir: string;
    input: unknown;
    key: Omit<Key, "marker">;
    /** The case's `key/` folder, when it has one. */
    keyDir?: string;
  };
  facts: Record<string, Fact>;
  stages: Record<string, unknown>;
  result: unknown;
  /** The trial's working folder; null under `score`. */
  scratch: string | null;
  /** Where the trial's `keep` paths were saved. */
  kept: string;
  /** A folder of the lab's, outside the case and scratch folders, for the grader's own files. */
  work: string;
  env: Record<string, string>;
  /** The trial's parameters. */
  params: Record<string, string>;
  /** This grader's earlier parts, when they still count. */
  previous?: Previous;
};

/** What a grader gives back: its answer, and what its own run took. */
export type Graded = Answer & Pick<GraderEntry, "version" | "runId" | "models" | "estimate" | "ms">;

/** A grader the lab runs after `expect`: a dataset's own, or one a test adds. */
export type LabGrader = {
  name: string;
  /** Its declared version, semver: grades belong to its `{major}.{minor}`. Absent: unknown. */
  version?: string;
  /** A grader workflow: runs agents, after the cheap ones, and is skipped when one failed. */
  costly?: boolean;
  /** Run only by `score --grader`; never decides a verdict. */
  onDemand?: boolean;
  /** Throws grading's error, with the grader's `version` on the error when it was read. */
  grade(call: GradeCall): Promise<Graded>;
};

/** JSON with its keys in order, for a digest that is the same however the value was built. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The part of the key `expect` reads: its values. */
export const expectDigestOf = (key: Key) => sha256(canonical(key.expect ?? {}));

/**
 * The part of the key a dataset's grader reads: the whole key but its marker, and each `key/`
 * file by its digest. A marker change grades nothing again; a `key/` edit does.
 */
export function keyDigestOf(info: Pick<CaseInfo, "dir" | "key" | "keyFiles">): string {
  const { marker: _, ...key } = info.key;
  const files = Object.fromEntries(
    info.keyFiles.map((f) => [relative(join(info.dir, "key"), f.path), f.digest]),
  );
  return sha256(canonical({ key, files }));
}

/** `{major}.{minor}`: a grade belongs to it, so a patch bump keeps the grade. */
export const minorOf = (version: string | undefined) =>
  version === undefined ? undefined : version.split(".").slice(0, 2).join(".");

const hasExpect = (key: Key) => Object.keys(key.expect ?? {}).length > 0;

/**
 * The graders whose grades decide a case's trials now: `expect` when its key has values, and
 * every dataset grader not marked `onDemand`, by the current `dataset.json`. A grade by any other
 * (a grader removed, made on demand, an `expect` taken out of the key) is shown, never decisive.
 */
export function decidersOf(key: Key, graders: readonly Pick<LabGrader, "name" | "onDemand">[]) {
  return new Set([
    ...(hasExpect(key) ? ["expect"] : []),
    ...graders.filter((g) => !g.onDemand).map((g) => g.name),
  ]);
}

/** Whether these entries fail the trial: a deciding grader's `failed`. */
export function failsIn(entries: readonly GraderEntry[], deciders: ReadonlySet<string>): boolean {
  return entries.some(
    (e) =>
      deciders.has(e.grader) && !e.skipped && !e.errored && !e.notApplies && e.verdict === "failed",
  );
}

/**
 * Why a grader's newest grade no longer stands, so `score` grades it again: none yet, it errored,
 * the part of the key it reads changed, or its `{major}.{minor}` did. Undefined: it stands. A
 * skipped grade is the caller's to weigh, as it depends on the cheaper graders.
 */
export function staleBecause(
  entry: GraderEntry | undefined,
  key: string,
  version: string | undefined,
): string | undefined {
  if (!entry) return "not graded";
  if (entry.errored) return "errored";
  if (entry.key !== key) return "key changed";
  if (version !== undefined && minorOf(entry.version) !== minorOf(version)) return "version";
  return undefined;
}

/**
 * A grader's earlier parts, given as `previous.json`: from its newest grade when that one did not
 * error and has the grader's `{major}.{minor}`, so the grader judges only what the key's change
 * touched.
 */
export function previousFrom(
  entry: GraderEntry | undefined,
  version: string | undefined,
): Previous | undefined {
  if (!entry?.parts || entry.errored || entry.skipped) return undefined;
  if (version !== undefined && minorOf(entry.version) !== minorOf(version)) return undefined;
  return { key: entry.key, parts: entry.parts };
}

export type GradeTrial = {
  info: CaseInfo;
  facts: Record<string, Fact>;
  stages: Record<string, unknown>;
  result: unknown;
  caseDir: string;
  scratch: string | null;
  kept: string;
  work: string;
  env: Record<string, string>;
  params: Record<string, string>;
  /** Grade `expect` too. */
  expect: boolean;
  /** The graders to run, cheap ones first; costly ones after. */
  graders: readonly LabGrader[];
  /** Whose grades decide this case's verdict. */
  deciders: ReadonlySet<string>;
  /** The trial's newest grades left as they are: a costly grader is skipped when they fail it. */
  standing?: readonly GraderEntry[];
  previousOf?: (grader: string) => Previous | undefined;
  /**
   * Asked before each costly grader, with the grades made so far on this trial: false stops
   * grading there, for a budget.
   */
  mayContinue?: (made: readonly GraderEntry[]) => boolean;
};

export type TrialGrades =
  | { entries: GraderEntry[]; stopped?: true }
  | { errored: Pick<Errored, "code" | "reason"> };

/**
 * `expect`, then the cheap graders, then the costly ones, each skipped when the trial already
 * fails. An `expect` that can't compare a fact errors the trial as the dataset's.
 */
export async function gradeTrial(trial: GradeTrial): Promise<TrialGrades> {
  const { info } = trial;
  const entries: GraderEntry[] = [];
  if (trial.expect) {
    const expected = info.key.expect ?? {};
    const started = Date.now();
    const result = gradeExpect(expected, trial.facts);
    if ("errored" in result) return { errored: { code: result.errored, reason: result.reason } };
    entries.push({
      grader: "expect",
      version: EXPECT_VERSION,
      key: expectDigestOf(info.key),
      verdict: result.verdict,
      reasons: result.reasons,
      ms: Date.now() - started,
    });
  }
  const key = keyDigestOf(info);
  const { marker: _, ...bare } = info.key;
  const inputFile = join(trial.caseDir, "input.json");
  const keyDir = join(info.dir, "key");
  const ordered = [
    ...trial.graders.filter((g) => !g.costly),
    ...trial.graders.filter((g) => g.costly),
  ];
  for (const grader of ordered) {
    const base = { grader: grader.name, key };
    if (grader.costly) {
      if (failsIn([...(trial.standing ?? []), ...entries], trial.deciders)) {
        entries.push({ ...base, reasons: [], skipped: true });
        continue;
      }
      if (trial.mayContinue && !trial.mayContinue(entries)) return { entries, stopped: true };
    }
    const started = Date.now();
    try {
      const previous = trial.previousOf?.(grader.name);
      const out = await grader.grade({
        case: {
          name: info.name,
          dir: trial.caseDir,
          input: existsSync(inputFile) ? JSON.parse(readFileSync(inputFile, "utf8")) : {},
          key: bare,
          ...(existsSync(keyDir) ? { keyDir } : {}),
        },
        facts: trial.facts,
        stages: trial.stages,
        result: trial.result ?? null,
        scratch: trial.scratch,
        kept: trial.kept,
        work: trial.work,
        env: trial.env,
        params: trial.params,
        ...(previous ? { previous } : {}),
      });
      const version = out.version ?? grader.version;
      entries.push({
        ...base,
        ...out,
        ...(version ? { version } : {}),
        ms: out.ms ?? Date.now() - started,
      });
    } catch (error) {
      const extra = error as { version?: unknown; runId?: unknown; estimate?: unknown };
      const version = typeof extra.version === "string" ? extra.version : grader.version;
      entries.push({
        ...base,
        ...(version ? { version } : {}),
        ...(typeof extra.runId === "string" ? { runId: extra.runId } : {}),
        ...(typeof extra.estimate === "number" ? { estimate: extra.estimate } : {}),
        reasons: [],
        errored: { reason: (error as Error).message },
        ms: Date.now() - started,
      });
    }
  }
  return { entries };
}
