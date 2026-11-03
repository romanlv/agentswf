import { afterAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MAILBOX_RECORD_VERSION, type TurnRecord } from "@agentswf/contract/records";
import { defineWorkflow, type WorkflowContext } from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import { appendMailbox } from "./mailbox";
import { OPERATOR_ALIASES } from "./operator-aliases";
import { createRun, readStageRecords } from "./runs";
import { answering, caseRun, createTempRunDirs, future, startCase } from "./testing";
import { keptSessionsOf, runWorkflow } from "./workflow-runner";
import { answer, testWorkflow } from "./workflow-testing";

test("the first wait takes the event that started the run, under the id it made", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const [first] = await workflow.receive({ label: "first" });
      return { run: workflow.runId, id: first?.id ?? null, data: first?.data ?? null };
    }),
    { id: "kombo", event: { name: "dd.changes", data: { case: "kombo" }, eventId: "83d34d7" } },
  );
  expect(run.value).toEqual({ run: "kombo", id: "83d34d7", data: { case: "kombo" } });
});

test("a run started by its id, with no event, parks at its first wait", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.stage("setup", async () => undefined);
      await workflow.receive({ label: "nothing yet" });
      return null;
    }),
    { id: "kombo" },
  );
  expect(run.ending).toMatchObject({ kind: "parked", label: "nothing yet" });
  expect(run.stages.map((record) => record.stage)).toEqual(["setup"]);
  const unnamed = await testWorkflow(caseRun(async (workflow) => workflow.runId));
  expect(unnamed.value).toBe("test");
  await expect(
    testWorkflow(
      caseRun(async () => null),
      { id: "-kombo" },
    ),
  ).rejects.toThrow("-kombo");
});

test("a run of a workflow with events gets its args, or what prepare makes of none", async () => {
  const Changes = { type: "object", properties: {} } as const;
  type Case = { case: string };
  const workflow = defineWorkflow<Case, Case, { "dd.changes": typeof Changes }>({
    meta: { name: "dd-case", description: "A case." },
    file: import.meta.path,
    events: { "dd.changes": Changes },
    prepare: ({ argv }) => ({ case: argv[0] ?? "none" }),
    async run(_workflow, args) {
      return args;
    },
  });
  expect((await testWorkflow(workflow, { id: "k", args: { case: "kombo" } })).value).toEqual({
    case: "kombo",
  });
  expect((await testWorkflow(workflow, { id: "k" })).value).toEqual({ case: "none" });
});

test("a stage entered twice in a run with events runs once", async () => {
  let ran = 0;
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      for (let i = 0; i < 2; i++)
        await workflow.stage("close-e1", async () => {
          ran++;
        });
      return ran;
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(run.value).toBe(1);
  expect(run.stages.map((s) => s.stage)).toEqual(["close-e1"]);
});

