import type { FindingLabel, Judgement } from "../format/scoring";

export type Vote = Judgement extends { votes?: (infer V)[] } ? V : never;

/** What two labels must share to agree: the label, and for a hit the issue. */
export function categoryOf(label: FindingLabel): string {
  return label.label === "hit" ? `hit:${label.issue}` : label.label;
}

/** The findings two full votes label differently. */
export function disputed(a: readonly FindingLabel[], b: readonly FindingLabel[]): number[] {
  return a.flatMap((label, index) =>
    b[index] && categoryOf(label) === categoryOf(b[index]) ? [] : [index],
  );
}

/**
 * The panel's labels: where its two voters agree, theirs; where they don't, the tiebreak's side,
 * and where it sides with neither or gave no valid vote, `unsettled`, counted apart.
 */
export function settle(a: Vote, b: Vote, tiebreak: Vote | undefined): FindingLabel[] {
  const third = new Map((tiebreak?.labels ?? []).map((label) => [label.finding, label]));
  return a.labels.map((first, index) => {
    const second = b.labels[index]!;
    if (categoryOf(first) === categoryOf(second)) return first;
    const deciding = third.get(index);
    if (deciding && categoryOf(deciding) === categoryOf(first)) return first;
    if (deciding && categoryOf(deciding) === categoryOf(second)) return second;
    const said = [first, second, ...(deciding ? [deciding] : [])]
      .map((label, which) => `${[a, b, tiebreak][which]!.by} ${categoryOf(label)}`)
      .join(", ");
    return { finding: index, label: "unsettled", why: `the judges split: ${said}`, read: [] };
  });
}
