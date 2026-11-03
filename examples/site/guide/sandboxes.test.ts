import { expect, test } from "bun:test";
import { answer, testWorkflow } from "agentswf/testing";
import fixTests, { DONE, VERDICT } from "./sandboxes";

test("the coder and the tester share one sandbox; the reviewer has a private reader", async () => {
  const run = await testWorkflow(fixTests, null, {
    agents: {
      coder: answer(DONE, { summary: "fixed the date parser" }),
      tester: answer(DONE, { summary: "all pass" }),
      reviewer: answer(VERDICT, { verdict: "approve" }),
    },
  });
  expect(run.value).toEqual({ tests: "all pass", verdict: "approve" });

  const coder = run.agentOf("coder").sandbox!;
  expect(run.agentOf("tester").sandbox).toEqual(coder);
  expect(coder).toMatchObject({ key: "work", provider: "srt" });
  expect(coder.spec.write).toEqual([coder.spec.cwd]);
  expect(coder.domains).toContain("registry.npmjs.org");

  const reviewer = run.agentOf("reviewer").sandbox!;
  expect(reviewer).toMatchObject({ key: "agent:reviewer", provider: "srt" });
  expect(reviewer.spec).toMatchObject({ read: [], write: [], network: [] });
  expect(reviewer.domains).not.toContain("registry.npmjs.org");
});