test("a stage around a wait returns its batch, and one returning other events fails", async () => {
  const kept = await testWorkflow(
    caseRun(async (workflow) => {
      const batch = await workflow.stage("approval-1", () => workflow.receive());
      return batch.map((e) => e.id);
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" }, eventId: "e1" } },
  );
  expect(kept.value).toEqual(["e1"]);

  // Entered again in one attempt, a stage around a wait would return its batch forever: refused.
  const again = await testWorkflow(
    caseRun(async (workflow) => {
      for (;;) await workflow.stage("approval-1", () => workflow.receive());
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" }, eventId: "e1" } },
  );
  expect(() => again.value).toThrow("around a wait was entered again in this attempt");

  const filtered = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.stage("approval-1", async () =>
        (await workflow.receive()).filter(() => false),
      );
      return null;
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(() => filtered.value).toThrow("returned other events than its wait took");
});

test("a workflow without events waits as any does: a timer's end at receive, a race and a select", async () => {
  const run = await testWorkflow(
    defineWorkflow({
      meta: { name: "plain", description: "No events." },
      run: async (workflow) => {
        workflow.timer("first", "1m");
        const [due] = await workflow.receive();
        const raced = await workflow.race("rest", { rested: "1h" });
        const later = workflow.after("2h");
        for await (const next of workflow.select({ due: workflow.at(() => later) }))
          if (next.due) break;
        return [due?.name ?? null, raced.key];
      },
    }),
  );
  expect(run.value).toEqual(["timer:due", "rested"]);
});

test("a workflow without events refuses a signal, a started turn and keepAlive, saying why", async () => {
  const refused = async (work: (wf: WorkflowContext) => Promise<unknown>) => {
    const run = await testWorkflow(
      defineWorkflow({
        meta: { name: "plain", description: "No events." },
        run: async (workflow) => {
          await work(workflow);
          return null;
        },
      }),
      { agents: { a: answer("yes") } },
    );
    return () => run.value;
  };
  expect(
    await refused(async (wf) => (wf as unknown as WorkflowContext<{ x: never }>).signal("x")),
  ).toThrow("signal x: the workflow declares no events");
  expect(
    await refused(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      await agent.start({ prompt: "Look." });
    }),
  ).toThrow("start() is for a workflow with events");
  expect(
    await refused((wf) => wf.agents.open({ key: "a", runtime: "claude", keepAlive: {} })),
  ).toThrow("keepAlive is for a workflow with events");
  for (const wait of ["race", "select"] as const) {
    expect(
      await refused(async (wf) => {
        const agent = await wf.agents.open({ key: "a", runtime: "claude" });
        if (wait === "race") return wf.race("review", { done: agent, expiry: "14d" });
        for await (const _ of wf.select({ done: agent })) break;
      }),
    ).toThrow(
      "'s done waits on an agent's end, which a run without events never hears; declare events in the workflow",
    );
  }
});

test("a run id outside the grammar is refused", async () => {
  await expect(
    testWorkflow(
      caseRun(async () => null),
      { id: "a/b", event: { name: "dd.changes", data: { case: "a/b" } } },
    ),
  ).rejects.toThrow('"a/b" is not a valid id');
});

test("a wait ends with its run: a deadline while waiting settles the run and the wait", async () => {
  let ended: unknown;
  const started = Date.now();
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      await workflow.receive().catch((error: unknown) => {
        ended = error;
        throw error;
      });
      return null;
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } }, timeoutMs: 300 },
  );
  expect(() => run.value).toThrow();
  expect(Date.now() - started).toBeLessThan(2_000);
  // The wait itself was cut, not left polling.
  await Bun.sleep(50);
  expect(ended).toBeDefined();
});

test("one wait at a time", async () => {
  let second = "";
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const waiting = workflow.receive();
      second = await workflow.receive().then(
        () => "taken",
        (error: unknown) => String(error),
      );
      await waiting;
      return null;
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(second).toContain("one wait at a time");
  // The first, with nothing to take and no turn running, parked the run.
  expect(run.ending.kind).toBe("parked");
});

test("a starting event's data is checked against its schema", async () => {
  await expect(
    testWorkflow(
      caseRun(async () => null),
      // biome-ignore lint/suspicious/noExplicitAny: data a sender without tsc could send.
      { id: "k", event: { name: "dd.changes", data: { other: 1 } as any } },
    ),
  ).rejects.toThrow("dd.changes's data does not fit its schema");
});

test("a stage holds one wait", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.stage("approval-1", async () => {
        await workflow.receive();
        return workflow.receive();
      });
      return null;
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(() => run.value).toThrow("a stage holds one wait");
});

test("workflow.emit sends to its target by the target's file, and a test records it", async () => {
  const target = caseRun(async () => null);
  const run = await testWorkflow(
    defineWorkflow({
      meta: { name: "dd-tick", description: "A tick." },
      run: async (workflow) =>
        workflow.emit(target, "k", "dd.changes", { case: "k" }, { eventId: "c1" }),
      prepare: () => null,
    }),
  );
  expect(run.value).toBe("accepted");
  expect(run.emits).toEqual([
    { ref: "dd-case/k", name: "dd.changes", data: { case: "k" }, eventId: "c1" },
  ]);
});

test("a wait with nothing to take and no turn running parks the run, at its label and next timer", async () => {
  const until = new Date(Date.now() + 60 * 60_000);
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      workflow.timer("retry", until);
      await workflow.receive({ label: "3 unseen" });
      return null;
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } }, maxTimers: 0 },
  );
  expect(run.ending).toMatchObject({
    kind: "parked",
    label: "3 unseen",
    until: until.toISOString(),
  });
  expect(() => run.value).toThrow("the run parked");
});

