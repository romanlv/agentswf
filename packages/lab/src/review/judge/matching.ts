import type { AnswerKey } from "../format/format";
import type { FindingLabel, ReviewFinding } from "../format/scoring";

// Match first: what Jev is asked about each finding, and how its answers become labels. Pure, so a
// script can re-settle stored answers at another cut without asking Jev again.

export const KNOWN_QUESTION =
  "Which of these does `finding` state? A known problem matches only when the finding gives its mechanism: what goes wrong and why. The same symptom, place or consequence with a different or missing cause does not match. A claim matches when the finding asserts it.";
export const EARLIER_QUESTION = "Which earlier finding makes the same point as `finding`?";

/** Everything the key already knows, by option name: K issues, R refuted claims, X unsettled claims. */
export function knownOptions(key: AnswerKey): Record<string, string> {
  const options: Record<string, string> = {};
  for (const issue of key.issues) options[issue.id] = `A known problem: ${issue.mechanism}`;
  for (const claim of key.refuted) options[claim.id] = `A claim known to be false: ${claim.claim}`;
  key.excluded.forEach((exclusion, index) => {
    if (exclusion.reason === "unconfirmed") {
      options[`X${index}`] = `A claim nobody could settle: ${exclusion.claim}`;
    }
  });
  options.noise =
    "Nothing concrete to check: a note about the diff, a question, praise, a matter of taste, or the code restated.";
  options.none = "None of these: a concrete claim about something else.";
  return options;
}

export function earlierOptions(
  findings: readonly ReviewFinding[],
  index: number,
): Record<string, string> {
  return Object.fromEntries([
    ...findings.slice(0, index).map((f, i) => [`F${i}`, f.text] as const),
    ["none", "None of them: it makes a different point."] as const,
  ]);
}

/** Jev's answers for one finding: each question's whole distribution. */
export type Matched = { known: Record<string, number>; earlier: Record<string, number> };

export type Settlement = {
  /** Findings the match settles, by index. */
  settled: Map<number, FindingLabel>;
  /** The rest, for a voter with the code; a sure refuted claim is among them, needing a read. */
  left: { finding: number; why: string }[];
  /** Each issue hit, by the finding that hit it. */
  hitBy: Map<string, number>;
};

const top = (dist: Record<string, number>) =>
  Object.entries(dist).reduce<[string, number]>(
    (best, entry) => (entry[1] > best[1] ? entry : best),
    ["none", 0],
  );

/**
 * A sure answer (p at or above `sure`) settles a finding: a known issue is a hit for the earliest
 * finding that surely gives it and a duplicate for a later one, unless it is contested; an
 * unsettled claim is `unsettled`; noise is noise, as whether a finding is vague is a matter of its
 * text, which is what Jev reads; a finding that surely matches nothing known, or is surely noise,
 * is a duplicate of an earlier finding it surely repeats. Everything else is left, a refuted claim
 * too: a claim is shown false only in the code, so only a voter who read it labels one `wrong`. The earlier-finding question alone never overrides a known
 * item, which in round one called findings nearer an unsettled claim duplicates.
 */
export function settleMatches(
  matched: readonly Matched[],
  key: AnswerKey,
  sure: number,
): Settlement {
  const issues = new Set(key.issues.map((issue) => issue.id));
  const picks = matched.map((m, index) => ({
    index,
    known: top(m.known),
    earlier: index > 0 ? top(m.earlier) : undefined,
  }));
  // An issue some finding points at unsurely before the first sure one is contested: the earlier
  // finding may be the one that hits it, which only a voter with the code can say. Its findings are
  // all left, and it is not claimed, so a voter can still give the hit to the earliest.
  const hitBy = new Map<string, number>();
  const contested = new Set<string>();
  for (const { index, known } of picks) {
    if (!issues.has(known[0]) || hitBy.has(known[0]) || contested.has(known[0])) continue;
    if (known[1] >= sure) hitBy.set(known[0], index);
    else contested.add(known[0]);
  }
  const settled = new Map<number, FindingLabel>();
  const left: Settlement["left"] = [];
  for (const { index, known, earlier } of picks) {
    const why = `Jev: ${known[0]} p ${known[1].toFixed(2)}${earlier ? `; earlier ${earlier[0]} p ${earlier[1].toFixed(2)}` : ""}`;
    const base = { finding: index, why, read: [] };
    const isSure = known[1] >= sure;
    if (isSure && hitBy.has(known[0])) {
      const first = hitBy.get(known[0])!;
      settled.set(
        index,
        first === index
          ? { ...base, label: "hit", issue: known[0] }
          : { ...base, label: "duplicate", of: first },
      );
    } else if (isSure && known[0].startsWith("X")) {
      settled.set(index, { ...base, label: "unsettled", excluded: Number(known[0].slice(1)) });
    } else if (
      isSure &&
      (known[0] === "none" || known[0] === "noise") &&
      earlier &&
      earlier[0] !== "none" &&
      earlier[1] >= sure
    ) {
      settled.set(index, { ...base, label: "duplicate", of: Number(earlier[0].slice(1)) });
    } else if (isSure && known[0] === "noise") {
      settled.set(index, { ...base, label: "noise" });
    } else left.push({ finding: index, why });
  }
  return { settled, left, hitBy };
}
