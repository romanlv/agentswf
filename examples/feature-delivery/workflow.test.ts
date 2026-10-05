import { describe, expect, test } from "bun:test";
import { answer, reply, type Script, testWorkflow } from "@agentswf/engine/workflow-testing";
import { REVIEW_VERDICT_SCHEMA as VERDICT, WORK_UPDATE_SCHEMA as WORK } from "./schema";
import { featureDelivery } from "./workflow";

const args = {
  ticket: "ABC-1",
  runtimes: { planner: "claude", implementer: "codex", reviewer: "codex", additionalReviewers: [] },
};
const doc = "docs/ABC-1.md";
const ready = (summary: string) => answer(VERDICT, { kind: "ready", summary });
const planned = { docPath: doc, summary: "plan", decisions: [] };

/** Every agent does its part at once: the doc is approved, then the code. */
const happyPath: Record<string, Script> = {
  planner: answer(WORK, planned),
  reviewer: ready("ok"),
  implementer: answer(WORK, { docPath: doc, summary: "built", decisions: ["LRU"] }),
};

describe("feature-delivery", () => {
  test("the reviewer asks for one change, the planner makes it, and the feature ships", async () => {
    const run = await testWorkflow(featureDelivery, args, {
      agents: {
        ...happyPath,
        planner: [
          answer(WORK, planned),
          answer(WORK, { docPath: doc, summary: "plan v2", decisions: ["name the cache"] }),
        ],
        reviewer: [
          answer(VERDICT, { kind: "changes-requested", feedback: ["name the cache"] }),
          ready("doc ok"),
          ready("code ok"),
        ],
      },
    });
    expect(run.value).toEqual({
      docPath: doc,
      summary: "built",
      decisions: ["LRU"],
      review: { primary: "code ok", additional: [] },
    });
    expect(run.turnsOf("planner")[1]!.prompt).toContain("- name the cache");
    expect(run.turnsOf("reviewer").map((turn) => turn.label)).toEqual([
      "Review ticket doc",
      "Review ticket doc",
      "Review implementation",
    ]);
  });

  test("a full run records each stage with its summary", async () => {
    const run = await testWorkflow(featureDelivery, args, { agents: happyPath });
    expect(run.stages.map(({ stage, outcome, summary }) => [stage, outcome, summary])).toEqual([
      ["ticket-doc", "succeeded", doc],
      ["doc-review", "succeeded", "ok"],
      ["implementation", "succeeded", "built"],
      ["implementation-review", "succeeded", "ok"],
      ["additional-review", "succeeded", "0 additional reviews"],
    ]);
  });

  test("a continue after the implementation stopped reuses the plan and redoes the rest", async () => {
    const run = await testWorkflow(featureDelivery, args, {
      recorded: {
        "ticket-doc": planned,
        "doc-review": { summary: "doc ok", work: planned },
      },
      agents: {
        reviewer: ready("code ok"),
        implementer: answer(WORK, { docPath: doc, summary: "built", decisions: ["LRU"] }),
      },
    });
    expect(run.value).toMatchObject({ summary: "built" });
    // The plan and its review are the first attempt's; the planner is opened, never asked.
    expect(run.turnsOf("planner")).toEqual([]);
    expect(run.turnsOf("implementer")[0]!.prompt).toContain(`from ${doc}`);
    expect(run.stages.map(({ stage, attempt }) => [stage, attempt])).toEqual([
      ["ticket-doc", 1],
      ["doc-review", 1],
      ["implementation", 2],
      ["implementation-review", 2],
      ["additional-review", 2],
    ]);
  });

  test("a continue that runs only the additional reviews briefs the fresh agents it asks", async () => {
    const built = { docPath: doc, summary: "built an LRU cache", decisions: ["LRU"] };
    const run = await testWorkflow(
      featureDelivery,
      {
        ...args,
        runtimes: {
          ...args.runtimes,
          additionalReviewers: [{ name: "security", runtime: "claude" }],
        },
      },
      {
        recorded: {
          "ticket-doc": planned,
          "doc-review": { summary: "doc ok", work: planned },
          implementation: built,
          "implementation-review": { summary: "code ok", work: built },
        },
        agents: {
          "additional-reviewer:security": answer(VERDICT, {
            kind: "changes-requested",
            feedback: ["escape the key"],
          }),
          implementer: answer(WORK, { ...built, summary: "escaped" }),
          reviewer: ready("escape ok"),
        },
      },
    );
    expect(run.value).toMatchObject({ summary: "escaped", review: { primary: "escape ok" } });
    expect(run.turnsOf("additional-reviewer:security")[0]!.prompt).toContain("ABC-1");
    expect(run.turnsOf("implementer")[0]!.prompt).toContain("your implementation of ABC-1");
    const [review] = run.turnsOf("reviewer");
    expect(run.turnsOf("reviewer")).toHaveLength(1);
    expect(review!.prompt).toContain("Review the implementation of ABC-1");
    expect(review!.prompt).toContain("- security: escape the key");
    expect(run.stages.map(({ stage, attempt }) => [stage, attempt])).toEqual([
      ["ticket-doc", 1],
      ["doc-review", 1],
      ["implementation", 1],
      ["implementation-review", 1],
      ["additional-review", 2],
    ]);
  });

  test("the planner opens with its skill and its labels", async () => {
    const run = await testWorkflow(featureDelivery, args, { agents: happyPath });
    expect(run.agentOf("planner")).toMatchObject({
      skills: ["ticket-doc"],
      labels: { role: "planner", ticket: "ABC-1" },
    });
  });

  test("a reviewer that never approves hits the revision limit", async () => {
    const run = await testWorkflow(
      featureDelivery,
      { ...args, maxRevisionRounds: 2 },
      {
        agents: {
          planner: answer(WORK, (turn) => ({
            docPath: doc,
            summary: `plan v${turn.n}`,
            decisions: [],
          })),
          reviewer: answer(VERDICT, { kind: "changes-requested", feedback: ["more detail"] }),
        },
      },
    );
    expect(run.stopped).toEqual({
      stage: "doc-review",
      reason: "ticket doc revision limit reached",
    });
    // The first plan and two revisions, each reviewed.
    expect(run.turnsOf("planner")).toHaveLength(3);
    expect(run.turnsOf("reviewer")).toHaveLength(3);
  });

  test("a planner that goes quiet is nudged once, then the delivery stops", async () => {
    const run = await testWorkflow(featureDelivery, args, { agents: { planner: reply.silent() } });
    expect(run.stopped).toMatchObject({ stage: "ticket-doc" });
    expect(run.turnsOf("planner").map((turn) => turn.nudge)).toEqual([false, true]);
  });

  test("an inconclusive review stops with the reviewer's reason", async () => {
    const run = await testWorkflow(featureDelivery, args, {
      agents: {
        ...happyPath,
        reviewer: answer(VERDICT, { kind: "inconclusive", reason: "cannot open the doc" }),
      },
    });
    expect(run.stopped).toEqual({ stage: "doc-review", reason: "cannot open the doc" });
  });

  test("the planner and the reviewer on one model are refused", async () => {
    const run = await testWorkflow(featureDelivery, {
      ...args,
      runtimes: { ...args.runtimes, planner: "codex" },
    });
    expect(() => run.value).toThrow("planner and primary reviewer must use different models");
    expect(run.turns).toEqual([]);
  });

  describe("the ticket document stays the same file", () => {
    test("a revision that moves it stops the doc review", async () => {
      const run = await testWorkflow(featureDelivery, args, {
        agents: {
          planner: [
            answer(WORK, planned),
            answer(WORK, { docPath: "docs/other.md", summary: "moved", decisions: [] }),
          ],
          reviewer: answer(VERDICT, { kind: "changes-requested", feedback: ["tighten"] }),
        },
      });
      expect(run.stopped).toEqual({
        stage: "doc-review",
        reason: "The planner updated a different ticket document",
      });
    });

    test("an implementation that writes another stops the implementation", async () => {
      const run = await testWorkflow(featureDelivery, args, {
        agents: {
          ...happyPath,
          implementer: answer(WORK, { docPath: "docs/other.md", summary: "built", decisions: [] }),
        },
      });
      expect(run.stopped).toEqual({
        stage: "implementation",
        reason: "The implementer updated a different ticket document",
      });
    });
  });

  describe("additional reviewers", () => {
    const withExtras = {
      ...args,
      runtimes: {
        ...args.runtimes,
        additionalReviewers: [
          { name: "security", runtime: "claude" },
          { name: "perf", runtime: "claude" },
        ],
      },
    };

    test("their feedback is applied, then the primary reviewer checks it", async () => {
      const run = await testWorkflow(featureDelivery, withExtras, {
        agents: {
          ...happyPath,
          "additional-reviewer:security": answer(VERDICT, {
            kind: "changes-requested",
            feedback: ["escape the key"],
          }),
          "additional-reviewer:perf": ready("fast enough"),
          implementer: [
            answer(WORK, { docPath: doc, summary: "built", decisions: [] }),
            answer(WORK, { docPath: doc, summary: "escaped", decisions: ["escape keys"] }),
          ],
        },
      });
      expect(run.value).toMatchObject({
        summary: "escaped",
        review: {
          additional: [
            { reviewer: "security", kind: "changes-addressed", feedback: ["escape the key"] },
            { reviewer: "perf", kind: "ready", summary: "fast enough" },
          ],
        },
      });
      expect(run.turnsOf("implementer")[1]!.prompt).toContain("- security: escape the key");
      expect(run.turnsOf("reviewer").at(-1)!.prompt).toContain("- security: escape the key");
    });

    test("one that ends without a verdict stops the delivery", async () => {
      const run = await testWorkflow(featureDelivery, withExtras, {
        agents: {
          ...happyPath,
          "additional-reviewer:*": ready("fine"),
          "additional-reviewer:perf": reply.failed("harness crashed"),
        },
      });
      expect(run.stopped).toEqual({ stage: "additional-review", reason: "perf: harness crashed" });
    });

    test("two with one name are refused", async () => {
      const run = await testWorkflow(featureDelivery, {
        ...args,
        runtimes: {
          ...args.runtimes,
          additionalReviewers: [
            { name: "x", runtime: "claude" },
            { name: "x", runtime: "codex" },
          ],
        },
      });
      expect(() => run.value).toThrow("additional reviewer names must be unique");
    });
  });
});
