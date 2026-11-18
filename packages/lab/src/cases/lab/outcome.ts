import type { Errored, GraderEntry, Outcome, ScoreRecord, TrialRecord } from "../format/records";
import { type CaseTally, type CaseVerdict, caseVerdict, isBroken, outcomeOf } from "./verdict";

/** The voters a judge's agent gives, 3 when it says none. */
export const votersOf = (agent: { voters?: number } | undefined) => agent?.voters ?? 3;

/** The name a judge graded beside the deciding one is read under: by its agent and voters. */
export const besideName = (agent: { harness: string; model: string; voters?: number }) =>
  `criteria (${agent.harness}/${agent.model} ×${votersOf(agent)})`;

/** The grader an entry is read as: its own name, or a beside judge's by its agent. */
export const entryName = (entry: GraderEntry) =>
  entry.beside && entry.agent ? besideName(entry.agent) : entry.grader;

/** Each grader's newest entry across a trial's scores, a beside judge as a grader of its own. */
export function newestEntries(scores: readonly ScoreRecord[]): GraderEntry[] {
  const byGrader = new Map<string, GraderEntry>();
  for (const score of scores) {
    for (const entry of score.entries) byGrader.set(entryName(entry), entry);
  }
  return [...byGrader.values()];
}

export type TrialView = { outcome: Outcome; errored?: Pick<Errored, "by" | "reason"> };

/**
 * The newest grades that decide: those of `deciders`, the graders the current dataset and key
 * name; every grade when they can't be read.
 */
export function decidingEntries(
  scores: readonly ScoreRecord[],
  deciders: ReadonlySet<string> | undefined,
): GraderEntry[] {
  return newestEntries(scores).filter((e) => !e.beside && (!deciders || deciders.has(e.grader)));
}

/** A trial's outcome, from its record and its deciding graders' newest entries. */
export function trialOutcome(
  trial: TrialRecord,
  scores: readonly ScoreRecord[],
  deciders?: ReadonlySet<string>,
): TrialView {
  const entries = decidingEntries(scores, deciders).filter((e) => !e.skipped);
  const broken = entries.find((e) => e.errored);
  const errored =
    trial.errored ??
    (broken ? { by: "grading" as const, reason: broken.errored!.reason } : undefined);
  const applies = entries.filter((e) => !e.notApplies && !e.errored);
  const outcome = outcomeOf({
    leaked: trial.leaked,
    ...(errored ? { errored } : {}),
    workflowErred: trial.workflowError !== undefined,
    stopped: trial.stopped !== undefined,
    verdicts: applies.flatMap((e) => (e.verdict ? [e.verdict] : [])),
    numbers: applies.some((e) => e.numbers && Object.keys(e.numbers).length > 0),
    notGraded: applies.length === 0,
  });
  return { outcome, ...(errored ? { errored } : {}) };
}

export type StoredTrialView = { record: TrialRecord; scores: readonly ScoreRecord[] };

export type CaseRow = {
  name: string;
  tally: CaseTally;
  knownFailing: boolean;
  brokenTrial: boolean;
  /** A trial errored by the lab: exit 4. */
  labTrial: boolean;
  outcomes: Outcome[];
  /** What kept the rest from passing: the first trial not passed, and why. */
  why?: string;
  /** Unused mocks and stages never reached, for a case that passed. */
  notes: string[];
  history: CaseVerdict[];
};

/** Why a trial didn't pass, in a line. */
export function whyNot(trial: StoredTrialView, deciders?: ReadonlySet<string>): string | undefined {
  const { record } = trial;
  const view = trialOutcome(record, trial.scores, deciders);
  switch (view.outcome) {
    case "passed":
    case "graded by numbers":
    case "not graded":
      return undefined;
    case "leaked":
      return "leaked: the key turned up where the workflow ran";
    case "errored":
      return `errored by ${view.errored?.by}${record.errored?.code ? ` (${record.errored.code})` : ""}: ${view.errored?.reason}`;
    case "stopped":
      return `stopped: ${record.stopped}`;
    default: {
      if (record.workflowError !== undefined)
        return `failed: the workflow erred: ${record.workflowError}`;
      const entries = decidingEntries(trial.scores, deciders);
      const failing = entries.find((e) => e.verdict === view.outcome) ?? entries[0];
      const reason = failing?.reasons[0];
      return reason ? `${failing.grader}: ${reason.text}` : view.outcome;
    }
  }
}

export function caseRow(
  name: string,
  trials: readonly StoredTrialView[],
  asked: number,
  pass: string,
  knownFailing: boolean,
  history: CaseVerdict[],
  deciders?: ReadonlySet<string>,
): CaseRow {
  const views = trials.map((t) => trialOutcome(t.record, t.scores, deciders));
  const outcomes = views.map((v) => v.outcome);
  const tally = caseVerdict(outcomes, asked, pass);
  const firstNot = trials.find((t, i) => views[i]!.outcome !== "passed" && whyNot(t, deciders));
  const notes = [
    ...new Set(
      trials.flatMap((t) => [
        ...t.record.unused.map((u) => `${u} was faked but never called`),
        ...(t.record.neverReached ?? []).map((stage) => `never reached ${stage}`),
      ]),
    ),
  ];
  return {
    name,
    tally,
    knownFailing,
    brokenTrial: views.some((v) => isBroken(v.outcome, v.errored)),
    labTrial: views.some((v) => v.outcome === "errored" && v.errored?.by === "lab"),
    outcomes,
    ...(firstNot ? { why: whyNot(firstNot, deciders)! } : {}),
    notes,
    history,
  };
}
