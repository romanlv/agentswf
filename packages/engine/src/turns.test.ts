import { afterAll, expect, test } from "bun:test";
import { MAILBOX_RECORD_VERSION, type MailboxRecord } from "@agentswf/contract/records";
import { isAnswered } from "@agentswf/contract/workflow";
import { appendMailbox, endIdOf, foldMailbox, readMailbox, recoverTurns } from "./mailbox";
import { caseRun, createTempRunDirs, startCase } from "./testing";
import { answer, reply, testWorkflow } from "./workflow-testing";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

const ends = (mailbox: MailboxRecord[]) =>
  mailbox.flatMap((record) =>
    record.kind === "event" && record.name === "agent:ended" ? [record] : [],
  );
const slow = (text: string, ms: number) =>
  answer(async () => {
    await Bun.sleep(ms);
    return text;
  });

test("startCase returns at once; the end arrives at a wait with the turn's id, meta and outcome", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const other = await workflow.agents.open({ key: "triage", runtime: "claude" });
      const turn = await agent.start({ prompt: "look", meta: { given: 3 } });
      for (;;) {
        for (const e of await workflow.receive()) {
          if (other.ended(e)) return "the other agent's";
          if (agent.ended<{ given: number }>(e)) {
            return {
              same: e.data.turn === turn.id,
              given: e.data.meta.given,
              answered: isAnswered(e.data.outcome) ? e.data.outcome.value : null,
              cleared: agent.turn === null,
            };
          }
        }
      }
    }),
    { ...startCase, agents: { investigator: answer("found it") } },
  );
  expect(run.value).toEqual({ same: true, given: 3, answered: "found it", cleared: true });
  expect(ends(run.mailbox)).toHaveLength(1);
  expect(run.mailbox.find((r) => r.kind === "turn")).toMatchObject({
    agent: "investigator",
    meta: { given: 3 },
  });
});

test("while a started turn is set, the agent refuses other work, also once it ended untaken", async () => {
  const refusals: string[] = [];
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      await agent.start({ prompt: "look" });
      const tryAll = async () => {
        for (const [what, call] of [
          ["start", () => agent.start({ prompt: "again" })],
          ["run", () => agent.run({ prompt: "again" })],
          ["compact", () => agent.compact({ prompt: "keep" })],
          ["set", () => agent.set({ effort: "low" })],
          ["fork", () => agent.fork({ key: "copy" })],
        ] as const)
          await (call as () => Promise<unknown>)().then(
            () => refusals.push(`${what} taken`),
            (error: unknown) =>
              refusals.push(`${what}: ${String(error).includes("whose end no wait has taken")}`),
          );
      };
      await tryAll();
      // Ended, its end not yet taken: still refused.
      await Bun.sleep(200);
      await tryAll();
      return null;
    }),
    { ...startCase, agents: { investigator: answer("done") } },
  );
  expect(run.value).toBeNull();
  expect(refusals).toEqual(
    ["start", "run", "compact", "set", "fork", "start", "run", "compact", "set", "fork"].map(
      (what) => `${what}: true`,
    ),
  );
});

test("an event during a turn is taken before the turn ends", async () => {
  const order: string[] = [];
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const slowOne = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const quick = await workflow.agents.open({ key: "triage", runtime: "claude" });
      await slowOne.start({ prompt: "look" });
      await quick.start({ prompt: "glance" });
      for (;;) {
        for (const e of await workflow.receive()) {
          if (e.name === "agent:ended") order.push(e.from);
          if (slowOne.ended(e)) return order;
        }
      }
    }),
    { ...startCase, agents: { investigator: slow("slow", 300), triage: answer("quick") } },
  );
  expect(run.value).toEqual(["triage", "investigator"]);
});

test("cancel returns once the cancelled end is in the mailbox, and at once on an ended turn", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const turn = await agent.start({ prompt: "look" });
      const cancelled = await turn.cancel("closed by triage");
      const [end] = await workflow.receive();
      const again = await turn.cancel();
      return {
        cancelled,
        again,
        kind: end && agent.ended(end) ? end.data.outcome.kind : null,
      };
    }),
    { ...startCase, agents: { investigator: reply.hang() } },
  );
  expect(run.value).toEqual({ cancelled: true, again: false, kind: "cancelled" });
});

