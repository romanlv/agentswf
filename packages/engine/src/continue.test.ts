import { afterAll, describe, expect, test } from "bun:test";
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, WorkflowContext, WorkflowDefinition } from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import { createFakeAdapter } from "@agentswf/harness/testing";
import Type from "typebox";
import { OPERATOR_ALIASES } from "./operator-aliases";
import { readStageRecords, replaceStale } from "./runs";
import { createTempRunDirs, future } from "./testing";
import { runWorkflow, WorkflowRunError } from "./workflow-runner";
import { answer, testWorkflow } from "./workflow-testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const DOC = Type.Object({ path: Type.String() }, { additionalProperties: false });
const BRANCH = Type.Object({ branch: Type.String() }, { additionalProperties: false });

function workflowOf<Result extends JsonValue>(
  run: (workflow: WorkflowContext) => Promise<Result>,
  version?: string,
): WorkflowDefinition<null, Result> {
  return {
    meta: { name: "staged", description: "stages", ...(version ? { version } : {}) },
    run: (workflow) => run(workflow),
  };
}

/** Work a reused stage must never call. */
const never =
  <T>(stage: string) =>
  async (): Promise<T> => {
    throw new Error(`${stage}'s work was called`);
  };

describe("testWorkflow over recorded stages", () => {
  test("recorded stages are reused without calling their work, and the rest run", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        const worker = await workflow.agents.open({ key: "worker", runtime: "codex" });
        const doc = await workflow.stage(
          "doc-review",
          { result: DOC },
          never<{ path: string }>("doc-review"),
        );
        const impl = await workflow.stage(
          "implement",
          { result: BRANCH },
          async (): Promise<{ branch: string }> => {
            // The run 2 bug: a compaction that ran again on a continue.
            await worker.compact({ prompt: "Keep the plan." });
            throw new Error("implement's work was called");
          },
        );
        const qa = await workflow.stage("qa", { result: DOC }, async () => {
          const { outcome } = await worker.run({ prompt: `QA ${impl.branch}`, schema: DOC });
          if (outcome.kind !== "answered") throw new Error(outcome.kind);
          return outcome.value as { path: string };
        });
        return { doc: doc.path, branch: impl.branch, qa: qa.path };
      }),
      null,
      {
        recorded: { "doc-review": { path: "docs/a.md" }, implement: { branch: "feat/a" } },
        agents: { worker: answer(DOC, { path: "preview ok" }) },
      },
    );
    expect(run.value).toEqual({ doc: "docs/a.md", branch: "feat/a", qa: "preview ok" });
    expect(run.compactions).toEqual([]);
    expect(run.turns.map((turn) => [turn.stage, turn.prompt])).toEqual([["qa", "QA feat/a"]]);
    expect(run.stages.map(({ stage, attempt }) => [stage, attempt])).toEqual([
      ["doc-review", 1],
      ["implement", 1],
      ["qa", 2],
    ]);
  });

  test("a variable assigned inside a stage is lost when the stage is reused", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        let branch = "unset";
        await workflow.stage("implement", async () => {
          branch = "feat/a";
        });
        return branch;
      }),
      null,
      { recorded: { implement: undefined } },
    );
    expect(run.value).toBe("unset");
  });

  test("--from-stage redoes that stage and every one after it", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        const doc = await workflow.stage(
          "doc-review",
          { result: DOC },
          never<{ path: string }>("doc-review"),
        );
        const again = await workflow.stage("implement", { result: BRANCH }, async () => ({
          branch: `feat/${doc.path}`,
        }));
        await workflow.stage("qa", async () => {});
        return again.branch;
      }),
      null,
      {
        recorded: { "doc-review": { path: "a" }, implement: { branch: "old" }, qa: undefined },
        fromStage: "implement",
      },
    );
    expect(run.value).toBe("feat/a");
    expect(run.stages.map(({ stage, attempt }) => [stage, attempt])).toEqual([
      ["doc-review", 1],
      ["implement", 2],
      ["qa", 2],
    ]);
  });

  test("a --from-stage never reached stops the attempt", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow.stage("qa", never<void>("qa"));
        return null;
      }),
      null,
      { recorded: { qa: undefined }, fromStage: "qaa" },
    );
    expect(() => run.value).toThrow("never reached qaa");
  });

  test("a stage renamed in the code runs on a plain continue, and stops after --from-stage", async () => {
    const renamed = workflowOf(async (workflow) => {
      await workflow.stage("doc-review", never<void>("doc-review"));
      await workflow.stage("implement", async () => {});
      await workflow.stage("qa", async () => {});
      return null;
    });
    const recorded = { "doc-review": undefined, impl: undefined, qa: undefined };
    const plain = await testWorkflow(renamed, null, { recorded });
    expect(plain.value).toBeNull();
    const from = await testWorkflow(renamed, null, { recorded, fromStage: "qa" });
    expect(() => from.value).toThrow(
      "nothing recorded for implement (recorded and not reached: impl); --from-stage implement",
    );
  });

  test("a recorded value the current schema rejects stops the attempt there", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow.stage("doc-review", { result: DOC }, never<{ path: string }>("doc-review"));
        return null;
      }),
      null,
      { recorded: { "doc-review": { file: "a" } } },
    );
    expect(() => run.value).toThrow("doc-review's record no longer fits");
    expect(run.stopped?.stage).toBe("doc-review");
    expect(run.stopped?.reason).toStartWith("doc-review's record no longer fits:");
  });

  test("a stop the workflow catches still ends the attempt, moving nothing", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        try {
          await workflow.stage(
            "doc-review",
            { result: DOC },
            never<{ path: string }>("doc-review"),
          );
        } catch {
          // Goes on regardless, which a stop does not allow.
        }
        // A later stage throws the stop again rather than becoming the start point.
        await workflow.stage("qa", never<void>("qa")).catch(() => undefined);
        return null;
      }),
      null,
      { recorded: { "doc-review": { file: "a" } } },
    );
    expect(() => run.value).toThrow("stop was caught: doc-review's record no longer fits");
    expect(run.stages.map(({ stage, attempt }) => [stage, attempt])).toEqual([["doc-review", 1]]);

    const returned = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow
          .stage("doc-review", { result: DOC }, never<{ path: string }>("doc-review"))
          .catch(() => undefined);
        return null;
      }),
      null,
      { recorded: { "doc-review": { file: "a" } } },
    );
    expect(() => returned.value).toThrow("stop was caught: doc-review's record no longer fits");
    expect(returned.stopped).toBeUndefined();
  });

  test("two stages at once are refused on a continue too, when the first is reused", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await Promise.all([
          workflow.stage("a", never<void>("a")),
          workflow.stage("b", async () => {}),
        ]);
        return null;
      }),
      null,
      { recorded: { a: undefined } },
    );
    expect(() => run.value).toThrow("stage b was entered while stage a is open");
  });
});

