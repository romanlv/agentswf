import { expect, test } from "bun:test";
import { answer, noAnswer, testWorkflow } from "agentswf/testing";
import shipTicket, { BUILT, PLAN } from "./runs";

const args = { ticket: "ABC-1" };
const plan = { doc: "docs/ABC-1.md" };
const built = { branch: "abc-1", summary: "built" };

test("a builder that never answers stops the attempt in build, with plan recorded", async () => {
  const run = await testWorkflow(shipTicket, {
    args,
    agents: { planner: answer(PLAN, plan), builder: noAnswer.silent() },
  });
  expect(run.ending).toMatchObject({ kind: "stopped", stage: "build" });
  expect(run.stages.map(({ name, outcome }) => [name, outcome])).toEqual([
    ["plan", "succeeded"],
    ["build", "stopped"],
  ]);
});

test("a continue reuses plan without opening the planner, and runs build", async () => {
  const run = await testWorkflow(shipTicket, {
    args,
    earlier: { stages: { plan } },
    agents: { builder: answer(BUILT, built) },
  });
  expect(run.value).toEqual(built);
  expect(run.agents.map(({ key }) => key)).toEqual(["builder"]);
  expect(run.turnsOf("builder")[0]!.prompt).toContain("docs/ABC-1.md");
  expect(run.stages.map(({ name, attempt }) => [name, attempt])).toEqual([
    ["plan", 1],
    ["build", 2],
  ]);
});

test("--from-stage build with no plan recorded stops, naming the value it needs", async () => {
  const run = await testWorkflow(shipTicket, {
    args,
    fromStage: "build",
    agents: {},
  });
  expect(run.ending).toMatchObject({
    kind: "stopped",
    stage: "plan",
    needs: [expect.objectContaining({ stage: "plan" })],
    continue: expect.stringContaining("--from-stage build --values {file}"),
  });
});

test("--from-stage build with --values starts at build, the plan provided", async () => {
  const run = await testWorkflow(shipTicket, {
    args,
    fromStage: "build",
    values: { plan },
    agents: { builder: answer(BUILT, built) },
  });
  expect(run.value).toEqual(built);
  expect(run.turnsOf("planner")).toEqual([]);
});