test("code that catches its park still parks, whatever it does after", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      try {
        await workflow.receive({ label: "idle" });
      } catch {
        // Swallowed, as a careless author might.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      return "went on";
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(run.ending).toMatchObject({ kind: "parked", label: "idle" });
  expect(() => run.value).toThrow("the run parked");
});

test("a wait in a stage that parks leaves the stage unrecorded, for the next attempt to run again", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      await workflow.stage("approval-1", () => workflow.receive({ label: "approval" }));
      return null;
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(run.ending).toMatchObject({ kind: "parked", label: "approval" });
  expect(run.stages.map((s) => s.stage)).toEqual([]);
});

test("a wait beside an open stage doesn't park until the stage ends", async () => {
  const order: string[] = [];
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      await Promise.all([
        workflow.receive({ label: "idle" }),
        workflow.stage("slow", async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          order.push("slow done");
        }),
      ]);
      return null;
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(run.ending).toMatchObject({ kind: "parked", label: "idle" });
  expect(order).toEqual(["slow done"]);
  expect(run.stages).toMatchObject([{ stage: "slow", outcome: "succeeded" }]);
});

test("an event run's agents reopen on the last session of each root agent", () => {
  const turn = (agent: string, session: string, callPath: string[] = []): TurnRecord => ({
    version: 1,
    attempt: 1,
    kind: "turn",
    outcome: "answered",
    agent,
    operationId: session,
    execution: { harness: "claude", model: "m" },
    callPath,
    sessions: [{ harness: "claude", id: session }],
  });
  const kept = keptSessionsOf([
    turn("investigator", "s1"),
    turn("investigator", "s2"),
    turn("child", "s3", ["call-1"]),
  ]);
  expect([...kept]).toEqual([["investigator", { harness: "claude", sessionRef: "s2" }]]);
});

test("a participant routed to the code needs a workflow with events", async () => {
  const run = await testWorkflow(
    defineWorkflow({
      meta: { name: "plain", description: "No events." },
      run: async (workflow) => {
        await workflow.participants.connect({ key: "thread", to: "code" } as never);
        return null;
      },
      prepare: () => null,
    }),
  );
  expect(() => run.value).toThrow("needs a workflow with events");
});

test("a race takes the first of what it names, under its branch, and cancels its own timers", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const next = await workflow.race("first", {
        changes: workflow.signal("dd.changes"),
        nudge: "1h",
      });
      return {
        key: next.key,
        id: next.changes?.id ?? null,
        started: workflow.started?.id ?? null,
      };
    }),
    { ...startCase, event: { ...startCase.event, eventId: "c0" } },
  );
  expect(run.value).toEqual({ key: "changes", id: "c0", started: "c0" });
  expect(run.mailbox.filter((r) => r.kind.startsWith("timer"))).toMatchObject([
    { kind: "timer", name: "first@nudge", when: "1h" },
    { kind: "timer-cancelled", name: "first@nudge" },
  ]);
});

test("a timer due wins a race; a wait it doesn't name leaves an event for a later receive", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const late = workflow.timer("late", new Date(0));
      const next = await workflow.race("quiet", { late, other: workflow.timer("other", "1h") });
      const rest = await workflow.receive();
      return { key: next.key, at: next.late?.at ?? null, rest: rest.map((e) => e.name) };
    }),
    startCase,
  );
  expect(run.value).toEqual({
    key: "late",
    at: new Date(0).toISOString(),
    rest: ["dd.changes"],
  });
});

test("sleep past its time goes on; one still to come parks the run until it", async () => {
  const until = new Date(Date.now() + 60 * 60_000);
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.sleep("past", new Date(0));
      await workflow.sleep("later", until);
      return null;
    }),
    { ...startCase, maxTimers: 0 },
  );
  expect(run.ending).toMatchObject({ kind: "parked", until: until.toISOString() });
});

test("select takes each event it names, one at a time, in the order of their at", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const seen: string[] = [];
      for await (const next of workflow.select({
        changes: workflow.signal("dd.changes"),
        b: workflow.timer("b", new Date(1)),
        a: workflow.timer("a", new Date(0)),
      })) {
        seen.push(next.key);
        if (seen.length === 3) break;
      }
      return seen;
    }),
    startCase,
  );
  // In order of their at: b was due in 1970, before the run's event arrived.
  expect(run.value).toEqual(["a", "b", "changes"]);
});

