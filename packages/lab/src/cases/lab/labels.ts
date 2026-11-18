import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkSchema, describeProblems } from "../../shared/validate";
import { type LabelRecord, LabelRecordSchema } from "../format/records";
import { newestEntries, trialOutcome } from "./outcome";
import type { StoredTrial } from "./store";

// The person's labels: `{store}/labels/{dataset}.jsonl`, one line per label, newest last. They
// are on the trial, found by its workflow run's id, not on each criterion; a note says why.

export const labelsFileOf = (store: string, dataset: string) =>
  join(store, "labels", `${dataset}.jsonl`);

export function appendLabel(store: string, dataset: string, label: LabelRecord): void {
  const file = labelsFileOf(store, dataset);
  const checked = checkSchema(LabelRecordSchema, label);
  if (!checked.ok) throw new Error(describeProblems(file, checked.problems));
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(checked.value)}\n`);
}

function readLines(file: string): LabelRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        const checked = checkSchema(LabelRecordSchema, JSON.parse(line));
        return checked.ok ? [checked.value] : [];
      } catch {
        return [];
      }
    });
}

/** Each labeled trial's newest label, by its workflow run id; a cleared one is no label. */
export function readLabels(store: string, dataset: string): Map<string, LabelRecord> {
  const labels = new Map<string, LabelRecord>();
  const lines = readLines(labelsFileOf(store, dataset));
  // A stable sort: two labels made in the same instant keep the order they were written in.
  for (const line of [...lines].sort((x, y) => x.at.localeCompare(y.at))) {
    if (line.mark === "cleared") labels.delete(line.runId);
    else labels.set(line.runId, line);
  }
  return labels;
}

type Tally = { labeled: number; agreed: number };

/** How a grader, or the lab as a whole, agrees with the person's labels. */
export type Agreement = {
  /** Trials marked good, and how many the lab passed. */
  good: Tally;
  /** Trials marked needs-work, and how many the lab failed. */
  needsWork: Tally;
};

export type PersonAgreement = Agreement & {
  /** Labeled trials the lab neither passed nor failed: errored, undecided, by numbers alone. */
  notCompared: number;
  /** Each deciding grader's own agreement, the judge by its agent and version. */
  graders: (Agreement & { grader: string })[];
  disagreements: {
    case: string;
    column: number;
    trial: number;
    mark: "good" | "needs-work";
    note?: string;
    outcome: string;
  }[];
};

const tally = (): Agreement => ({
  good: { labeled: 0, agreed: 0 },
  needsWork: { labeled: 0, agreed: 0 },
});

function count(into: Agreement, mark: "good" | "needs-work", verdict: string | undefined) {
  const side = mark === "good" ? into.good : into.needsWork;
  side.labeled++;
  if (verdict === (mark === "good" ? "passed" : "failed")) side.agreed++;
}

/** A grader's name in agreement lines: the judge with its agent and `{major}.{minor}`. */
function graderName(entry: ReturnType<typeof newestEntries>[number]): string {
  if (!entry.agent) return entry.grader;
  const minor = entry.version?.split(".").slice(0, 2).join(".");
  return `${entry.grader} (${entry.agent.harness}/${entry.agent.model}${minor ? ` ${minor}` : ""})`;
}

/** The lab's agreement with the person on a set of trials, undefined when none is labeled. */
export function agreementOf(
  trials: readonly StoredTrial[],
  labels: ReadonlyMap<string, LabelRecord>,
  decidersOf: (name: string) => ReadonlySet<string> | undefined,
): PersonAgreement | undefined {
  const all = tally();
  const graders = new Map<string, Agreement>();
  const disagreements: PersonAgreement["disagreements"] = [];
  let notCompared = 0;
  for (const { record, scores } of trials) {
    const label = record.runId ? labels.get(record.runId) : undefined;
    if (!label || label.mark === "cleared") continue;
    const deciders = decidersOf(record.case);
    const { outcome } = trialOutcome(record, scores, deciders);
    if (outcome !== "passed" && outcome !== "failed") {
      notCompared++;
    } else {
      count(all, label.mark, outcome);
    }
    // Only a verdict can disagree: an errored or undecided trial is counted as not compared.
    if (
      (outcome === "passed" || outcome === "failed") &&
      (label.mark === "good") !== (outcome === "passed")
    ) {
      disagreements.push({
        case: record.case,
        column: record.column,
        trial: record.trial,
        mark: label.mark,
        ...(label.note ? { note: label.note } : {}),
        outcome,
      });
    }
    for (const entry of newestEntries(scores)) {
      if (deciders && !deciders.has(entry.grader)) continue;
      if (entry.skipped || entry.errored || !entry.verdict) continue;
      const name = graderName(entry);
      const into = graders.get(name) ?? tally();
      graders.set(name, into);
      count(into, label.mark, entry.verdict);
    }
  }
  if (all.good.labeled + all.needsWork.labeled + notCompared === 0) return undefined;
  return {
    ...all,
    notCompared,
    graders: [...graders].map(([grader, a]) => ({ grader, ...a })),
    disagreements,
  };
}

/** What clears the judge's "not checked against a person" mark. */
export const JUDGE_CHECK = { labeled: 10, needsWork: 3 } as const;

/**
 * The labeled trials the current judge graded, across the dataset's runs: one per workflow run,
 * counted when the newest criteria grade has this agent and `{major}.{minor}`.
 */
export function judgeLabeled(
  runs: readonly (readonly StoredTrial[])[],
  labels: ReadonlyMap<string, LabelRecord>,
  judge: { harness: string; model: string; minor: string },
): { labeled: number; needsWork: number } {
  const seen = new Map<string, LabelRecord>();
  for (const trials of runs) {
    for (const { record, scores } of trials) {
      const label = record.runId ? labels.get(record.runId) : undefined;
      if (!label || seen.has(record.runId!)) continue;
      const entry = newestEntries(scores).find((e) => e.grader === "criteria");
      if (!entry || entry.skipped || entry.errored || !entry.verdict) continue;
      const minor = entry.version?.split(".").slice(0, 2).join(".");
      if (
        entry.agent?.harness !== judge.harness ||
        entry.agent?.model !== judge.model ||
        minor !== judge.minor
      )
        continue;
      seen.set(record.runId!, label);
    }
  }
  const marks = [...seen.values()];
  return {
    labeled: marks.length,
    needsWork: marks.filter((l) => l.mark === "needs-work").length,
  };
}
