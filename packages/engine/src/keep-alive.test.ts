import { expect, test } from "bun:test";
import { MAILBOX_RECORD_VERSION } from "@agentswf/contract/records";
import { defineWorkflow, type EventAgentOpenSpec } from "@agentswf/contract/workflow";
import { caseRun, startCase } from "./testing";
import { answer, reply, testWorkflow } from "./workflow-testing";

type KeepAlive = NonNullable<EventAgentOpenSpec["keepAlive"]>;

/** Starts a turn for each `dd.changes` it takes, its agent kept alive as given. */
const watcher = (keepAlive: KeepAlive, taken: string[] = []) =>
  caseRun(async (workflow) => {
    const agent = await workflow.agents.open({ key: "investigator", runtime: "claude", keepAlive });
    for (;;) {
      const events = await workflow.receive();
      taken.push(...events.map((e) => e.name));
      if (!agent.turn && events.some((e) => e.name === "dd.changes"))
        await agent.start({ prompt: "look" });
    }
  });

const changes = (after: string) => ({ after, name: "dd.changes", data: { case: "k" } }) as const;

test("an event in the window is taken by the same attempt; the run parks once it passes, after onTimeout", async () => {
  const calls: number[] = [];
  const started = Date.now();
  const run = await testWorkflow(
    watcher({
      timeoutMs: 300,
      onTimeout: async (agent) => {
        calls.push(Date.now() - started);
        await agent.compact({ prompt: "Keep the findings." });
      },
    }),
    {
      ...startCase,
      agents: { investigator: answer("looked") },
      events: [changes("investigator#1")],
    },
  );
  expect(run.parked).toBeDefined();
  expect(run.turnsOf("investigator")).toHaveLength(2);
  // Once, after the second turn's window; its compaction is the agent's.
  expect(calls).toHaveLength(1);
  expect(run.compactionsOf("investigator").map((c) => c.focus)).toEqual(["Keep the findings."]);
});

test("without keepAlive, the run parks at once: an event scripted after a turn is never sent", async () => {
  await expect(
    testWorkflow(
      caseRun(async (workflow) => {
        const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
        await workflow.receive();
        await agent.start({ prompt: "look" });
        for (;;) await workflow.receive();
      }),
      {
        ...startCase,
        agents: { investigator: answer("looked") },
        events: [changes("investigator#1")],
      },
    ),
  ).rejects.toThrow("never waited live after that turn");
});

test("a turn onTimeout runs, awaited or started, opens no window; a turn after it makes it due again", async () => {
  const calls: string[] = [];
  let ended = 0;
  const started = Date.now();
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const agent = await workflow.agents.open({
        key: "investigator",
        runtime: "claude",
        keepAlive: {
          timeoutMs: 200,
          onTimeout: async (agent) => {
            calls.push(`handler at ${ended}`);
            if (calls.length > 1) return;
            await agent.run({ prompt: "wrap up" });
            await agent.start({ prompt: "and note it", meta: "handler's" });
          },
        },
      });
      await workflow.receive();
      await agent.run({ prompt: "look" });
      for (;;)
        for (const e of await workflow.receive()) {
          // The handler's started turn ends at the loop, told by its meta.
          if (agent.is(e) && e.data.meta === "handler's") {
            ended += 1;
            await agent.run({ prompt: "follow up" });
          }
        }
    }),
    { ...startCase, agents: { investigator: answer("done") } },
  );
  expect(run.parked).toBeDefined();
  expect(run.turnsOf("investigator").map((turn) => turn.prompt)).toEqual([
    "look",
    "wrap up",
    "and note it",
    "follow up",
  ]);
  // Due again only for the code's own follow-up; the handler's two turns opened none.
  expect(calls).toEqual(["handler at 0", "handler at 1"]);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a handler's own turns, awaited and started, with nothing after them, leave the run to park", async () => {
  const calls: number[] = [];
  const started = Date.now();
  const run = await testWorkflow(
    watcher({
      timeoutMs: 150,
      onTimeout: async (agent) => {
        calls.push(Date.now() - started);
        await agent.run({ prompt: "wrap up" });
        await agent.start({ prompt: "and note it" });
      },
    }),
    { ...startCase, agents: { investigator: answer("done") } },
  );
  expect(run.parked).toBeDefined();
  expect(calls).toHaveLength(1);
  expect(run.turnsOf("investigator")).toHaveLength(3);
  // No window after the handler's turns: it parks well before another would pass.
  expect(Date.now() - started).toBeLessThan(calls[0]! + 150);
});

