import { afterAll, describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, WorkflowContext } from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import { createFakeAdapter } from "@agentswf/harness/testing";
import Type from "typebox";
import { createFakeDecisionProvider } from "./decisions/fake";
import { OPERATOR_ALIASES } from "./operator-aliases";
import { readStageRecords, readTurns } from "./runs";
import { createTempRunDirs, DOC, future, runAttempt, runNew, workflowOf } from "./testing";
import { WorkflowRunError } from "./workflow-runner";
import { answer, reply, testWorkflow } from "./workflow-testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

/** Asks `worker` once, in whatever stage it is called from. */
async function ask(workflow: WorkflowContext, prompt: string, label?: string) {
  const worker = await workflow.agents.open({ key: "worker", runtime: "codex" });
  const { outcome } = await worker.run({
    prompt,
    schema: DOC,
    ...(label === undefined ? {} : { label }),
  });
  if (outcome.kind !== "answered") throw new Error(`no answer: ${outcome.kind}`);
  return outcome.value as { path: string };
}

describe("workflow.stage", () => {
  test("a stage runs its work, returns its value, and records it with its sessions", async () => {
    const run = await testWorkflow(
      workflowOf(
        async (workflow) => {
          const doc = await workflow.stage(
            "doc-review",
            { result: DOC, summary: (value) => value.path },
            () => ask(workflow, "Review the doc.", "review"),
          );
          await workflow.stage("notify", async () => {});
          return doc;
        },
        { version: "1.2.0" },
      ),
      null,
      { agents: { worker: answer(DOC, { path: "docs/AIRS-1515.md" }) } },
    );
    expect(run.value).toEqual({ path: "docs/AIRS-1515.md" });
    expect(run.stages).toEqual([
      {
        version: 1,
        stage: "doc-review",
        attempt: 1,
        outcome: "succeeded",
        started: expect.any(String),
        ended: expect.any(String),
        workflowVersion: "1.2.0",
        sessions: [{ agent: "worker", harness: "codex", session: expect.any(String) }],
        summary: "docs/AIRS-1515.md",
        value: { path: "docs/AIRS-1515.md" },
      },
      expect.objectContaining({ stage: "notify", outcome: "succeeded", sessions: [] }),
    ]);
    expect(run.stages[1]).not.toHaveProperty("value");
    expect(run.turns.map(({ stage, label }) => ({ stage, label }))).toEqual([
      { stage: "doc-review", label: "review" },
    ]);
  });

  test("an agent's turns carry the stage each ran in, and none between stages", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await ask(workflow, "Before.");
        await workflow.stage("implement", { result: DOC }, () => ask(workflow, "Implement."));
        await workflow.stage("review", { result: DOC }, async () => {
          const [a] = await workflow.parallel([1, 2], () => ask(workflow, "Review."));
          return a!;
        });
        return null;
      }),
      null,
      { agents: { worker: answer(DOC, { path: "x" }) } },
    );
    expect(run.turnsOf("worker").map((turn) => turn.stage)).toEqual([
      undefined,
      "implement",
      "review",
      "review",
    ]);
  });

  test.each([
    [
      "a second entry",
      async (workflow: WorkflowContext) => {
        await workflow.stage("qa", async () => {});
        await workflow.stage("qa", async () => {});
      },
      "stage qa was entered twice; a loop goes inside one stage",
    ],
    [
      "a stage inside another",
      async (workflow: WorkflowContext) => {
        await workflow.stage("outer", () => workflow.stage("inner", async () => {}));
      },
      "stage inner was entered while stage outer is open",
    ],
    [
      "a name that can't be a file",
      async (workflow: WorkflowContext) => {
        await workflow.stage("Doc Review", async () => {});
      },
      "stage \"Doc Review\" is not a stage's name: lowercase letters, digits and '-'",
    ],
  ])("%s fails the attempt", async (_name, body, reason) => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await body(workflow);
        return null;
      }),
      null,
    );
    expect(() => run.value).toThrow(reason);
  });

  test("two stages at once fail the attempt, and the first is recorded once", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow.parallel(["a", "b"], (name) =>
          workflow.stage(name, () => new Promise((resolve) => setTimeout(resolve, 20))),
        );
        return null;
      }),
      null,
    );
    expect(() => run.value).toThrow("stage b was entered while stage a is open");
    expect(run.stages.map(({ stage }) => stage)).toEqual(["a"]);
  });

  test("a stage that throws cancels the turns still open in it, then records them failed", async () => {
    let cancelled: AbortSignal | undefined;
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        try {
          await workflow.stage("qa", async () => {
            const worker = await workflow.agents.open({ key: "worker", runtime: "codex" });
            void worker.run({ prompt: "Check the preview.", schema: DOC });
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error("no preview environment");
          });
        } catch (error) {
          // Before the run ends: the stage's own cancellation, not the run's cleanup.
          return { cancelled: cancelled?.aborted ?? false, error: String(error) };
        }
        return null;
      }),
      null,
      {
        agents: {
          worker: answer(DOC, (turn) => {
            cancelled = turn.signal;
            return new Promise(() => {});
          }),
        },
      },
    );
    expect(run.value).toEqual({ cancelled: true, error: "Error: no preview environment" });
    expect(run.stages).toEqual([
      expect.objectContaining({
        stage: "qa",
        outcome: "failed",
        reason: "no preview environment",
        sessions: [expect.objectContaining({ agent: "worker", harness: "codex" })],
      }),
    ]);
    expect(run.turns.map(({ stage, outcome }) => ({ stage, outcome }))).toEqual([
      { stage: "qa", outcome: "cancelled" },
    ]);
  });

  test("a value its schema rejects fails the stage now, as does a value where none is expected", async () => {
    const wrong = await testWorkflow(
      workflowOf(async (workflow) =>
        workflow.stage("doc-review", { result: DOC }, async () => ({ path: 7 }) as never),
      ),
      null,
    );
    expect(() => wrong.value).toThrow("stage doc-review's value does not fit its result");
    expect(wrong.stages[0]).toMatchObject({ outcome: "failed" });
    expect(wrong.stages[0]).not.toHaveProperty("value");

    const unexpected = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow.stage("notify", (async () => "sent") as unknown as () => Promise<void>);
        return null;
      }),
      null,
    );
    expect(() => unexpected.value).toThrow("stage notify has no result schema");

    const missing = await testWorkflow(
      workflowOf(async (workflow) =>
        workflow.stage("doc-review", { result: DOC }, (async () => undefined) as never),
      ),
      null,
    );
    expect(() => missing.value).toThrow("stage doc-review returned nothing");
  });

  test("a value is handed back as a continue would read it: through JSON", async () => {
    const SPARSE = Type.Object({ path: Type.String(), note: Type.Optional(Type.String()) });
    const run = await testWorkflow(
      workflowOf(async (workflow) =>
        workflow.stage("doc-review", { result: SPARSE }, async () => {
          // As TypeScript lets an optional field be written.
          const doc: { path: string; note?: string } = { path: "a", note: undefined };
          return doc as JsonValue;
        }),
      ),
      null,
    );
    expect(run.value).toStrictEqual({ path: "a" });
  });

  test("a stage the run's deadline ends is recorded failed", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow.stage("qa", { result: DOC }, () => ask(workflow, "Check."));
        return null;
      }),
      null,
      { agents: { worker: reply.hang() }, timeoutMs: 300, stallMs: 5_000 },
    );
    expect(() => run.value).toThrow();
    expect(run.stages).toEqual([
      expect.objectContaining({
        stage: "qa",
        outcome: "failed",
        reason: "no answer: timed-out",
        sessions: [expect.objectContaining({ agent: "worker" })],
      }),
    ]);
  });

  test("a summary that throws leaves the line out, not the stage", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) =>
        workflow.stage(
          "doc-review",
          {
            result: DOC,
            summary: () => {
              throw new Error("bad summary");
            },
          },
          async () => ({ path: "a" }),
        ),
      ),
      null,
    );
    expect(run.value).toEqual({ path: "a" });
    expect(run.stages[0]).not.toHaveProperty("summary");
    expect(run.logs.map((log) => log.message)).toContain(
      "awf: stage doc-review's summary failed: bad summary",
    );
  });

  test("a decision asked in a stage records it", async () => {
    const result = await runNew(
      workflowOf(async (workflow) => {
        const ask = (key: string) =>
          workflow.decisions.decide({
            key,
            model: "jev",
            state: "Checkout charges twice",
            questions: { bug: { type: "yes-no", instructions: "Is it a bug?" } },
          });
        await ask("before");
        await workflow.stage("triage", async () => {
          await ask("triage");
        });
        return null;
      }),
      null,
      {
        runRoot: runDirs.tempRunDir(),
        runtime: {
          aliases: OPERATOR_ALIASES,
          host: createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) })),
        },
        decisions: {
          providers: { fake: createFakeDecisionProvider() },
          aliases: { jev: { provider: "fake", model: "jev" } },
        },
        deadline: future(),
      },
    );
    expect(result.decisions?.map(({ key, stage }) => ({ key, stage }))).toEqual([
      { key: "before", stage: undefined },
      { key: "triage", stage: "triage" },
    ]);
  });

  test("a workflow without stages writes no stage record, and its turns no stage", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => ask(workflow, "Do it.")),
      null,
      { agents: { worker: answer(DOC, { path: "x" }) } },
    );
    expect(run.stages).toEqual([]);
    expect(run.turns[0]).not.toHaveProperty("stage");
  });
});