test("a timer asked again with another time keeps the first, and says so", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const first = workflow.timer("remind", "2d");
      const again = workflow.timer("remind", "3d");
      return first.due === again.due;
    }),
    startCase,
  );
  expect(run.value).toBe(true);
  expect(run.logs.map((l) => l.message).join("\n")).toContain("timer remind is due");
});

test("a wait's sources are checked: a promise, a name with @, a race in a stage", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const errors: string[] = [];
      const attempt = async (work: () => unknown) => {
        try {
          await work();
        } catch (error) {
          errors.push(String(error));
        }
      };
      await attempt(() => workflow.race("p", { done: Promise.resolve() } as never));
      await attempt(() => workflow.timer("a@b", "1h"));
      await attempt(() => workflow.sleep("s", "30x" as never));
      await workflow.stage("in-stage", async () => {
        await attempt(() => workflow.race("r", { later: "1h" }));
      });
      return errors;
    }),
    startCase,
  );
  const errors = run.value as string[];
  expect(errors[0]).toContain("is not a source");
  expect(errors[1]).toContain("timer a@b");
  expect(errors[2]).toContain("a decimal and s, m, h or d");
  expect(errors[3]).toContain("a race is recorded on its own");
});

test("a race's name answers once an attempt; a refused race sets none of its timers", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const errors: string[] = [];
      await workflow
        .race("p", { a: "1h", done: Promise.resolve() } as never)
        .catch((error: unknown) => errors.push(String(error)));
      await workflow.sleep("pause", new Date(0));
      await workflow
        .sleep("pause", new Date(0))
        .catch((error: unknown) => errors.push(String(error)));
      return errors;
    }),
    startCase,
  );
  const errors = run.value as string[];
  expect(errors[0]).toContain("is not a source");
  expect(errors[1]).toContain("named per round");
  expect(run.timers.map((t) => t.name)).toEqual(["pause@sleep"]);
});

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

test("--from-stage reruns what a replay enters: a stage behind an acknowledged receive keeps its record", async () => {
  const handled: string[] = [];
  const workflow = caseRun(async (wf) => {
    await wf.stage("setup", async () => undefined);
    for (const event of await wf.receive())
      await wf.stage(`handle-${event.id}`, async () => {
        handled.push(event.id);
      });
    await wf.receive();
    return null;
  });
  const runRoot = runDirs.tempRunDir();
  const run = await createRun(runRoot, {
    id: "k",
    workflow: workflow.meta.name,
    argv: [],
    cwd: process.cwd(),
    sandbox: null,
  });
  await appendMailbox(run.dir, {
    version: MAILBOX_RECORD_VERSION,
    at: new Date().toISOString(),
    kind: "event",
    id: "e1",
    name: "dd.changes",
    data: { case: "k" },
    from: "operator",
  });
  const attempt = (n: number, fromStage?: string) =>
    runWorkflow(workflow, null, {
      runRoot,
      run: {
        dir: run.dir,
        id: "k",
        attempt: n,
        events: true,
        park: async () => undefined,
        ...(fromStage === undefined ? {} : { fromStage }),
      },
      runtime: { aliases: OPERATOR_ALIASES, host: createSingleSessionHostFactory(answering()) },
      deadline: future(),
    });
  const parked = (error: unknown) => expect(String(error)).toContain("parked");
  await attempt(1).then(() => expect.unreachable(), parked);
  expect(handled).toEqual(["e1"]);
  expect([...(await readStageRecords(run.dir)).keys()].sort()).toEqual(["handle-e1", "setup"]);
  // Redone from setup: e1 was acknowledged, so the replay never hands it back, and its stage,
  // never entered, keeps its record and isn't run again.
  await attempt(2, "setup").then(() => expect.unreachable(), parked);
  expect(handled).toEqual(["e1"]);
  const records = await readStageRecords(run.dir);
  expect([records.get("setup")?.attempt, records.get("handle-e1")?.attempt]).toEqual([2, 1]);
  expect(readdirSync(join(run.dir, "replaced"))).toEqual(["setup.1.json"]);
});
