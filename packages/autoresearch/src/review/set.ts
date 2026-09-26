import type { AnswerKey, Fixture, FixtureSet } from "./format";

export const SET_FILE = "set.json";

export function fixtureId(project: string, number: number): string {
  return `${project.split("/").at(-1)!.toLowerCase()}-${number}`;
}

/**
 * Why a checked fixture stays out of a set, or null when it belongs in one: a merged MR whose key
 * has at least two must-fix or should-fix problems the MR itself caused.
 */
export function leftOut(fixture: Fixture, key: AnswerKey | undefined): string | null {
  if (fixture.source.state !== "merged") return `${fixture.source.state}, not merged`;
  if (!key) return "no answer key";
  const serious = key.issues.filter(
    (issue) =>
      issue.scope === "change" &&
      (issue.severity === "must-fix" || issue.severity === "should-fix"),
  ).length;
  return serious < 2
    ? `${serious} must-fix or should-fix problem(s) the MR caused; a set needs two`
    : null;
}

/**
 * What a fixture's digest is taken over: all of `fixture.json` (the MR, its URL and state, and the
 * frozen head) and the request exactly as the reviewer reads it. The frozen code is covered by its
 * head, which pins the tree and its history and which the checker proves the bundle restores to,
 * so rebundling the same commits keeps the digest. The key is not covered: it grows, and a score
 * records its revision separately. This definition is part of `awf.fixture-set/1`; changing what
 * it covers needs a new set format.
 */
export function digestInput(fixture: Fixture, request: string): string {
  return canonicalJson({ fixture, request });
}

/** JSON with every object's keys sorted, so the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

type Excluded = FixtureSet["excluded"][number];

/** Every exclusion once, an earlier list's reason winning, in MR order. */
export function mergeExcluded(...lists: Excluded[][]): Excluded[] {
  const byMr = new Map<string, Excluded>();
  for (const entry of lists.flat()) {
    const mr = `${entry.project}!${entry.number}`;
    if (!byMr.has(mr)) byMr.set(mr, entry);
  }
  return [...byMr.values()].sort((a, b) =>
    a.project < b.project ? -1 : a.project > b.project ? 1 : a.number - b.number,
  );
}
