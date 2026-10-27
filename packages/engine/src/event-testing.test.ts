import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { caseRun, startCase } from "./testing";
import { answer, testWorkflow } from "./workflow-testing";

/** The sketch's shape, cut down: replies are pending until a turn is given them. */
const replying = caseRun(async (workflow) => {
  const thread = await workflow.participants.connect({ key: "thread", to: "code" });
  const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
  const pending: string[] = [];
  let first = true;
  for (;;) {
    for (const e of await workflow.receive({ label: investigator.turn ? "investigating" : "idle" }))
      if (thread.replied(e)) pending.push(`${e.data.author}: ${e.data.text}`);
    if (!investigator.turn && (first || pending.length > 0)) {
      first = false;
      await investigator.start({ prompt: `Look. Replies: ${pending.splice(0).join("; ")}` });
    }
  }
});

test("a reply scripted during a turn is taken at the next wait and given to the turn after", async () => {
  const run = await testWorkflow(replying, {
    ...startCase,
    agents: { investigator: answer("case.md updated") },
    events: [
      {
        during: "investigator#1",
        name: "participant:reply",
        from: "thread",
        data: { text: "is it the unique index?" },
      },
    ],
  });
  expect(run.parked).toBeDefined();
  expect(run.turnsOf("investigator").map((turn) => turn.prompt)).toEqual([
    "Look. Replies: ",
    "Look. Replies: engineer: is it the unique index?",
  ]);
});

test("files are laid out before the run, under its directory", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      return readFileSync(join(workflow.cwd, "cases", "k", "case.md"), "utf8");
    }),
    { ...startCase, files: { cases: { k: { "case.md": "# kombo\n" } } } },
  );
  expect(run.value).toBe("# kombo\n");
});

test("a run that starts more turns than maxTurns fails the test instead of hanging it", async () => {
  await expect(
    testWorkflow(
      caseRun(async (workflow) => {
        const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
        // A retry time always passed: it never parks, a turn after every wait.
        for (;;) {
          await workflow.receive({ until: 0 });
          await agent.run({ prompt: "again" });
        }
      }),
      { ...startCase, maxTurns: 3, agents: { investigator: answer("again") } },
    ),
  ).rejects.toThrow("more than 3 turns");
});

test("a scripted event whose turn never ran fails the test", async () => {
  await expect(
    testWorkflow(
      caseRun(async (workflow) => {
        await workflow.receive();
        return null;
      }),
      {
        ...startCase,
        events: [{ during: "investigator#1", name: "dd.changes", data: { case: "k" } }],
      },
    ),
  ).rejects.toThrow("during investigator#1 was never sent");
});

test("a scripted own event is checked against its schema", async () => {
  await expect(
    testWorkflow(
      caseRun(async () => null),
      {
        ...startCase,
        // biome-ignore lint/suspicious/noExplicitAny: data a test without tsc could give.
        events: [{ during: "a#1", name: "dd.changes", data: { other: 1 } as any }],
      },
    ),
  ).rejects.toThrow("does not fit its schema");
});

test("events due at one turn arrive in the order given, an own event from the operator", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.participants.connect({ key: "thread", to: "code" });
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      await workflow.receive();
      await agent.start({ prompt: "look" });
      const seen: string[] = [];
      for (;;)
        for (const e of await workflow.receive()) {
          seen.push(`${e.name} from ${e.from}`);
          if (agent.ended(e)) return seen;
        }
    }),
    {
      ...startCase,
      agents: { investigator: answer("done") },
      events: [
        { during: "investigator#1", name: "dd.changes", data: { case: "k" }, id: "c2" },
        {
          during: "investigator#1",
          name: "participant:reply",
          from: "thread",
          data: { text: "hi" },
        },
      ],
    },
  );
  expect(run.value).toEqual([
    "dd.changes from operator",
    "participant:reply from thread",
    "agent:ended from investigator",
  ]);
});

test("files outside the run's directory, and an id given twice, are refused", async () => {
  await expect(
    testWorkflow(
      caseRun(async () => null),
      { ...startCase, files: { "/tmp/elsewhere.md": "x" } },
    ),
  ).rejects.toThrow("is outside it");
  await expect(
    testWorkflow(
      caseRun(async () => null),
      {
        id: "k",
        event: { name: "dd.changes", data: { case: "k" }, id: "c1" },
        events: [{ during: "a#1", name: "dd.changes", data: { case: "k" }, id: "c1" }],
      },
    ),
  ).rejects.toThrow("given twice");
});