test("code that throws with a turn running cancels it, and its end is written first", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      await agent.start({ prompt: "look" });
      throw new Error("a bug");
    }),
    { ...startCase, agents: { investigator: reply.hang() } },
  );
  expect(() => run.value).toThrow("a bug");
  expect(
    ends(run.mailbox).map((e) => (e.data as { outcome: { kind: string } }).outcome.kind),
  ).toEqual(["cancelled"]);
});

test("a return cancels a running turn", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      await agent.start({ prompt: "look" });
      return "merged";
    }),
    { ...startCase, agents: { investigator: reply.hang() } },
  );
  expect(run.value).toBe("merged");
  expect(
    ends(run.mailbox).map((e) => (e.data as { outcome: { kind: string } }).outcome.kind),
  ).toEqual(["cancelled"]);
});

test("a run doesn't park while a started turn runs, and parks once its end is taken", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      await agent.start({ prompt: "look" });
      for (;;) await workflow.receive({ label: agent.turn ? "investigating" : "idle" });
    }),
    { ...startCase, agents: { investigator: slow("done", 200) } },
  );
  expect(run.parked).toEqual({ label: "idle" });
  expect(ends(run.mailbox)).toHaveLength(1);
});

test("startCase is refused in a stage, whose end it would outlive", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      await workflow.stage("look", async () => {
        await agent.start({ prompt: "look" });
      });
      return null;
    }),
    { ...startCase, agents: { investigator: answer("done") } },
  );
  expect(() => run.value).toThrow("start() is called at the run's root");
});

test("a continue writes a failed end for a turn a crash left, and restores the turns whose ends no wait took", async () => {
  const runDir = dirs.tempRunDir();
  const at = new Date().toISOString();
  const turn = (agent: string, id: string): MailboxRecord => ({
    version: MAILBOX_RECORD_VERSION,
    at,
    kind: "turn",
    attempt: 1,
    agent,
    turn: id,
    meta: { batch: id },
    execution: { harness: "codex", model: "m" },
  });
  await appendMailbox(runDir, turn("investigator", "t1"));
  await appendMailbox(runDir, turn("triage", "t2"));
  // triage's ended and was taken; investigator's attempt died mid-turn.
  await appendMailbox(runDir, {
    version: MAILBOX_RECORD_VERSION,
    at,
    kind: "event",
    id: endIdOf("triage", "t2", 1),
    name: "agent:ended",
    data: { turn: "t2" },
    from: "triage",
  });
  await appendMailbox(runDir, { version: MAILBOX_RECORD_VERSION, at, kind: "wait", attempt: 1 });
  await appendMailbox(runDir, {
    version: MAILBOX_RECORD_VERSION,
    at,
    kind: "took",
    attempt: 1,
    ids: [endIdOf("triage", "t2", 1)],
  });
  await appendMailbox(runDir, { version: MAILBOX_RECORD_VERSION, at, kind: "wait", attempt: 1 });
  const restored = await recoverTurns(runDir, 2, (work) => work());
  expect([...restored]).toEqual([["investigator", { turn: "t1", meta: { batch: "t1" } }]]);
  const state = foldMailbox(await readMailbox(runDir));
  const end = state.events.get(endIdOf("investigator", "t1", 1));
  expect(end).toMatchObject({
    name: "agent:ended",
    from: "investigator",
    data: { turn: "t1", meta: { batch: "t1" }, outcome: { kind: "failed" } },
  });
  // Run again, nothing more is written: one end is ever kept.
  await recoverTurns(runDir, 3, (work) => work());
  expect(
    (await readMailbox(runDir)).filter((r) => r.kind === "event" && r.name === "agent:ended"),
  ).toHaveLength(2);
});

const at = new Date().toISOString();
/** What a crashed attempt 1 left: a turn of the investigator's begun and never ended. */
const crashed: MailboxRecord[] = [
  {
    version: MAILBOX_RECORD_VERSION,
    at,
    kind: "event",
    id: "c0",
    name: "dd.changes",
    data: { case: "k" },
    from: "operator",
  },
  { version: MAILBOX_RECORD_VERSION, at, kind: "wait", attempt: 1 },
  { version: MAILBOX_RECORD_VERSION, at, kind: "took", attempt: 1, ids: ["c0"] },
  {
    version: MAILBOX_RECORD_VERSION,
    at,
    kind: "turn",
    attempt: 1,
    agent: "investigator",
    turn: "t1",
    meta: { batch: 1 },
    execution: { harness: "claude", model: "m" },
  },
];
const woken = { event: { name: "dd.changes" as const, data: { case: "k" }, id: "c1" } };