test("an event during onTimeout is returned once it finishes, and its turn opens a new window", async () => {
  const order: string[] = [];
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const agent = await workflow.agents.open({
        key: "investigator",
        runtime: "claude",
        keepAlive: {
          timeoutMs: 150,
          onTimeout: async (agent) => {
            order.push("handler");
            await agent.run({ prompt: "wrap up" });
            order.push("handler done");
          },
        },
      });
      let first = true;
      for (;;) {
        const events = await workflow.receive();
        for (const e of events) if (e.name === "dd.changes") order.push(first ? "start" : "event");
        if (events.some((e) => e.name === "dd.changes")) await agent.run({ prompt: "look" });
        first = false;
      }
    }),
    {
      ...startCase,
      agents: { investigator: answer("done") },
      events: [{ during: "investigator#2", name: "dd.changes", data: { case: "k" } }],
    },
  );
  expect(run.parked).toBeDefined();
  expect(order).toEqual(["start", "handler", "handler done", "event", "handler", "handler done"]);
});

test("a window that passes while another agent works is handled at the next idle wait", async () => {
  const calls: { investigator: number[]; lens: number[] } = { investigator: [], lens: [] };
  const started = Date.now();
  let lensEnded = 0;
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const open = (key: "investigator" | "lens", timeoutMs: number) =>
        workflow.agents.open({
          key,
          runtime: "claude",
          keepAlive: {
            timeoutMs,
            onTimeout: async () => {
              calls[key].push(Date.now() - started);
            },
          },
        });
      const investigator = await open("investigator", 100);
      const lens = await open("lens", 100);
      await workflow.receive();
      await investigator.run({ prompt: "look" });
      // Its window passes while the lens works: nothing is called until that turn's end is taken.
      await lens.start({ prompt: "look slowly" });
      for (;;)
        for (const e of await workflow.receive())
          if (lens.is(e)) lensEnded = Date.now() - started;
    }),
    {
      ...startCase,
      agents: {
        investigator: answer("done"),
        lens: answer(async () => {
          await Bun.sleep(400);
          return "done";
        }),
      },
    },
  );
  expect(run.parked).toBeDefined();
  expect(calls.investigator).toHaveLength(1);
  expect(calls.investigator[0]).toBeGreaterThanOrEqual(lensEnded);
  expect(calls.lens).toHaveLength(1);
  expect(calls.lens[0]).toBeGreaterThanOrEqual(lensEnded);
});

test("two agents' windows pass each on its own clock; the run parks after the later", async () => {
  const calls: string[] = [];
  const started = Date.now();
  const at: Record<string, number> = {};
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const open = (key: string, timeoutMs: number) =>
        workflow.agents.open({
          key,
          runtime: "claude",
          keepAlive: {
            timeoutMs,
            onTimeout: async () => {
              calls.push(key);
              at[key] = Date.now() - started;
            },
          },
        });
      const [quick, slow] = await Promise.all([open("quick", 100), open("slow", 500)]);
      await workflow.receive();
      await Promise.all([quick.run({ prompt: "a" }), slow.run({ prompt: "b" })]);
      for (;;) await workflow.receive();
    }),
    { ...startCase, agents: { quick: answer("a"), slow: answer("b") } },
  );
  expect(run.parked).toBeDefined();
  expect(calls).toEqual(["quick", "slow"]);
  expect(at.quick).toBeLessThan(at.slow! - 200);
  expect(Date.now() - started).toBeGreaterThanOrEqual(500);
});

test("a turn that fails closes the agent: no window, no onTimeout, and the run parks at once", async () => {
  const calls: string[] = [];
  const started = Date.now();
  const run = await testWorkflow(
    watcher({
      timeoutMs: 5_000,
      onTimeout: async () => {
        calls.push("handler");
      },
    }),
    { ...startCase, agents: { investigator: reply.failed("harness crashed") } },
  );
  expect(run.parked).toBeDefined();
  expect(calls).toEqual([]);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a handler that throws is logged, and the run parks anyway", async () => {
  const run = await testWorkflow(
    watcher({
      timeoutMs: 100,
      onTimeout: async () => {
        throw new Error("no focus");
      },
    }),
    { ...startCase, agents: { investigator: answer("looked") } },
  );
  expect(run.parked).toBeDefined();
  expect(run.logs.map((line) => line.message)).toContain(
    "awf: agent investigator's onTimeout threw: no focus",
  );
});

test("a run that stops during a handler ends the wait without calling the next", async () => {
  const calls: string[] = [];
  const stopped = Promise.withResolvers<void>();
  await expect(
    testWorkflow(
      caseRun(async (workflow) => {
        const open = (key: string, timeoutMs: number, onTimeout: () => Promise<void>) =>
          workflow.agents.open({ key, runtime: "claude", keepAlive: { timeoutMs, onTimeout } });
        const [hanging, next] = await Promise.all([
          open("hanging", 50, async () => {
            calls.push("hanging");
            // Returns after the stop: the wait no longer waits on it, and calls no next.
            await stopped.promise;
          }),
          open("next", 60, async () => {
            calls.push("next");
          }),
        ]);
        await workflow.receive();
        await Promise.all([hanging.run({ prompt: "a" }), next.run({ prompt: "b" })]);
        try {
          for (;;) await workflow.receive();
        } catch (error) {
          calls.push("wait ended");
          stopped.resolve();
          throw error;
        }
      }),
      { ...startCase, stallMs: 400, agents: { hanging: answer("a"), next: answer("b") } },
    ),
  ).rejects.toThrow("stalled");
  await Bun.sleep(100);
  expect(calls).toEqual(["hanging", "wait ended"]);
});