describe("a continue's records", () => {
  /** One attempt of run r1, whose worker answers every turn. */
  async function attempt(
    root: string,
    n: number,
    workflow: WorkflowDefinition<null, JsonValue>,
    fromStage?: string,
  ) {
    const adapter = createFakeAdapter({ harnesses: ["codex"], script: () => ({}) });
    return runWorkflow(workflow, null, {
      runRoot: root,
      run: { dir: join(root, "r1"), id: "r1", attempt: n, ...(fromStage ? { fromStage } : {}) },
      runtime: { aliases: OPERATOR_ALIASES, host: createSingleSessionHostFactory(adapter) },
      deadline: future(),
    });
  }
  const outcomes = async (root: string) =>
    [...(await readStageRecords(join(root, "r1"))).values()]
      .map(({ stage, attempt, outcome }) => `${stage}:${attempt}:${outcome}`)
      .sort();
  const replaced = async (root: string) =>
    (await readdir(join(root, "r1", "replaced")).catch(() => [] as string[])).sort();
  /** doc-review and implement succeed; qa fails while `qaFails`. */
  const flow = (qaFails: boolean, extra?: string) =>
    workflowOf(async (workflow) => {
      await workflow.stage("doc-review", async () => {});
      await workflow.stage("implement", async () => {});
      await workflow.stage("qa", async () => {
        if (qaFails) throw new Error("qa broke");
      });
      if (extra) await workflow.stage(extra, async () => {});
      return null;
    });

  test("a plain continue reuses what succeeded, redoes the failed stage, and moves its old record", async () => {
    const root = runDirs.tempRunDir();
    await expect(attempt(root, 1, flow(true))).rejects.toBeInstanceOf(WorkflowRunError);
    expect(await outcomes(root)).toEqual([
      "doc-review:1:succeeded",
      "implement:1:succeeded",
      "qa:1:failed",
    ]);
    await attempt(root, 2, flow(false));
    expect(await outcomes(root)).toEqual([
      "doc-review:1:succeeded",
      "implement:1:succeeded",
      "qa:2:succeeded",
    ]);
    expect(await replaced(root)).toEqual(["qa.1.json"]);
  });

  test("--from-stage moves every record it didn't reuse, a removed stage's too", async () => {
    const root = runDirs.tempRunDir();
    await attempt(root, 1, flow(false, "notify"));
    await attempt(root, 2, flow(false), "implement");
    expect(await outcomes(root)).toEqual([
      "doc-review:1:succeeded",
      "implement:2:succeeded",
      "qa:2:succeeded",
    ]);
    expect(await replaced(root)).toEqual(["implement.1.json", "notify.1.json", "qa.1.json"]);
  });

  test("an attempt that stops before its start point moves nothing", async () => {
    const root = runDirs.tempRunDir();
    await attempt(root, 1, flow(false));
    const before = await outcomes(root);
    const changed = workflowOf(async (workflow) => {
      await workflow.stage("doc-review", { result: DOC }, never<{ path: string }>("doc-review"));
      return null;
    });
    await expect(attempt(root, 2, changed, "qa")).rejects.toBeInstanceOf(WorkflowRunError);
    expect(await outcomes(root)).toEqual(before);
    expect(await replaced(root)).toEqual([]);
  });

  test("after a crash mid-stage, or mid-move, a continue starts at that stage", async () => {
    const root = runDirs.tempRunDir();
    await attempt(root, 1, flow(false));
    // As an attempt from implement on leaves them when it dies after moving only its start
    // stage's record: implement has none, and qa's is stale.
    const stages = join(root, "r1", "stages");
    await rename(join(stages, "implement.json"), join(root, "r1", "implement.1.json"));
    await attempt(root, 3, flow(false));
    expect(await outcomes(root)).toEqual([
      "doc-review:1:succeeded",
      "implement:3:succeeded",
      "qa:3:succeeded",
    ]);
    expect(await replaced(root)).toEqual(["qa.1.json"]);
  });

  test("the start stage's record moves first: a move that fails after it leaves the rest", async () => {
    const root = runDirs.tempRunDir();
    await attempt(root, 1, flow(false));
    // A record that can't be read fails the move after implement's.
    await Bun.write(join(root, "r1", "stages", "qa.json"), "{");
    await expect(
      replaceStale(join(root, "r1"), "implement", new Set(["doc-review"])),
    ).rejects.toThrow("could not be read");
    expect(await replaced(root)).toEqual(["implement.1.json"]);
    expect((await readdir(join(root, "r1", "stages"))).sort()).toEqual([
      "doc-review.json",
      "qa.json",
    ]);
  });

  test("a record from another major version stops the attempt, moving nothing", async () => {
    const root = runDirs.tempRunDir();
    const versioned = (version: string) =>
      workflowOf(async (workflow) => {
        await workflow.stage("doc-review", async () => {});
        return null;
      }, version);
    await attempt(root, 1, versioned("1.2.0"));
    const stopped = attempt(root, 2, versioned("2.0.0"), "qa");
    await expect(stopped).rejects.toThrow();
    const cause = await stopped.catch((error: WorkflowRunError) => error.cause);
    expect(String(cause)).toContain("doc-review was recorded by 1.2.0; this is 2.0.0");
  });
});
