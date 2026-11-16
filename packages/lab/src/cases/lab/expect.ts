import type { Fact } from "../format/settings";

export type ExpectResult =
  | { verdict: "passed" | "failed"; reasons: { about: string; text: string }[] }
  | { errored: "facts-missing" | "fact-type"; reason: string };

const show = (value: Fact) => JSON.stringify(value);

/**
 * The built-in `expect` grader: every fact the key names equals the key's value exactly. A fact the
 * key names that `observe` didn't return, or values of two types neither `null`, is a wiring mistake
 * and the dataset's; `null` against a value, either way, is the workflow's fail.
 */
export function gradeExpect(
  expected: Readonly<Record<string, Fact>>,
  facts: Readonly<Record<string, Fact>>,
): ExpectResult {
  const missing = Object.keys(expected).filter((name) => !Object.hasOwn(facts, name));
  if (missing.length > 0) {
    return {
      errored: "facts-missing",
      reason: `observe returned no ${missing.join(", ")}, which the key's expect names`,
    };
  }
  const reasons: { about: string; text: string }[] = [];
  for (const [name, want] of Object.entries(expected)) {
    const got = facts[name] as Fact;
    if (got === want) continue;
    if (got !== null && want !== null && typeof got !== typeof want) {
      return {
        errored: "fact-type",
        reason: `${name} is ${typeof got} ${show(got)}, the key wants ${typeof want} ${show(want)}`,
      };
    }
    reasons.push({ about: name, text: `${name} is ${show(got)}, the key wants ${show(want)}` });
  }
  return { verdict: reasons.length === 0 ? "passed" : "failed", reasons };
}
