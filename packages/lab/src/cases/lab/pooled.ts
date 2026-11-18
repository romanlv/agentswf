import type { GraderEntry } from "../format/records";
import { entryName, newestEntries, type StoredTrialView } from "./outcome";

/** One number pooled over a column's trials: counts summed, or values, shown as a median. */
export type Pooled = { count: number; of: number } | { values: number[] };

export type PooledNumbers = {
  /** By grader, then by number. */
  graders: Map<string, Map<string, Pooled>>;
  /** Trials left out because the workflow failed them: they gave no numbers to pool. */
  left: number;
};

const usable = (e: GraderEntry) => !e.errored && !e.skipped && !e.notApplies;

/**
 * Each grader's numbers, pooled over the trials given. A trial the workflow failed (its body
 * erred, it stopped) is left out and counted; a grader that errored, was skipped or does not
 * apply adds nothing.
 */
export function poolNumbers(trials: readonly StoredTrialView[]): PooledNumbers {
  const graders = new Map<string, Map<string, Pooled>>();
  let left = 0;
  for (const trial of trials) {
    if (trial.record.workflowError !== undefined || trial.record.stopped !== undefined) {
      left++;
      continue;
    }
    for (const entry of newestEntries(trial.scores).filter(usable)) {
      for (const [name, number] of Object.entries(entry.numbers ?? {})) {
        const byName = graders.get(entryName(entry)) ?? new Map<string, Pooled>();
        graders.set(entryName(entry), byName);
        const was = byName.get(name);
        if ("count" in number) {
          const sum = was && "count" in was ? was : { count: 0, of: 0 };
          byName.set(name, { count: sum.count + number.count, of: sum.of + number.of });
        } else {
          byName.set(name, {
            values: [...(was && "values" in was ? was.values : []), number.value],
          });
        }
      }
    }
  }
  return { graders, left };
}

export type Agreement = {
  a: string;
  b: string;
  /** Trials both gave a verdict on, and on how many the verdicts were the same. */
  verdicts: { alike: number; of: number };
  /** Parts both judged, matched by `about`, and how many got the same label or verdict. */
  parts: { alike: number; of: number };
};

/**
 * How often two graders of the same thing agreed on the same trials: their verdicts, and their
 * parts' labels or verdicts matched by `about`. Shown for two graders that judged the same parts,
 * and for a grader set aside (on demand, or no longer deciding) against each deciding grader but
 * `expect`: a second judge tried beside the first. `expect` beside a tone grader agrees by chance.
 */
export function agreements(
  trials: readonly StoredTrialView[],
  decidersOf: (caseName: string) => ReadonlySet<string> | undefined = () => undefined,
): Agreement[] {
  const pairs = new Map<string, Agreement & { aside: boolean }>();
  for (const trial of trials) {
    const deciders = decidersOf(trial.record.case);
    const entries = newestEntries(trial.scores).filter(usable);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [a, b] = [entries[i]!, entries[j]!].sort((x, y) =>
          entryName(x).localeCompare(entryName(y)),
        );
        const id = `${entryName(a!)}\0${entryName(b!)}`;
        const pair = pairs.get(id) ?? {
          a: entryName(a!),
          b: entryName(b!),
          verdicts: { alike: 0, of: 0 },
          parts: { alike: 0, of: 0 },
          aside: false,
        };
        pairs.set(id, pair);
        if (deciders) {
          const decides = (g: string) => deciders.has(g);
          const oneAside =
            (!decides(entryName(a!)) && decides(entryName(b!)) && entryName(b!) !== "expect") ||
            (!decides(entryName(b!)) && decides(entryName(a!)) && entryName(a!) !== "expect");
          if (oneAside) pair.aside = true;
        }
        if (a!.verdict && b!.verdict) {
          pair.verdicts.of++;
          if (a!.verdict === b!.verdict) pair.verdicts.alike++;
        }
        const theirs = new Map((b!.parts ?? []).map((p) => [p.about, p.label ?? p.verdict]));
        for (const part of a!.parts ?? []) {
          if (!theirs.has(part.about)) continue;
          pair.parts.of++;
          if (theirs.get(part.about) === (part.label ?? part.verdict)) pair.parts.alike++;
        }
      }
    }
  }
  return [...pairs.values()]
    .filter((p) => p.parts.of > 0 || (p.aside && p.verdicts.of > 0))
    .map(({ aside: _, ...pair }) => pair);
}
