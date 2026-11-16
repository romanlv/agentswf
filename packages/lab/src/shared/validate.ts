import type Type from "typebox";
import { Check, Errors } from "typebox/value";

export type Problem = { path: string; message: string };

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: Problem[] };

/** Checks a value against a schema, each problem once. */
export function checkSchema<S extends Type.TSchema>(
  schema: S,
  value: unknown,
): Checked<Type.Static<S>> {
  if (Check(schema, value)) return { ok: true, value };
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const error of Errors(schema, value)) {
    const problem = { path: error.instancePath || "/", message: error.message };
    const key = `${problem.path} ${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(problem);
  }
  return { ok: false, problems };
}

export function describeProblems(file: string, problems: Problem[]): string {
  return [`${file} is not valid:`, ...problems.map((p) => `  ${p.path}: ${p.message}`)].join("\n");
}
