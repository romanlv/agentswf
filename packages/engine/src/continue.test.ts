import { afterAll, describe, expect, test } from "bun:test";
import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, WorkflowDefinition } from "@agentswf/contract/workflow";
import Type from "typebox";
import { readStageRecords } from "./runs";
import { createTempRunDirs, DOC, runAttempt, workflowOf } from "./testing";
import { WorkflowRunError } from "./workflow-runner";
import { answer, testWorkflow } from "./workflow-testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const BRANCH = Type.Object({ branch: Type.String() }, { additionalProperties: false });

/** Work a reused stage must never call. */
const never =
  <T>(stage: string) =>
  async (): Promise<T> => {
    throw new Error(`${stage}'s work was called`);
  };

/** doc-review, implement with no result, review, then qa, which reads the values before it. */
const startable = workflowOf(async (workflow) => {
  const doc = await workflow.stage(
    "doc-review",
    { result: DOC, summary: (value) => value.path },
    never<{ path: string }>("doc-review"),
  );
  await workflow.stage("implement", never<void>("implement"));
  const impl = await workflow.stage(
    "review",
    { result: BRANCH },
    never<{ branch: string }>("review"),
  );
  return await workflow.stage("qa", { result: DOC }, async () => ({
    path: `${doc.path} on ${impl.branch}`,
  }));
});

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
      await workflow.stage("implement", { result: { type: "string" } }, async () => "done");
      await workflow.stage("qa", async () => {});
      return null;
    });
    const recorded = { "doc-review": undefined, impl: "done", qa: undefined };
    const plain = await testWorkflow(renamed, null, { recorded });
    expect(plain.value).toBeNull();
    const from = await testWorkflow(renamed, null, { recorded, fromStage: "qa" });
    expect(() => from.value).toThrow(
      "nothing recorded for implement (recorded and not reached: impl)",
    );
  });

  test.each([
    [
      "a value where none is expected",
      { "doc-review": { path: "a" } },
      "doc-review's record holds a value, and the stage no longer has a result",
      undefined,
    ],
    [
      "none where one is",
      { "doc-review": undefined },
      "doc-review's record holds no value, and the stage's result now expects one",
      DOC,
    ],
  ])(
    "a recorded stage with %s stops the attempt there",
    async (_name, recorded, reason, result) => {
      const run = await testWorkflow(
        workflowOf(async (workflow) => {
          if (result)
            await workflow.stage("doc-review", { result }, never<{ path: string }>("doc-review"));
          else await workflow.stage("doc-review", never<void>("doc-review"));
          return null;
        }),
        null,
        { recorded },
      );
      expect(run.stopped).toEqual({ stage: "doc-review", reason });
    },
  );

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
    expect(() => run.value).toThrow(
      "stop was caught: doc-review's record no longer fits its result schema",
    );
    // The stage the plan stopped at was neither run nor reused, and qa never became a start point.
    expect(run.stages).toEqual([]);

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
    expect(() => returned.value).toThrow(
      "stop was caught: doc-review's record no longer fits its result schema",
    );
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

describe("a new run started at a stage", () => {
  test("stops naming every stage the start point needs a value for, with its schema", async () => {
    const run = await testWorkflow(startable, null, { fromStage: "qa" });
    expect(run.stopped).toEqual({
      reason: "nothing recorded for doc-review",
      stage: "doc-review",
      needs: [
        { stage: "doc-review", schema: DOC },
        { stage: "review", schema: BRANCH },
      ],
    });
    // Looking on past a stand-in records nothing, not even the stage that returns nothing.
    expect(run.stages).toEqual([]);
  });

  test("looking on starts no turn: the attempt stops there with what it found", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        const worker = await workflow.agents.open({ key: "worker", runtime: "codex" });
        const doc = await workflow.stage(
          "doc-review",
          { result: DOC },
          never<{ path: string }>("doc-review"),
        );
        await worker.run({ prompt: `Read ${doc.path}` });
        await workflow.stage("review", { result: BRANCH }, never<{ branch: string }>("review"));
        await workflow.stage("qa", async () => {});
        return null;
      }),
      null,
      { fromStage: "qa" },
    );
    expect(run.stopped?.needs?.map(({ stage }) => stage)).toEqual(["doc-review"]);
    expect(run.turns).toEqual([]);
  });

  test("a stage that returns nothing is passed, and the next stops for its value", async () => {
    const run = await testWorkflow(startable, null, {
      fromStage: "qa",
      values: { "doc-review": { path: "docs/a.md" } },
    });
    expect(run.stopped).toMatchObject({ stage: "review", needs: [{ stage: "review" }] });
    expect(run.stages.map(({ stage, provided, summary }) => [stage, provided, summary])).toEqual([
      ["doc-review", true, "docs/a.md"],
      ["implement", true, undefined],
    ]);
  });

  test("with every value given, they are provided without calling their work, and the rest run", async () => {
    const run = await testWorkflow(startable, null, {
      fromStage: "qa",
      values: { "doc-review": { path: "docs/a.md" }, review: { branch: "feat/a" } },
    });
    expect(run.value).toEqual({ path: "docs/a.md on feat/a" });
    expect(run.stages.map(({ stage, provided }) => [stage, provided ?? false])).toEqual([
      ["doc-review", true],
      ["implement", true],
      ["review", true],
      ["qa", false],
    ]);
  });

  test("a value that doesn't fit its stage's result stops, with why", async () => {
    const run = await testWorkflow(startable, null, {
      fromStage: "qa",
      values: { "doc-review": { file: "docs/a.md" } },
    });
    expect(run.stopped?.reason).toStartWith(
      "doc-review's value in --values does not fit its result:",
    );
    expect(run.stopped?.needs?.map(({ stage }) => stage)).toEqual(["doc-review", "review"]);
  });
});