describe("turns.jsonl", () => {
  test("each settled turn is appended with its attempt and stage", async () => {
    const runRoot = runDirs.tempRunDir();
    const dir = join(runRoot, "staged", "r1");
    const result = await runAttempt(
      workflowOf(async (workflow) => {
        await ask(workflow, "Before.", "before");
        await workflow.stage("implement", { result: DOC }, async () => {
          const worker = await workflow.agents.open({ key: "worker", runtime: "codex" });
          await worker.compact({ prompt: "Keep the plan." });
          return ask(workflow, "Do.");
        });
        return null;
      }),
      { runRoot, attempt: 3 },
    );
    const turns = await readTurns(dir);
    expect(
      turns.map(({ version, attempt, kind, agent, stage, label, outcome }) => ({
        version,
        attempt,
        kind,
        agent,
        stage,
        label,
        outcome,
      })),
    ).toEqual([
      {
        version: 1,
        attempt: 3,
        kind: "turn",
        agent: "worker",
        stage: undefined,
        label: "before",
        outcome: "answered",
      },
      // The compaction, then the turn.
      {
        version: 1,
        attempt: 3,
        kind: "compact",
        agent: "worker",
        stage: "implement",
        label: undefined,
        outcome: "answered",
      },
      {
        version: 1,
        attempt: 3,
        kind: "turn",
        agent: "worker",
        stage: "implement",
        label: undefined,
        outcome: "answered",
      },
    ]);
    expect(result.usage.map((operation) => operation.stage)).toEqual([
      undefined,
      "implement",
      "implement",
    ]);
    expect((await readStageRecords(dir)).get("implement")).toMatchObject({ attempt: 3 });
  });

  test("a line a crash tore is skipped, and the next attempt's turns start lines of their own", async () => {
    const runRoot = runDirs.tempRunDir();
    const dir = join(runRoot, "staged", "r1");
    const attempt = (n: number) =>
      runAttempt(
        workflowOf(async (workflow) => ask(workflow, "Do.")),
        { runRoot, attempt: n },
      );
    await attempt(1);
    // As a crash mid-append leaves it: no newline.
    await appendFile(join(dir, "turns.jsonl"), '{"version":1,"attempt":1,"ag');
    await attempt(2);
    expect((await readTurns(dir)).map((record) => record.attempt)).toEqual([1, 2]);
    expect(await readTurns(join(dir, "none"))).toEqual([]);
  });

  test("a run stopped mid-stage ends in that stage, recorded failed once before its result settles", async () => {
    const runRoot = runDirs.tempRunDir();
    const dir = join(runRoot, "staged", "r1");
    const controller = new AbortController();
    const adapter = createFakeAdapter({
      harnesses: ["codex"],
      script: () => ({
        act: async (turn) => {
          controller.abort("SIGINT");
          await new Promise((resolve) => turn.signal.addEventListener("abort", resolve));
        },
      }),
    });
    const stopped = runAttempt(
      workflowOf(async (workflow) => {
        await workflow.stage("qa", { result: DOC }, () => ask(workflow, "Check."));
        await workflow.stage("mr", async () => {});
        return null;
      }),
      { runRoot, adapter, signal: controller.signal },
    );
    const error = await stopped.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkflowRunError);
    expect((error as WorkflowRunError).endedIn).toBe("qa");
    const records = await readStageRecords(dir);
    expect([...records.keys()]).toEqual(["qa"]);
    expect(records.get("qa")).toMatchObject({
      outcome: "failed",
      sessions: [expect.objectContaining({ agent: "worker" })],
    });
  });

  test("a turn its harness fails is kept as failed", async () => {
    const runRoot = runDirs.tempRunDir();
    const dir = join(runRoot, "staged", "r1");
    const adapter = createFakeAdapter({
      harnesses: ["codex"],
      script: () => ({
        act: async () => {
          throw new Error("the harness broke");
        },
      }),
    });
    const failed = runAttempt(
      workflowOf(async (workflow) => {
        await workflow.stage("qa", { result: DOC }, () => ask(workflow, "Check."));
        return null;
      }),
      { runRoot, adapter },
    );
    await expect(failed).rejects.toBeInstanceOf(WorkflowRunError);
    expect((await readTurns(dir)).map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ["qa", "failed"],
    ]);
  });

  test("a failed run still has its stage records and turns", async () => {
    const runRoot = runDirs.tempRunDir();
    const dir = join(runRoot, "staged", "r1");
    const failed = runAttempt(
      workflowOf(async (workflow) => {
        await workflow.stage("implement", { result: DOC }, () => ask(workflow, "Do."));
        await workflow.stage("qa", async () => {
          throw new Error("qa broke");
        });
        return null;
      }),
      { runRoot },
    );
    await expect(failed).rejects.toBeInstanceOf(WorkflowRunError);
    const records = await readStageRecords(dir);
    expect([...records.values()].map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ["implement", "succeeded"],
      ["qa", "failed"],
    ]);
    expect(await readTurns(dir)).toHaveLength(1);
  });
});
