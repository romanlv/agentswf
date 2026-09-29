import type { PartialScore, Score, Trial } from "../format/records";
import type { FindingLabel } from "../format/scoring";
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
  stored: readonly Stored[];
};

/** Which findings of a case's trial a command chose; none named means the whole case. */
export type Choice = { findings?: readonly number[] };

export type Step = {
  case: string;
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
 * The trial a case's numbers come from: the latest one on this case's digest whose run started. A
 * run that never started (awf refused it, or no login) says nothing about the variant, so it is
 * run again rather than reused as a zero. One trial per case until variant-matrix-runner: this is
 * trial 1.
 */
export function currentTrial(state: CaseState): Stored | undefined {
  return state.stored
    .filter((s) => s.trial.case.digest === state.digest && s.trial.run.id !== undefined)
    .toSorted((a, b) => newestFirst(a.trial, b.trial))[0];
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
 * Per case, `run`: a trial when the variant's version has none on the case's digest, a score when
 * this scorer has no passing score on the key's revision, otherwise reuse. `score` never makes a
 * trial; a case it chose findings of gets a partial score over `restFrom`'s passing score. A trial
 * whose run failed is a result and is reused; one whose run never started, and a failed score,
 * are run again. A trial with nothing to score gets a score without a scorer's run.
 */
export function planCases(
  states: readonly CaseState[],
  options: {
    command: "run" | "score";
    scorerKey: string;
    chosen: ReadonlyMap<string, Choice>;
    restFromKey?: string;
  },
): Step[] {
  return states.map((state): Step => {
    const stored = currentTrial(state);
    const findings = options.chosen.get(state.case)?.findings;
    if (options.command === "score" && findings) {
      return planPartial(state, stored, findings, options.scorerKey, options.restFromKey);
    }
    if (!stored) {
      return options.command === "score"
        ? {
            case: state.case,
            trial: { do: "skip", why: "no trial on file; score never runs the variant" },
            score: { do: "skip", why: "nothing to score" },
          }
        : { case: state.case, trial: { do: "run" }, score: { do: "run" } };
    }
    const trial = { do: "reuse" as const, trial: stored.trial };
    const passed = passingScore(stored, options.scorerKey, state.keyRevision);
    if (passed) return { case: state.case, trial, score: { do: "reuse", score: passed } };
    const empty = nothingToScore(stored.trial);
    return {
      case: state.case,
      trial,
      score: empty ? { do: "record", why: empty } : { do: "run" },
    };
  });
}

/**
 * Chosen findings of a case's current trial, scored over the rest-from scorer's passing score on
 * this key, or the same partial score reused: the same scorer, rest-from score and asked findings.
 */
function planPartial(
  state: CaseState,
  stored: Stored | undefined,
  picked: readonly number[],
  scorerKey: string,
  restFromKey: string | undefined,
): Step {
  if (!stored) throw new PlanError(`${state.case}: no trial on file; score never runs the variant`);
  if (restFromKey === undefined) throw new PlanError("chosen findings need a --rest-from scorer");
  const restFrom = passingScore(stored, restFromKey, state.keyRevision);
  if (restFrom?.result.status !== "scored") {
    throw new PlanError(
      `${state.case}: no passing score by the --rest-from scorer on key revision ${state.keyRevision}`,
    );
  }
  const count = stored.trial.findings.length;
  const past = picked.filter((index) => index >= count);
  if (past.length > 0) {
    throw new PlanError(
      `${state.case}: trial ${stored.trial.id} has ${count} findings, so no #${past.join(", #")}`,
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
    return { case: state.case, trial, score: { do: "reuse-partial", record: reused, restFrom } };
  }
  return {
    case: state.case,
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