describe("a continue's records", () => {
  const attempt = (
    root: string,
    n: number,
    workflow: WorkflowDefinition<null, JsonValue>,
    fromStage?: string,
    values?: Record<string, JsonValue>,
  ) => runAttempt(workflow, { runRoot: root, attempt: n, fromStage, values });
  const outcomes = async (root: string) =>
    [...(await readStageRecords(join(root, "staged", "r1"))).values()]
      .map(({ stage, attempt, outcome }) => `${stage}:${attempt}:${outcome}`)
      .sort();
  const replaced = async (root: string) =>
    (await readdir(join(root, "staged", "r1", "replaced")).catch(() => [] as string[])).sort();
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
    const versioned = (version: string) =>
      workflowOf(
        async (workflow) => {
          await workflow.stage("doc-review", { result: { type: "string" } }, async () => "a.md");
          await workflow.stage("qa", async () => {});
          return null;
        },
        { version },
      );
    await attempt(root, 1, versioned("1.2.0"));
    const before = await outcomes(root);
    const stopped = attempt(root, 2, versioned("2.0.0"), "qa");
    await expect(stopped).rejects.toBeInstanceOf(WorkflowRunError);
    const cause = await stopped.catch((error: WorkflowRunError) => error.cause);
    expect(String(cause)).toContain("doc-review was recorded by 1.2.0; this is 2.0.0");
    expect(await outcomes(root)).toEqual(before);
    expect(await replaced(root)).toEqual([]);
  });

  test("a continue reuses what was provided, and takes values for the rest", async () => {
    const root = runDirs.tempRunDir();
    const first = attempt(root, 1, startable, "qa", { "doc-review": { path: "docs/a.md" } });
    await expect(first).rejects.toBeInstanceOf(WorkflowRunError);
    const second = await attempt(root, 2, startable, "qa", { review: { branch: "feat/a" } });
    expect(second.value).toEqual({ path: "docs/a.md on feat/a" });
    expect(await outcomes(root)).toEqual([
      "doc-review:1:succeeded",
      "implement:1:succeeded",
      "qa:2:succeeded",
      "review:2:succeeded",
    ]);
  });

  test("after a crash mid-stage, or mid-move, a continue starts at that stage", async () => {
    const root = runDirs.tempRunDir();
    await attempt(root, 1, flow(false));
    // As an attempt from implement on leaves them when it dies after moving only its start
    // stage's record: implement has none, and qa's is stale.
    const stages = join(root, "staged", "r1", "stages");
    await rename(join(stages, "implement.json"), join(root, "staged", "r1", "implement.1.json"));
    await attempt(root, 3, flow(false));
    expect(await outcomes(root)).toEqual([
      "doc-review:1:succeeded",
      "implement:3:succeeded",
      "qa:3:succeeded",
    ]);
    expect(await replaced(root)).toEqual(["qa.1.json"]);
  });

  test("a stage stopped in one attempt runs again in the next", async () => {
    const root = runDirs.tempRunDir();
    const stopping = (stop: boolean) =>
      workflowOf(async (workflow) => {
        await workflow.stage("doc-review", async () => {});
        await workflow.stage("qa", async () => {
          if (stop) workflow.stop("no preview");
        });
        return null;
      });
    await expect(attempt(root, 1, stopping(true))).rejects.toBeInstanceOf(WorkflowRunError);
    expect(await outcomes(root)).toEqual(["doc-review:1:succeeded", "qa:1:stopped"]);
    await attempt(root, 2, stopping(false));
    expect(await outcomes(root)).toEqual(["doc-review:1:succeeded", "qa:2:succeeded"]);
    expect(await replaced(root)).toEqual(["qa.1.json"]);
  });
});

