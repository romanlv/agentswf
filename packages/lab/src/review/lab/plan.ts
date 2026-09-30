import type { PartialScore, Score, Trial } from "../format/records";
import type { FindingLabel } from "../format/scoring";
import type { SandboxSetting } from "../format/workspace";
import { keyOf } from "./version";

/** A score as the store read it, with the digest of its record as stored, which names it. */
export type ScoreOnFile = Score & { digest: string };

/** A trial on file, its scores, and its partial scores. */
export type Stored = { trial: Trial; scores: ScoreOnFile[]; partials: PartialScore[] };

/** What the store holds for one case under a variant's version, and what the case is now. */
export type CaseState = {
  case: string;
  digest: string;
  keyRevision: number;
  /** The sandbox a trial must have run in to count: the workspace's. */
  sandbox: SandboxSetting;
  stored: readonly Stored[];
};

/** Which findings of a trial a command chose; none named means the whole trial. */
export type Choice = { findings?: readonly number[] };

/** A command's choice of one variant's trials: by case, then by trial number. */
export type Chosen = ReadonlyMap<string, ReadonlyMap<number, Choice>>;

export type Step = {
  case: string;
  /** Which of the case's trials, from 1. */
  n: number;
  trial: { do: "run" } | { do: "reuse"; trial: Trial } | { do: "skip"; why: string };
  score:
    | { do: "run" }
    | { do: "reuse"; score: Score }
    | { do: "record"; why: string }
    | { do: "skip"; why: string }
    | { do: "partial"; picked: number[]; asked: number[]; restFrom: ScoreOnFile }
    | { do: "reuse-partial"; record: PartialScore; restFrom: ScoreOnFile };
};

/** What a command chose that can't be scored: a finding, trial or rest-from score that isn't there. */
export class PlanError extends Error {}

/**
 * The findings a partial score must ask: the picked ones, and every rest-from label that depends
 * on them. A hit after the first picked finding may have to become that finding's duplicate, and
 * a duplicate of a picked finding may no longer repeat anything, so both are asked again, with
 * whatever depends on those in turn. The rest are settled.
 */
function askedWith(picked: readonly number[], rest: readonly FindingLabel[]): number[] {
  const asked = new Set(picked);
  const first = Math.min(...picked);
  for (const label of rest)
    if (label.label === "hit" && label.finding > first) asked.add(label.finding);
  for (let grew = true; grew; ) {
    grew = false;
    for (const label of rest) {
      if (label.label === "duplicate" && asked.has(label.of) && !asked.has(label.finding)) {
        asked.add(label.finding);
        grew = true;
      }
    }
  }
  return [...asked].sort((x, y) => x - y);
}

const newestFirst = <T extends { at: string }>(a: T, b: T) =>
  a.at < b.at ? 1 : a.at > b.at ? -1 : 0;

/**
 * The trials a case's numbers come from, oldest first, so trial n keeps its number as later ones
 * are added: those on this case's digest whose run started, in the workspace's sandbox. A run that
 * never started (awf refused it, or no login) says nothing about the variant, so it is run again
 * rather than reused as a zero. A trial in no sandbox could have read the key, and one in another
 * provider's measured something else: both are run again.
 */
export function currentTrials(state: CaseState): Stored[] {
  return started(state)
    .filter((s) => sameSetting(s.trial.sandbox, state.sandbox))
    .toSorted((a, b) => oldestFirst(a.trial, b.trial));
}

/** Trial n of a case, counting from 1, as `currentTrials` numbers them. */
export function currentTrial(state: CaseState, n = 1): Stored | undefined {
  return currentTrials(state)[n - 1];
}

const oldestFirst = (a: Trial, b: Trial) =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Why a case has no trial n: fewer than n on file, some perhaps in another sandbox, or else `none`.
 */
export function whyNoTrial(state: CaseState, none: string, n = 1): string {
  const have = currentTrials(state).length;
  const elsewhere = started(state).length - have;
  const where =
    elsewhere > 0
      ? `in this workspace's sandbox (${elsewhere} more in another, which don't count)`
      : "on file";
  if (have > 0) return `${have} of ${n} trials ${where}; awf-lab run runs the rest`;
  return elsewhere > 0 ? "no trial in this workspace's sandbox; awf-lab run runs it again" : none;
}

/**
 * The trials a command plans of one case. `run` of trial n runs every earlier one missing too:
 * trials are numbered by age, so trial n can only be made after trials 1 to n − 1.
 */
function trialsOf(
  state: CaseState,
  chosen: ReadonlyMap<number, Choice> | undefined,
  command: "run" | "score",
): ReadonlyMap<number, Choice> {
  if (!chosen || command === "score" || chosen.size === 0) return chosen ?? new Map();
  const last = Math.max(...chosen.keys());
  const have = currentTrials(state).length;
  const all = new Map(chosen);
  for (let n = have + 1; n < last; n++) if (!all.has(n)) all.set(n, {});
  return all;
}

const SCORE_NEEDS_A_TRIAL = "no trial on file; score never runs the variant";

