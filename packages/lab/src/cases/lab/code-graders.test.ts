import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeGraders } from "./code-graders";
import type { DatasetInfo } from "./dataset";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The helper checks the export's kind, not where `defineGrader` came from, so these files need
// no linked lab.
const GRADERS = `
const kind = "awf.case-grader/0";
export const sees = {
  kind,
  readsFacts: false,
  grade: (input) => ({
    verdict: "passed",
    reasons: [{ about: "input", text: JSON.stringify(Object.keys(input).sort()) + " " + input.case.name + " " + process.cwd() }],
  }),
};
export const facts = {
  kind,
  readsFacts: true,
  grade: ({ facts, stages }) => ({
    verdict: facts.n === 2 ? "passed" : "failed",
    numbers: { hits: { count: facts.n, of: 3 } },
    reasons: [{ about: "stages", text: JSON.stringify(stages) }],
  }),
};
export const skips = { kind, readsFacts: false, grade: () => ({ notApplies: "no refund" }) };
export const throws = { kind, readsFacts: false, grade: () => { throw new Error("no order.json"); } };
export const wrong = { kind, readsFacts: false, grade: () => ({ verdict: "maybe" }) };
export const slow = { kind, readsFacts: false, grade: () => new Promise(() => setInterval(() => {}, 1000)) };
export const plain = () => ({ verdict: "passed" });
export const forgot = { kind, readsFacts: false, grade: () => {} };
export const both = { kind, readsFacts: false, grade: () => ({ verdict: "failed", notApplies: "n/a" }) };
export const lingers = {
  kind,
  readsFacts: false,
  grade: () => {
    Bun.spawn(["sleep", "20"], { stderr: "inherit", stdout: "inherit" });
    return new Promise(() => setInterval(() => {}, 1000));
  },
};
`;

function setup(names: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "code-graders-")));
  roots.push(root);
  const dir = join(root, "evals", "set");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "graders.ts"), GRADERS);
  const trial = join(root, "trial");
  mkdirSync(join(trial, "scratch"), { recursive: true });
  mkdirSync(join(trial, "case"), { recursive: true });
  const dataset = {
    name: "set",
    dir,
    dataset: { graders: names },
  } as unknown as DatasetInfo;
  return { root, dataset, trial };
}

const input = (trial: string) => ({
  case: {
    name: "one",
    dir: join(trial, "case"),
    input: {},
    key: { kind: "awf.case-key/0" as const },
  },
  facts: { n: 2 },
  stages: { read: { ok: true } },
  result: { done: true },
  scratch: join(trial, "scratch"),
  kept: join(trial, "kept"),
  work: trial,
  env: { ...(process.env as Record<string, string>) },
});

describe("a dataset's own graders, run in a process of their own", () => {
  test("a grader is given the case, the result and the scratch folder, in the checkout", async () => {
    const { root, dataset, trial } = setup(["sees"]);
    const [grader] = codeGraders(dataset, root, 30_000);
    const out = await grader!.grade(input(trial));
    expect(out.verdict).toBe("passed");
    expect(out.reasons[0]!.text).toBe(`["case","kept","result","scratch"] one ${root}`);
  });

  test("readsFacts gives the facts and the stages; numbers come back", async () => {
    const { root, dataset, trial } = setup(["facts"]);
    const out = await codeGraders(dataset, root, 30_000)[0]!.grade(input(trial));
    expect(out).toEqual({
      verdict: "passed",
      numbers: { hits: { count: 2, of: 3 } },
      reasons: [{ about: "stages", text: '{"read":{"ok":true}}' }],
    });
  });

  test("a grader that doesn't apply says why", async () => {
    const { root, dataset, trial } = setup(["skips"]);
    const out = await codeGraders(dataset, root, 30_000)[0]!.grade(input(trial));
    expect(out).toEqual({ notApplies: "no refund", reasons: [] });
  });

  test("a throw, a wrong answer, a missing export or a hang errors the grade", async () => {
    const { root, dataset, trial } = setup([
      "throws",
      "wrong",
      "absent",
      "plain",
      "slow",
      "forgot",
      "both",
    ]);
    const graders = codeGraders(dataset, root, 2_000);
    const reasons = await Promise.all(
      graders.map((g) =>
        g.grade(input(trial)).then(
          () => "graded",
          (error: Error) => error.message,
        ),
      ),
    );
    expect(reasons[0]).toBe("no order.json");
    expect(reasons[1]).toContain("grader wrong's answer");
    expect(reasons[2]).toContain("exports no grader absent");
    expect(reasons[3]).toContain("exports no grader plain");
    expect(reasons[4]).toBe("grader slow took longer than 2s");
    expect(reasons[5]).toContain("gave no verdict, numbers or notApplies");
    expect(reasons[6]).toContain("notApplies with a verdict or numbers");
  });

  test("a grader whose own child outlives the kill doesn't hold the lab", async () => {
    const { root, dataset, trial } = setup(["lingers"]);
    const started = Date.now();
    const error = await codeGraders(dataset, root, 1_000)[0]!
      .grade(input(trial))
      .catch((e) => e);
    expect((error as Error).message).toBe("grader lingers took longer than 1s");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the code digest changes with graders.ts", () => {
    const { root, dataset } = setup(["sees"]);
    const before = codeGraders(dataset, root, 1_000)[0]!.code!();
    writeFileSync(join(dataset.dir, "graders.ts"), `${GRADERS}\n// edited\n`);
    expect(codeGraders(dataset, root, 1_000)[0]!.code!()).not.toBe(before);
  });
});