describe("workflow.stop", () => {
  test("inside a stage, it records the stage stopped, and a continue redoes it", async () => {
    let calls = 0;
    const flow = workflowOf(async (workflow) => {
      await workflow.stage("doc-review", async () => {});
      const doc = await workflow.stage("qa", { result: DOC }, async () => {
        calls += 1;
        if (calls === 1) workflow.stop("no preview environment");
        return { path: "ok" };
      });
      return doc.path;
    });
    const first = await testWorkflow(flow, null);
    expect(() => first.value).toThrow("no preview environment");
    expect(first.stopped).toEqual({ reason: "no preview environment", stage: "qa" });
    expect(first.stages.map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ["doc-review", "succeeded"],
      ["qa", "stopped"],
    ]);
    expect(first.stages[1]).toMatchObject({ reason: "no preview environment" });

    const second = await testWorkflow(flow, null, { recorded: { "doc-review": undefined } });
    expect(second.value).toBe("ok");
    expect(calls).toBe(2);
  });

  test("between stages, it changes no record, and a continue checks again", async () => {
    const flow = workflowOf(async (workflow) => {
      const doc = await workflow.stage("doc-review", { result: DOC }, async () => ({ path: "x" }));
      if (doc.path === "x") workflow.stop("no doc");
      return null;
    });
    const first = await testWorkflow(flow, null);
    expect(first.stopped).toEqual({ reason: "no doc" });
    expect(first.stages.map(({ outcome }) => outcome)).toEqual(["succeeded"]);
    const again = await testWorkflow(flow, null, { recorded: { "doc-review": { path: "x" } } });
    expect(again.stopped).toEqual({ reason: "no doc" });
  });

  test("before any stage, it stops the attempt", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => workflow.stop("not ready")),
      null,
    );
    expect(run.stopped).toEqual({ reason: "not ready" });
    expect(run.stages).toEqual([]);
  });

  test("caught inside a stage, it fails that stage; caught between stages, the attempt", async () => {
    const inside = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow.stage("qa", async () => {
          try {
            workflow.stop("no preview");
          } catch {}
        });
        return null;
      }),
      null,
    );
    expect(() => inside.value).toThrow("stop was caught: no preview");
    expect(inside.stopped).toBeUndefined();
    expect(inside.stages).toEqual([
      expect.objectContaining({
        stage: "qa",
        outcome: "failed",
        reason: "stop was caught: no preview",
      }),
    ]);

    const between = await testWorkflow(
      workflowOf(async (workflow) => {
        try {
          workflow.stop("no doc");
        } catch {}
        return null;
      }),
      null,
    );
    expect(() => between.value).toThrow("stop was caught: no doc");
  });

  test("called beside a stage, not in it, it stops between stages", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await Promise.all([
          workflow.stage("a", () => new Promise<void>((resolve) => setTimeout(resolve, 20))),
          (async () => {
            await Promise.resolve();
            workflow.stop("from beside");
          })(),
        ]);
        return null;
      }),
      null,
    );
    expect(run.stopped).toEqual({ reason: "from beside" });
  });

  test("the first stop is kept; once caught, the next stage fails the attempt as caught", async () => {
    const twice = await testWorkflow(
      workflowOf(async (workflow) => {
        try {
          workflow.stop("first");
        } catch {}
        return workflow.stop("second");
      }),
      null,
    );
    expect(twice.stopped).toEqual({ reason: "first" });

    const afterCaught = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow
          .stage("a", async () => {
            try {
              workflow.stop("in a");
            } catch {}
          })
          .catch(() => undefined);
        await workflow.stage("b", async () => {});
        return null;
      }),
      null,
    );
    expect(() => afterCaught.value).toThrow("stop was caught: in a");
    expect(afterCaught.stopped).toBeUndefined();
    expect(afterCaught.stages.map(({ stage, outcome }) => [stage, outcome])).toEqual([
      ["a", "failed"],
    ]);
  });

  test("caught between stages, a later stage fails the attempt as caught, not stopped", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        try {
          workflow.stop("no doc");
        } catch {}
        await workflow.stage("qa", async () => {});
        return null;
      }),
      null,
    );
    expect(() => run.value).toThrow("stop was caught: no doc");
    expect(run.stopped).toBeUndefined();
    expect(run.stages).toEqual([]);
  });

  test("inside a parallel in a stage, it stops that stage", async () => {
    const run = await testWorkflow(
      workflowOf(async (workflow) => {
        await workflow.stage("review", async () => {
          await workflow.parallel(["codex", "opus"], async (who) => {
            if (who === "opus") workflow.stop("opus found a blocker");
          });
        });
        return null;
      }),
      null,
    );
    expect(run.stopped).toEqual({ reason: "opus found a blocker", stage: "review" });
    expect(run.stages[0]).toMatchObject({ outcome: "stopped" });
  });
});
