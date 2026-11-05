import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentEnded,
  defineWorkflow,
  type JsonValue,
  ParticipantReply,
  type WorkflowContext,
} from "@agentswf/contract/workflow";
import { caseEvents, caseRun, startCase } from "./testing";
import { answer, testWorkflow } from "./workflow-testing";

/** The sketch's shape, cut down: replies are pending until a turn is given them. */
const replying = caseRun(async (workflow) => {
  const thread = await workflow.participants.connect({ key: "thread", to: "code" });
  const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
  const pending: string[] = [];
  let first = true;
  for (;;) {
    for (const e of await workflow.receive({ label: investigator.turn ? "investigating" : "idle" }))
      if (thread.is(e)) pending.push(`${e.data.author}: ${e.data.text}`);
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
  expect(run.ending.kind).toBe("parked");
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
        // A retry always due: it never parks, a turn after every wait.
        for (let n = 0; ; n++) {
          workflow.timer(`retry-${n}`, new Date(0));
          await workflow.receive();
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
          if (agent.is(e)) return seen;
        }
    }),
    {
      ...startCase,
      agents: { investigator: answer("done") },
      events: [
        { during: "investigator#1", name: "dd.changes", data: { case: "k" }, eventId: "c2" },
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

/** A case run that declares its thread's replies and its investigator's end. */
const declaring = (run: (wf: WorkflowContext<typeof declared>) => Promise<JsonValue>) =>
  defineWorkflow({
    meta: { name: "dd-case", description: "A case." },
    file: import.meta.path,
    events: declared,
    starts: ["dd.changes"],
    run,
  });
const declared = {
  ...caseEvents,
  "thread:reply": ParticipantReply,
  "investigator:ended": AgentEnded,
};

test("declared, a reply and an end arrive under their names, and log nothing", async () => {
  const run = await testWorkflow(
    declaring(async (workflow) => {
      const thread = await workflow.participants.connect({ key: "thread" });
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      await workflow.receive();
      await agent.start({ prompt: "look", meta: { n: 1 } });
      const seen: string[] = [];
      for (;;)
        for (const e of await workflow.receive()) {
          seen.push(`${e.name} from ${e.from}`);
          if (e.name === "thread:reply") await thread.post(`got ${e.data.text}`);
          if (e.name === "investigator:ended" && agent.is(e)) {
            seen.push(`meta ${JSON.stringify(e.data.meta)}`);
            return seen;
          }
        }
    }),
    {
      ...startCase,
      agents: { investigator: answer("done") },
      events: [{ during: "investigator#1", name: "thread:reply", data: { text: "hi" } }],
    },
  );
  expect(run.value).toEqual([
    "thread:reply from thread",
    "investigator:ended from investigator",
    'meta {"n":1}',
  ]);
  expect(run.logs.filter((log) => log.message.includes("deprecated"))).toEqual([]);
});

test("declared, a reply is a signal a race takes whole", async () => {
  const run = await testWorkflow(
    declaring(async (workflow) => {
      await workflow.participants.connect({ key: "thread" });
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      await workflow.receive();
      await agent.run({ prompt: "look" });
      const next = await workflow.race("reply", {
        reply: workflow.signal("thread:reply"),
        quiet: "1d",
      });
      return next.reply ? [next.reply.name, next.reply.from, next.reply.data.text] : null;
    }),
    {
      ...startCase,
      agents: { investigator: answer("done") },
      events: [{ during: "investigator#1", name: "thread:reply", data: { text: "approved" } }],
    },
  );
  expect(run.value).toEqual(["thread:reply", "thread", "approved"]);
});

test("a scripted reply is checked as awf emit checks one: declared, and fitting its schema", async () => {
  const body = declaring(async (workflow) => {
    const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
    await agent.run({ prompt: "look" });
    return null;
  });
  const sent = (event: object) =>
    testWorkflow(body, {
      ...startCase,
      agents: { investigator: answer("done") },
      // biome-ignore lint/suspicious/noExplicitAny: events tsc refuses, as a plain caller could give.
      events: [{ during: "investigator#1", ...event } as any],
    });
  await expect(sent({ name: "lead:reply", data: { text: "hi" } })).rejects.toThrow(
    "declares no event lead:reply; its events are dd.changes, thread:reply, investigator:ended",
  );
  await expect(sent({ name: "thread:reply", data: { body: "hi" } })).rejects.toThrow(
    "does not fit its schema",
  );
  await expect(sent({ name: "investigator:ended", data: {} })).rejects.toThrow(
    "a name with a colon is awf's own",
  );
});

test("an undeclared participant's message goes to the agent that asked, and none to the mailbox", async () => {
  const run = await testWorkflow(
    declaring(async (workflow) => {
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const lead = await workflow.participants.connect({ key: "lead" });
      await workflow.messages.allow({ between: [agent, lead], purpose: "Ask the lead." });
      const { outcome } = await agent.run({ prompt: "Ask." });
      return outcome.answered ? outcome.value : outcome.kind;
    }),
    {
      ...startCase,
      agents: {
        investigator: answer(async (turn) => {
          const answered = await turn.send("lead", "Merge?", { awaitReply: true });
          return answered.kind === "replied" ? answered.text : answered.kind;
        }),
      },
      participants: {
        lead: async (event) => {
          if (event.kind === "message" && event.asks) await event.reply("Keep two.");
        },
      },
    },
  );
  expect(run.value).toBe("Keep two.");
  expect(run.events.map((line) => line.name)).toEqual(["dd.changes"]);
});

test("a workflow that declares a reply refuses wf.signal of an agent's end", async () => {
  const run = await testWorkflow(
    declaring(async (workflow) => {
      try {
        // biome-ignore lint/suspicious/noExplicitAny: a name tsc refuses, as a plain caller could give.
        workflow.signal("investigator:ended" as any);
        return "made";
      } catch (error) {
        return (error as Error).message;
      }
    }),
    { ...startCase },
  );
  expect(run.value).toContain("naming the agent, { done: investigator }");
});

test("start() for a key with a colon says to rename the key, not to declare it", async () => {
  const run = await testWorkflow(
    declaring(async (workflow) => {
      const agent = await workflow.agents.open({ key: "fix:er", runtime: "claude" });
      return agent.start({ prompt: "fix" }).then(
        () => "started",
        (error: Error) => error.message,
      );
    }),
    { ...startCase },
  );
  expect(run.value).toContain('rename it fix-er and declare "fix-er:ended": AgentEnded');
});

test("a workflow that declares an end refuses start() for an agent whose end it doesn't", async () => {
  const run = await testWorkflow(
    declaring(async (workflow) => {
      const other = await workflow.agents.open({ key: "fixer", runtime: "claude" });
      return other.start({ prompt: "fix" }).then(
        () => "started",
        (error: Error) => error.message,
      );
    }),
    { ...startCase },
  );
  expect(run.value).toContain('"fixer:ended": AgentEnded');
});

test('a workflow that declares a reply refuses to: "code" for a participant it doesn\'t', async () => {
  const run = await testWorkflow(
    declaring(async (workflow) =>
      workflow.participants.connect({ key: "lead", to: "code" }).then(
        () => "connected",
        (error: Error) => error.message,
      ),
    ),
    { ...startCase },
  );
  expect(run.value).toContain('"lead:reply": ParticipantReply');
});

test("files outside the run's directory, and an eventId given twice, are refused", async () => {
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
        event: { name: "dd.changes", data: { case: "k" }, eventId: "c1" },
        events: [{ during: "a#1", name: "dd.changes", data: { case: "k" }, eventId: "c1" }],
      },
    ),
  ).rejects.toThrow("given twice");
});

test("a scripted event gives during or after, one of them", async () => {
  const data = { case: "k" };
  for (const timing of [{}, { during: "a#1", after: "a#1" }])
    await expect(
      testWorkflow(
        caseRun(async () => null),
        // biome-ignore lint/suspicious/noExplicitAny: timings tsc refuses, as a plain caller could give.
        { ...startCase, events: [{ ...timing, name: "dd.changes", data } as any] },
      ),
    ).rejects.toThrow("during or after, one of them");
});