const started = (state: CaseState) =>
  state.stored.filter((s) => s.trial.case.digest === state.digest && s.trial.run.id !== undefined);

/** Whether two settings, as JSON, say the same thing, whatever order their keys are in. */
function sameSetting(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => sameSetting(a[key as keyof typeof a], b[key as keyof typeof b]))
  );
}

/** A score that passed its check, by this scorer on the key as it is now; the latest. */
export function passingScore(
  stored: Stored,
  scorerKey: string,
  keyRevision: number,
): ScoreOnFile | undefined {
  return stored.scores
    .filter(
      (score) =>
        keyOf(score.scorer) === scorerKey &&
        score.key.revision === keyRevision &&
        score.result.status === "scored",
    )
    .toSorted(newestFirst)[0];
}

const nothingToScore = (trial: Trial) =>
  trial.failure ?? (trial.findings.length === 0 ? "the trial found nothing" : undefined);

/**
 * Per chosen trial, `run`: a trial when the variant's version has fewer than n on the case's
 * digest, a score when this scorer has no passing score on the key's revision, otherwise reuse.
 * `score` never makes a trial; a trial it chose findings of gets a partial score over `restFrom`'s
 * passing score. A trial whose run failed is a result and is reused; one whose run never started,
 * and a failed score, are run again. A trial with nothing to score gets a score without a scorer's
 * run.
 */
export function planCases(
  states: readonly CaseState[],
  options: {
    command: "run" | "score";
    scorerKey: string;
    chosen: Chosen;
    restFromKey?: string;
  },
): Step[] {
  return states.flatMap((state) =>
    [...trialsOf(state, options.chosen.get(state.case), options.command)]
      .toSorted(([a], [b]) => a - b)
      .map(([n, choice]): Step => {
        const stored = currentTrial(state, n);
        if (options.command === "score" && choice.findings) {
          return planPartial(
            state,
            n,
            stored,
            choice.findings,
            options.scorerKey,
            options.restFromKey,
          );
        }
        if (!stored) {
          return options.command === "score"
            ? {
                case: state.case,
                n,
                trial: { do: "skip", why: whyNoTrial(state, SCORE_NEEDS_A_TRIAL, n) },
                score: { do: "skip", why: "nothing to score" },
              }
            : { case: state.case, n, trial: { do: "run" }, score: { do: "run" } };
        }
        const trial = { do: "reuse" as const, trial: stored.trial };
        const passed = passingScore(stored, options.scorerKey, state.keyRevision);
        if (passed) return { case: state.case, n, trial, score: { do: "reuse", score: passed } };
        const empty = nothingToScore(stored.trial);
        return {
          case: state.case,
          n,
          trial,
          score: empty ? { do: "record", why: empty } : { do: "run" },
        };
      }),
  );
}

/**
 * Chosen findings of a case's current trial, scored over the rest-from scorer's passing score on
 * this key, or the same partial score reused: the same scorer, rest-from score and asked findings.
 */
function planPartial(
  state: CaseState,
  n: number,
  stored: Stored | undefined,
  picked: readonly number[],
  scorerKey: string,
  restFromKey: string | undefined,
): Step {
  const at = n === 1 ? state.case : `${state.case}/${n}`;
  if (!stored) throw new PlanError(`${at}: ${whyNoTrial(state, SCORE_NEEDS_A_TRIAL, n)}`);
  if (restFromKey === undefined) throw new PlanError("chosen findings need a --rest-from scorer");
  const restFrom = passingScore(stored, restFromKey, state.keyRevision);
  if (restFrom?.result.status !== "scored") {
    throw new PlanError(
      `${at}: no passing score by the --rest-from scorer on key revision ${state.keyRevision}`,
    );
  }
  const count = stored.trial.findings.length;
  const past = picked.filter((index) => index >= count);
  if (past.length > 0) {
    throw new PlanError(
      `${at}: trial ${stored.trial.id} has ${count} findings, so no #${past.join(", #")}`,
    );
  }
  const trial = { do: "reuse" as const, trial: stored.trial };
  const asked = askedWith(picked, restFrom.result.judgement.labels);
  const reused = stored.partials
    .filter(
      (p) =>
        keyOf(p.scorer) === scorerKey &&
        p.key.revision === state.keyRevision &&
        p.restFrom.digest === restFrom.digest &&
        p.asked.join(",") === asked.join(",") &&
        p.result.status === "scored",
    )
    .toSorted(newestFirst)[0];
  if (reused) {
    return { case: state.case, n, trial, score: { do: "reuse-partial", record: reused, restFrom } };
  }
  return {
    case: state.case,
    n,
    trial,
    score: { do: "partial", picked: [...picked].sort((a, b) => a - b), asked, restFrom },
  };
}

/**
 * What the next step will cost, as the mean of earlier ones that were priced; null with no history,
 * so a budget stops on actual spend rather than a guess.
 */
export function estimateOf(estimates: readonly (number | undefined)[]): number | null {
  const priced = estimates.filter((estimate): estimate is number => estimate !== undefined);
  return priced.length === 0 ? null : priced.reduce((sum, x) => sum + x, 0) / priced.length;
}
