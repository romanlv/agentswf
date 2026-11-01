import { expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import lensReview, { FINDINGS, strictReview } from "./parallel";

const finding = (file: string, severity: "high" | "low") => ({
  findings: [{ file, severity, claim: `${file} is wrong` }],
});

test("results come back in item order, whichever lens finishes first", async () => {
  const testsAnswered = Promise.withResolvers<void>();
  const run = await testWorkflow(lensReview, null, {
    agents: {
      "review:security": answer(FINDINGS, async () => {
        await testsAnswered.promise;
        return finding("auth.ts", "low");
      }),
      "review:correctness": answer(FINDINGS, finding("sum.ts", "high")),
      "review:tests": answer(FINDINGS, () => {
        testsAnswered.resolve();
        return finding("sum.test.ts", "low");
      }),
    },
  });
  expect(run.value.findings.map(({ lens, file }) => [lens, file])).toEqual([
    ["correctness", "sum.ts"],
    ["security", "auth.ts"],
    ["tests", "sum.test.ts"],
  ]);
});

test("a lens that doesn't answer is recorded, and the others' findings are kept", async () => {
  const run = await testWorkflow(lensReview, null, {
    agents: {
      "review:security": reply.failed(),
      "review:*": answer(FINDINGS, finding("sum.ts", "low")),
    },
  });
  expect(run.value.findings.map(({ lens }) => lens)).toEqual(["correctness", "tests"]);
  expect(run.value.failed.map(({ lens }) => lens)).toEqual(["security"]);
});

test("a branch that throws cancels the turn still running, and parallel rejects", async () => {
  const run = await testWorkflow(strictReview, null, {
    agents: {
      "review:security": reply.failed(),
      // Answers only once its turn is cancelled, which is too late to count.
      "review:correctness": answer(
        FINDINGS,
        (turn) =>
          new Promise((resolve) =>
            turn.signal.addEventListener("abort", () => resolve(finding("sum.ts", "low"))),
          ),
      ),
      "review:tests": answer(FINDINGS, finding("sum.test.ts", "low")),
    },
  });
  expect(() => run.value).toThrow("security: failed");
  expect(run.turnsOf("review:correctness")[0]?.outcome).toBe("cancelled");
});
