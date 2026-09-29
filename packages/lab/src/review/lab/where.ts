import type { Score } from "../format/records";
import { LABELS } from "../format/scoring";
import { categoryOf } from "../judge/panel";
import type { Address } from "./address";
import type { Choice, Stored } from "./plan";

/**
 * `--where`: selection by stored result, read from one scorer's records. `failed` and `lost` hold
 * of a case; `split`, `label=` and `differs=` of findings.
 */
export type Predicate =
  | { kind: "failed" }
  | { kind: "lost" }
  | { kind: "split" }
  | { kind: "label"; label: string }
  | { kind: "differs"; scorer: string };

export const PREDICATES = "failed, split, label={label}, differs={scorer}, lost";

export function parsePredicate(text: string): Predicate {
  if (text === "failed" || text === "lost" || text === "split") return { kind: text };
  const [name, value] = [text.slice(0, text.indexOf("=")), text.slice(text.indexOf("=") + 1)];
  if (name === "label" && (LABELS as readonly string[]).includes(value)) {
    return { kind: "label", label: value };
  }
  if (name === "label") throw new Error(`--where label= takes one of ${LABELS.join(", ")}`);
  if (name === "differs" && value !== "") return { kind: "differs", scorer: value };
  throw new Error(`--where takes ${PREDICATES}, not ${text}`);
}

export function describePredicate(predicate: Predicate): string {
  switch (predicate.kind) {
    case "label":
      return `label=${predicate.label}`;
    case "differs":
      return `differs=${predicate.scorer}`;
    default:
      return predicate.kind;
  }
}

const aboutFindings = (p: Predicate) =>
  p.kind === "split" || p.kind === "label" || p.kind === "differs";

/** One case of one variant, as the predicates read it. */
export type CaseView = {
  case: string;
  /** The variant's current trial. */
  trial?: Stored;
  /** The reading scorer's passing score of it. */
  score?: Score;
  /** Each `differs=` scorer's passing score of it, by name. */
  others: ReadonlyMap<string, Score | undefined>;
  /** Whether the baseline did better on it, when a baseline was asked for. */
  lost?: boolean;
};

const labelsOf = (score: Score | undefined) =>
  score?.result.status === "scored" ? score.result.judgement.labels : undefined;

/** The findings a score's panel voters labelled differently. */
export function splitFindings(score: Score | undefined): number[] {
  if (score?.result.status !== "scored") return [];
  const panel = (score.result.judgement.votes ?? []).filter((vote) => vote.role === "panel");
  if (panel.length < 2) return [];
  return score.result.judgement.labels.flatMap(({ finding }) => {
    const said = new Set(
      panel.flatMap((vote) => {
        const label = vote.labels.find((l) => l.finding === finding);
        return label ? [categoryOf(label)] : [];
      }),
    );
    return said.size > 1 ? [finding] : [];
  });
}

function holds(predicate: Predicate, view: CaseView, finding: number): boolean {
  const mine = labelsOf(view.score)?.find((l) => l.finding === finding);
  switch (predicate.kind) {
    case "split":
      return splitFindings(view.score).includes(finding);
    case "label":
      return mine?.label === predicate.label;
    case "differs": {
      const theirs = labelsOf(view.others.get(predicate.scorer))?.find(
        (l) => l.finding === finding,
      );
      return mine !== undefined && theirs !== undefined && categoryOf(mine) !== categoryOf(theirs);
    }
    default:
      return false;
  }
}

function caseHolds(predicate: Predicate, view: CaseView): boolean {
  if (predicate.kind === "lost") return view.lost === true;
  if (predicate.kind === "failed") {
    return view.trial !== undefined && (view.trial.trial.failure !== undefined || !view.score);
  }
  return true;
}

/**
 * What `--only` and `--where` choose of one variant's cases, all of them holding: a case whole, or
 * chosen findings of its trial. An address names a case (`{case}`, `{case}/1`) or a finding; one
 * with another variant's prefix is not this variant's. A case a predicate about findings leaves
 * nothing of is not chosen. Absent both, every case is chosen whole.
 */
export function choose(options: {
  variant: string;
  cases: readonly CaseView[];
  only?: readonly Address[];
  where: readonly Predicate[];
}): Map<string, Choice> {
  const only = options.only?.filter(
    (a) => a.variant === undefined || a.variant === options.variant,
  );
  const byFindings = options.where.filter(aboutFindings);
  const chosen = new Map<string, Choice>();
  for (const view of options.cases) {
    const named = only?.filter((a) => a.case === view.case);
    if (named && named.length === 0) continue;
    if (!options.where.every((p) => caseHolds(p, view))) continue;
    const whole = !named || named.some((a) => a.finding === undefined);
    if (whole && byFindings.length === 0) {
      chosen.set(view.case, {});
      continue;
    }
    const candidates = whole
      ? (view.trial?.trial.findings.map((_, index) => index) ?? [])
      : [...new Set(named!.map((a) => a.finding!))].sort((a, b) => a - b);
    const findings = candidates.filter((f) => byFindings.every((p) => holds(p, view, f)));
    if (findings.length > 0) chosen.set(view.case, { findings });
  }
  return chosen;
}
