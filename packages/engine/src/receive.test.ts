import { expect, test } from "bun:test";
import {
  defineEventWorkflow,
  defineExecutableWorkflow,
  type EventWorkflowContext,
  type JsonValue,
  type OutputSchema,
} from "@agentswf/contract/workflow";
import { testWorkflow } from "./workflow-testing";

const Changes: OutputSchema<{ case: string }> = {
  type: "object",
  properties: { case: { type: "string" } },
  required: ["case"],
};
const events = { "dd.changes": Changes };

const caseRun = (run: (workflow: EventWorkflowContext<typeof events>) => Promise<JsonValue>) =>
  defineEventWorkflow({
    definition: {
      meta: { name: "dd-case", description: "A case." },
      file: import.meta.path,
      events,
      key: (e) => e.data.case,
      starts: ["dd.changes"],
      run,
    },
  });

test("the first wait takes the event that started the run, under the key it made", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const [first] = await workflow.receive({ label: "first" });
      return { key: workflow.key, id: first?.id ?? null, data: first?.data ?? null };
    }),
    { event: { name: "dd.changes", data: { case: "kombo" }, id: "83d34d7" } },
  );
  expect(run.value).toEqual({ key: "kombo", id: "83d34d7", data: { case: "kombo" } });
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
    { event: { name: "dd.changes", data: { case: "k" } } },
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
    { event: { name: "dd.changes", data: { case: "k" }, id: "e1" } },
  );
  expect(kept.value).toEqual(["e1"]);

  // Entered again, the stage is reused: its batch read back, not a later event.
  const reused = await testWorkflow(
    caseRun(async (workflow) => {
      const first = await workflow.stage("approval-1", () => workflow.receive());
      const again = await workflow.stage("approval-1", () => workflow.receive());
      return [...first, ...again].map((e) => e.id);
    }),
    { event: { name: "dd.changes", data: { case: "k" }, id: "e1" } },
  );
  expect(reused.value).toEqual(["e1", "e1"]);

  const filtered = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.stage("approval-1", async () =>
        (await workflow.receive()).filter(() => false),
      );
      return null;
    }),
    { event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(() => filtered.value).toThrow("returned other events than its wait took");
});

test("receive on a workflow without events is an error", async () => {
  const run = await testWorkflow(
    defineExecutableWorkflow({
      definition: {
        meta: { name: "plain", description: "No events." },
        run: async (workflow) => {
          await (workflow as unknown as EventWorkflowContext<typeof events>).receive();
          return null;
        },
      },
      prepare: () => null,
    }),
    null,
  );
  expect(() => run.value).toThrow("receive needs a workflow with events");
});

test("a key outside the grammar is refused", async () => {
  await expect(
    testWorkflow(
      caseRun(async () => null),
      { event: { name: "dd.changes", data: { case: "Kombo" } } },
    ),
  ).rejects.toThrow('the key "Kombo" is not a key');
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
    { event: { name: "dd.changes", data: { case: "k" } }, timeoutMs: 300 },
  );
  expect(() => run.value).toThrow();
  expect(Date.now() - started).toBeLessThan(2_000);
  // The wait itself was cut, not left polling.
  await Bun.sleep(50);
  expect(ended).toBeDefined();
});

test("one wait at a time", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      await workflow.receive();
      const waiting = workflow.receive({ until: Date.now() + 200 });
      const second = await workflow.receive().then(
        () => "taken",
        (error: unknown) => String(error),
      );
      await waiting;
      return second;
    }),
    { event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(run.value).toContain("one wait at a time");
});

test("a starting event's data is checked against its schema", async () => {
  await expect(
    testWorkflow(
      caseRun(async () => null),
      // biome-ignore lint/suspicious/noExplicitAny: data a sender without tsc could send.
      { event: { name: "dd.changes", data: { other: 1 } as any } },
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
    { event: { name: "dd.changes", data: { case: "k" } } },
  );
  expect(() => run.value).toThrow("a stage holds one wait");
});

test("workflow.emit sends to its target by the target's file, and a test records it", async () => {
  const target = caseRun(async () => null);
  const run = await testWorkflow(
    defineExecutableWorkflow({
      definition: {
        meta: { name: "dd-tick", description: "A tick." },
        run: async (workflow) => workflow.emit(target, "dd.changes", { case: "k" }, { id: "c1" }),
      },
      prepare: () => null,
    }),
    null,
  );
  expect(run.value).toBe("accepted");
  expect(run.emits).toEqual([
    { target: import.meta.path, name: "dd.changes", data: { case: "k" }, id: "c1" },
  ]);
});
