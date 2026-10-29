import { expect, test } from "bun:test";
import type { TurnRecord } from "@agentswf/contract/records";
import { defineWorkflow, type EventWorkflowContext } from "@agentswf/contract/workflow";
import { caseRun, startCase } from "./testing";
import { keptSessionsOf } from "./workflow-runner";
import { testWorkflow } from "./workflow-testing";

test("the first wait takes the event that started the run, under the id it made", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const [first] = await workflow.receive({ label: "first" });
      return { run: workflow.runId, id: first?.id ?? null, data: first?.data ?? null };
    }),
    { id: "kombo", event: { name: "dd.changes", data: { case: "kombo" }, id: "83d34d7" } },
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
  expect(run.parked).toEqual({ label: "nothing yet" });
  expect(run.stages.map((record) => record.stage)).toEqual(["setup"]);
  await expect(
    testWorkflow(
      caseRun(async () => null),
      {} as { id: string },
    ),
  ).rejects.toThrow("a run of dd-case is named by its id: { id }");
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
    { id: "k", event: { name: "dd.changes", data: { case: "k" }, id: "e1" } },
  );
  expect(kept.value).toEqual(["e1"]);

  // Entered again in one attempt, a stage around a wait would return its batch forever: refused.
  const again = await testWorkflow(
    caseRun(async (workflow) => {
      for (;;) await workflow.stage("approval-1", () => workflow.receive());
    }),
    { id: "k", event: { name: "dd.changes", data: { case: "k" }, id: "e1" } },
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

test("receive on a workflow without events is an error", async () => {
  const run = await testWorkflow(
    defineWorkflow({
      meta: { name: "plain", description: "No events." },
      run: async (workflow) => {
        await (workflow as unknown as EventWorkflowContext<Record<string, never>>).receive();
        return null;
      },
      prepare: () => null,
    }),
    null,
  );
  expect(() => run.value).toThrow("receive needs a workflow with events");
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
  expect(run.parked).toBeDefined();
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
    null,
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
    { id: "k", event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(run.parked).toEqual({ label: "3 unseen", until: until.toISOString() });
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
  expect(run.parked).toEqual({ label: "idle" });
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
  expect(run.parked).toEqual({ label: "approval" });
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
  expect(run.parked).toEqual({ label: "idle" });
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
    null,
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
    { ...startCase, event: { ...startCase.event, id: "c0" } },
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
    startCase,
  );
  expect(run.parked).toEqual({ until: until.toISOString() });
});

test("select takes each event it names, one at a time, timers made in the loop too", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const seen: string[] = [];
      workflow.timer("a", new Date(0));
      for await (const next of workflow.select({
        changes: workflow.signal("dd.changes"),
        timer: workflow.timers(),
      })) {
        seen.push(next.key === "timer" ? next.timer.name : next.key);
        if (next.timer?.name === "a") workflow.timer("b", new Date(1));
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
      await attempt(() => workflow.sleep("s", "30s" as never));
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
  expect(errors[2]).toContain("days, hours or minutes");
  expect(errors[3]).toContain("a race is recorded on its own");
});