test("after a crash, the code's first wait takes the turn's failed end, with its meta", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const restored = agent.turn?.id ?? null;
      const taken = await workflow.receive();
      const end = taken.find((e) => agent.ended(e));
      return {
        restored,
        names: taken.map((e) => e.name),
        end:
          end && agent.ended<{ batch: number }>(end)
            ? [end.data.turn, end.data.meta.batch, end.data.outcome.kind]
            : null,
        cleared: agent.turn === null,
      };
    }),
    { ...woken, mailbox: crashed, agents: { investigator: answer("unused") } },
  );
  // The batch the crash held comes back first, alone; the failed end with the next.
  expect(run.value).toMatchObject({ restored: "t1", names: ["dd.changes"] });
});

test("after a crash, an agent opened after the wait took its end is free, and one opened before is held", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const taken = await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      return {
        names: taken.map((e) => e.name),
        turn: agent.turn?.id ?? null,
        ran: await agent.run({ prompt: "look" }).then(
          ({ outcome }) => outcome.kind,
          (error: unknown) => String(error),
        ),
      };
    }),
    { ...woken, mailbox: crashed, agents: { investigator: answer("found") } },
  );
  // The event that woke it came first; the failed end was written as the attempt began.
  expect(run.value).toEqual({ names: ["dd.changes", "agent:ended"], turn: null, ran: "answered" });

  const held = await testWorkflow(
    caseRun(async (workflow) => {
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      // Before any read of agent.turn: still refused, as its end is untaken.
      return agent.run({ prompt: "look" }).then(
        () => "ran",
        (error: unknown) => String(error).includes("whose end no wait has taken"),
      );
    }),
    { ...woken, mailbox: crashed, agents: { investigator: answer("found") } },
  );
  expect(held.value).toBe(true);
});

test("a turn id is begun once in an attempt, and two starts at once startCase one turn", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const both = await Promise.allSettled([
        agent.start({ prompt: "a", id: "x" }),
        agent.start({ prompt: "b", id: "y" }),
      ]);
      await workflow.receive();
      const again = await agent.start({ prompt: "a", id: "x" }).then(
        () => "started",
        (error: unknown) => String(error).includes("began turn x already"),
      );
      return { both: both.map((r) => r.status), again };
    }),
    { ...startCase, agents: { investigator: answer("done") } },
  );
  expect(run.value).toEqual({ both: ["fulfilled", "rejected"], again: true });
  expect(run.mailbox.filter((r) => r.kind === "turn")).toHaveLength(1);
});

test("a startCase behind other work waits for it, and its cancel stops only the turn", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const agent = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const running = agent.run({ prompt: "slow" });
      const turn = await agent.start({ prompt: "look" });
      const cancelled = await turn.cancel("not needed");
      const [end] = await workflow.receive();
      return {
        cancelled,
        end: end && agent.ended(end) ? end.data.outcome.kind : null,
        other: (await running).outcome.kind,
      };
    }),
    { ...startCase, agents: { investigator: slow("done", 100) } },
  );
  expect(run.value).toEqual({ cancelled: true, end: "cancelled", other: "answered" });
});

test("a message held during a started turn doesn't keep the next start() out", async () => {
  const handled: string[] = [];
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const triage = await workflow.agents.open({ key: "triage", runtime: "claude" });
      await workflow.messages.allow({
        from: triage,
        to: investigator,
        purpose: "share a lead",
      });
      await investigator.start({ prompt: "look" });
      // While the investigator's turn runs, triage messages it: the message waits.
      await triage.run({ prompt: "tell the investigator" });
      for (;;)
        for (const e of await workflow.receive()) {
          if (!investigator.ended(e)) continue;
          // Its end taken, the held message wakes it, and the next startCase waits behind it.
          const next = await investigator.start({ prompt: "look again" });
          return next.id.length > 0;
        }
    }),
    {
      ...startCase,
      agents: {
        investigator: slow("found", 150),
        triage: answer(async (turn) => {
          await turn.send("investigator", "check the index");
          return "sent";
        }),
      },
      messages: {
        investigator: (message) => {
          handled.push(message.text);
          return message.silent();
        },
      },
    },
  );
  expect(run.value).toBe(true);
  expect(handled).toEqual(["check the index"]);
});