test("a peer's message that reaches the agent during its handler is the peer's turn, and opens a window", async () => {
  const calls: number[] = [];
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const lens = await workflow.agents.open({ key: "lens", runtime: "codex" });
      const investigator = await workflow.agents.open({
        key: "investigator",
        runtime: "claude",
        keepAlive: {
          timeoutMs: 100,
          onTimeout: async () => {
            calls.push(calls.length);
            // The lens messages the investigator, idle while its handler awaits the lens.
            if (calls.length === 1) await lens.run({ prompt: "note it" });
          },
        },
      });
      await workflow.messages.allow({ from: lens, to: investigator, purpose: "Notes." });
      await workflow.receive();
      await investigator.run({ prompt: "look" });
      for (;;) await workflow.receive();
    }),
    {
      ...startCase,
      agents: {
        investigator: answer("looked"),
        lens: answer(async (turn) => {
          await turn.send("investigator", "Mind the index.");
          return "noted";
        }),
      },
      messages: { investigator: (message) => message.silent() },
    },
  );
  expect(run.parked).toBeDefined();
  // Called again for the window the message's turn opened.
  expect(calls).toEqual([0, 1]);
});

test("a wake that runs no turn calls no handler, nor does a turn's end a crash's recovery wrote", async () => {
  const calls: string[] = [];
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.agents.open({
        key: "investigator",
        runtime: "claude",
        keepAlive: {
          timeoutMs: 50,
          onTimeout: async () => {
            calls.push("handler");
          },
        },
      });
      for (;;) await workflow.receive();
    }),
    {
      ...startCase,
      // Attempt 1 began a turn and died: its end, written failed, is taken by the first wait.
      mailbox: [
        {
          version: MAILBOX_RECORD_VERSION,
          at: "2026-10-28T10:00:00.000Z",
          kind: "turn",
          attempt: 1,
          agent: "investigator",
          turn: "t1",
          meta: null,
          execution: { harness: "claude", model: "sonnet", placement: "pane" },
        },
      ],
      agents: { investigator: answer("looked") },
    },
  );
  expect(run.parked).toBeDefined();
  expect(calls).toEqual([]);
});

test("keepAlive outside a workflow with events, or with a timeoutMs that isn't positive, is refused at open", async () => {
  const run = async (workflow: typeof plain) => (await testWorkflow(workflow, null, {})).value;
  const plain = defineWorkflow({
    meta: { name: "plain", description: "No events." },
    async run(workflow) {
      const spec = { key: "a", runtime: "claude", keepAlive: { timeoutMs: 1_000 } } as const;
      await workflow.agents.open(spec);
      return null;
    },
  });
  await expect(run(plain)).rejects.toThrow("keepAlive is for a workflow with events");
  const zero = await testWorkflow(watcher({ timeoutMs: 0 }), startCase);
  expect(() => zero.value).toThrow("keepAlive's timeoutMs is a positive number");
});

test("a reopen takes the new keepAlive; one that leaves it out keeps what the agent has", async () => {
  const calls: string[] = [];
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const open = (keepAlive?: KeepAlive) =>
        workflow.agents.open({
          key: "investigator",
          runtime: "claude",
          ...(keepAlive ? { keepAlive } : {}),
        });
      await open({ timeoutMs: 60_000 });
      await open({
        timeoutMs: 100,
        onTimeout: async () => {
          calls.push("second");
        },
      });
      const agent = await open();
      await workflow.receive();
      await agent.run({ prompt: "look" });
      for (;;) await workflow.receive();
    }),
    { ...startCase, agents: { investigator: answer("looked") } },
  );
  expect(run.parked).toBeDefined();
  expect(calls).toEqual(["second"]);
});

test("in a test, a window that gives no timeoutMs is short, not the hour, so the test doesn't stall", async () => {
  const calls: string[] = [];
  const run = await testWorkflow(
    watcher({
      onTimeout: async () => {
        calls.push("handler");
      },
    }),
    { ...startCase, agents: { investigator: answer("looked") } },
  );
  expect(run.parked).toBeDefined();
  expect(calls).toEqual(["handler"]);
});

test("a test whose run sits in a long window stalls, and says it waits live in one", async () => {
  await expect(
    testWorkflow(watcher({ timeoutMs: 60_000 }), {
      ...startCase,
      stallMs: 300,
      agents: { investigator: answer("looked") },
    }),
  ).rejects.toThrow("waits live in an agent's keepAlive window");
});
