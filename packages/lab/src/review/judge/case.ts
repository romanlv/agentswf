import { join } from "node:path";
import type { OutputSchema } from "@agentswf/contract/workflow";
import Type from "typebox";
import { readCase } from "../fixtures/verify";
import type { AnswerKey, Fixture } from "../format/format";
import { type FindingLabel, FindingLabelSchema, type ReviewFinding } from "../format/scoring";
import { checkReviewFindings, describeProblems } from "../format/validate";

/** What a scorer judges: the case, its request and key, and the review's findings. */
export type JudgedCase = {
  fixture: Fixture;
  request: string;
  key: AnswerKey;
  findings: ReviewFinding[];
};

/** A scorer's inputs as awf-lab hands them over: `--fixture {dir} --findings {file}`. */
export async function readJudgedCase(
  fixtureDir: string,
  findingsFile: string,
): Promise<JudgedCase> {
  const { fixture, key } = await readCase(fixtureDir);
  const findings = checkReviewFindings(await Bun.file(findingsFile).json());
  if (!findings.ok) throw new Error(describeProblems(findingsFile, findings.problems));
  const request = await Bun.file(join(fixtureDir, "request.md")).text();
  return { fixture, request, key, findings: findings.value };
}

/** A voter's answer. The engine's answer schema has no `pattern`; every answer is checked in code. */
export type Answer = { labels: FindingLabel[]; missed: string };
export const ANSWER = JSON.parse(
  JSON.stringify(
    Type.Object(
      { labels: Type.Array(FindingLabelSchema), missed: Type.String() },
      { additionalProperties: false },
    ),
    (name, value) => (name === "pattern" ? undefined : value),
  ),
) as OutputSchema<Answer>;

/** The issues `labels` hit, by the finding that hit each, leaving out the findings in `except`. */
export function claimedIn(
  labels: readonly FindingLabel[],
  except: readonly number[] = [],
): Map<string, number> {
  return new Map(
    labels.flatMap((l) =>
      l.label === "hit" && !except.includes(l.finding) ? [[l.issue, l.finding] as const] : [],
    ),
  );
}

/** `--flag value` pairs, each known and given once. */
export function flagsOf(argv: readonly string[], known: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift()!;
    const value = rest.shift();
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`expected --flag value, got ${flag}`);
    }
    const name = flag.slice(2);
    if (!known.includes(name)) throw new Error(`unknown flag --${name}`);
    if (values.has(name)) throw new Error(`--${name} is given twice`);
    values.set(name, value);
  }
  return values;
}
