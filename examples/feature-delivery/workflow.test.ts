import { describe, expect, test } from "bun:test";
import { answer, reply, type Script, testWorkflow } from "@agentswf/engine/workflow-testing";
import { VERDICT, WORK } from "./schema";
import feature, { featureDelivery } from "./workflow";

const args = {
  ticket: "ABC-1",
  runtimes: {
    planner: "claude",
    implementer: "codex",
    reviewer: { alias: "codex", placement: "headless" as const },
  },
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

/** A review that asks its author for `change` by message and approves what the author replies. */
const asking = (change: string, summary: string) =>
  answer(VERDICT, async (turn) => {
    const author = turn.label === "Review ticket doc" ? "planner" : "implementer";
    const revised = await turn.send(author, change, { awaitReply: true });
    return revised.kind === "replied"
      ? { kind: "ready", summary: `${summary}: ${revised.text}` }
      : { kind: "inconclusive", reason: `no revision: ${revised.kind}` };
  });

describe("feature-delivery", () => {
  test("the reviewer asks the planner for a change by message, then the code ships", async () => {
    const run = await testWorkflow(featureDelivery, args, {
      agents: {
        ...happyPath,
        planner: [
          answer(WORK, planned),
          answer(WORK, { docPath: doc, summary: "plan v2", decisions: ["name the cache"] }),
        ],
        reviewer: [asking("name the cache", "doc ok"), ready("code ok")],
      },
      messages: { planner: (message) => message.reply("Named it in the doc.") },
    });
    expect(run.value).toEqual({
      docPath: doc,
      summary: "built",
      decisions: ["LRU"],
      review: { primary: "code ok", additional: [] },
    });
    expect(run.stages[1]).toMatchObject({
      stage: "doc-review",
      summary: "doc ok: Named it in the doc.",
    });
    expect(run.messagesOf("planner")).toEqual([
      { from: "reviewer", awaitReply: true, end: "replied" },
    ]);
    // Built, revised by message, then reported as it stands after review.
    expect(run.turnsOf("planner").map(({ label, cause }) => [label, cause])).toEqual([
      ["Create ticket doc", undefined],
      [undefined, { message: { from: "reviewer" } }],
      ["Record ticket doc", undefined],
    ]);
    expect(run.turnsOf("planner")[1]!.messages).toEqual([
      { from: "reviewer", text: "name the cache", asks: true },
    ]);
    // The revision continues the doc review: a turn of its own, sharing its number.
    expect(run.turnsOf("reviewer").map(({ label, n }) => [label, n])).toEqual([
      ["Review ticket doc", 1],
      ["Review ticket doc", 1],
      ["Review implementation", 2],
    ]);
  });

  test("the reviewer owns the loop: told how to ask, on a route for this review only", async () => {
    const run = await testWorkflow(featureDelivery, args, {
      agents: { ...happyPath, reviewer: [ready("doc ok"), asking("handle a miss", "code ok")] },
      messages: { implementer: (message) => message.reply("A miss falls through.") },
    });
    expect(run.value).toMatchObject({ review: { primary: "code ok: A miss falls through." } });
    expect(run.turnsOf("reviewer")[1]!.prompt).toBe(
      [
        `Review the implementation of ABC-1 described by ${doc}.`,
        "Its author says: built",
        "Decisions it recorded:",
        "- LRU",
        "Inspect the actual changes and return ready only when they are correct and complete.",
        "You own the revision loop. When changes are needed, send them with",
        "`wf send --await-reply implementer` and end your turn; review the revision",
        "it reports. Return your verdict when it is ready, or the changes still needed once",
        "the route's limit is reached.",
      ].join("\n"),
    );
    expect(run.turnsOf("implementer").map(({ label, cause }) => label ?? cause)).toEqual([
      "Implement feature",
      { message: { from: "reviewer" } },
      "Record implementation",
    ]);
  });

  test("a full run records each stage with its summary", async () => {
    const run = await testWorkflow(featureDelivery, args, { agents: happyPath });
    expect(run.stages.map(({ stage, outcome, summary }) => [stage, outcome, summary])).toEqual([
      ["ticket-doc", "succeeded", doc],
      ["doc-review", "succeeded", "ok"],
      ["implementation", "succeeded", "built"],
      ["implementation-review", "succeeded", "ok"],
      ["additional-review", "succeeded", "no additional reviewers"],
    ]);
  });

  test("a finished run closes with what was built, its doc, and the extra reviews", async () => {
    const run = await testWorkflow(featureDelivery, args, { agents: happyPath });
    expect(feature.present?.(run.value, undefined as never)).toBe(
      `built\n${doc}\nno additional reviewers`,
    );
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
      { ...args, additionalReviewers: [{ name: "security", runtime: "claude" }] },
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

  test("the author answers the reviewer, and cannot reopen the review once it is approved", async () => {
    let reopened: unknown;
    const run = await testWorkflow(featureDelivery, args, {
      agents: {
        ...happyPath,
        planner: answer(WORK, async (turn) => {
          if (turn.label === "Record ticket doc") reopened = await turn.send("reviewer", "Also?");
          return planned;
        }),
      },
    });
    expect(run.value).toMatchObject({ docPath: doc });
    expect(reopened).toEqual({ kind: "refused", code: "no-route" });
  });

  test("a review that still wants changes stops the run", async () => {
    const run = await testWorkflow(featureDelivery, args, {
      agents: {
        ...happyPath,
        reviewer: answer(VERDICT, { kind: "changes-requested", feedback: ["more detail"] }),
      },
    });
    expect(run.stopped).toEqual({
      stage: "doc-review",
      reason: "ticket doc: not approved; 1 changes open",
    });
    expect(run.turnsOf("planner")).toHaveLength(1);
  });

  test("with no revisions allowed, the reviewer is not told to ask and has no route", async () => {
    let asked: unknown;
    const run = await testWorkflow(
      featureDelivery,
      { ...args, maxRevisions: 0 },
      {
        agents: {
          ...happyPath,
          reviewer: answer(VERDICT, async (turn) => {
            asked = await turn.send("planner", "more detail");
            return { kind: "changes-requested", feedback: ["more detail"] };
          }),
        },
      },
    );
    expect(run.turnsOf("reviewer")[0]!.prompt).not.toContain("revision loop");
    expect(asked).toEqual({ kind: "refused", code: "no-route" });
    expect(run.stopped).toMatchObject({ reason: "ticket doc: not approved; 1 changes open" });
  });

  test("a planner that goes quiet is nudged once, then the delivery stops", async () => {
    const run = await testWorkflow(featureDelivery, args, { agents: { planner: reply.silent() } });
    expect(run.stopped).toMatchObject({
      stage: "ticket-doc",
      reason: expect.stringMatching(/^planner: /),
    });
    expect(run.turnsOf("planner").map((turn) => turn.nudge)).toEqual([false, true]);
  });

  test("an inconclusive review stops with the reviewer's reason", async () => {
    const run = await testWorkflow(featureDelivery, args, {
      agents: {
        ...happyPath,
        reviewer: answer(VERDICT, { kind: "inconclusive", reason: "cannot open the doc" }),
      },
    });
    expect(run.stopped).toEqual({ stage: "doc-review", reason: "reviewer: cannot open the doc" });
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
    test("a doc reported moved after review stops the doc review", async () => {
      const run = await testWorkflow(featureDelivery, args, {
        agents: {
          planner: [
            answer(WORK, planned),
            answer(WORK, { docPath: "docs/other.md", summary: "moved", decisions: [] }),
          ],
          reviewer: ready("doc ok"),
        },
      });
      expect(run.stopped).toEqual({
        stage: "doc-review",
        reason: "planner: updated a different ticket document",
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
        reason: "implementer: updated a different ticket document",
      });
    });
  });

  describe("additional reviewers", () => {
    const withExtras = {
      ...args,
      additionalReviewers: [
        { name: "security", runtime: "claude" },
        { name: "perf", runtime: "claude" },
      ],
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
          // Built and recorded; then the feedback applied and recorded.
          implementer: answer(WORK, (turn) =>
            turn.n <= 2
              ? { docPath: doc, summary: "built", decisions: [] }
              : { docPath: doc, summary: "escaped", decisions: ["escape keys"] },
          ),
        },
      });
      expect(run.value).toMatchObject({
        summary: "escaped",
        review: {
          additional: [
            { reviewer: "security", kind: "changes-requested", feedback: ["escape the key"] },
            { reviewer: "perf", kind: "ready", summary: "fast enough" },
          ],
        },
      });
      expect(run.turnsOf("implementer")[2]!.prompt).toContain("- security: escape the key");
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

    test("one that can't decide stops the others, and the delivery", async () => {
      // perf hangs until it is cancelled: were it not, the test would fail as stalled.
      const run = await testWorkflow(featureDelivery, withExtras, {
        agents: {
          ...happyPath,
          "additional-reviewer:security": answer(VERDICT, {
            kind: "inconclusive",
            reason: "no diff to read",
          }),
          "additional-reviewer:perf": reply.hang(),
        },
      });
      expect(run.stopped).toEqual({
        stage: "additional-review",
        reason: "security: no diff to read",
      });
    });
  });

  describe("from the command line", () => {
    const prepare = (...argv: string[]) => feature.prepare({ argv, cwd: "/repo" });

    test("a ticket names the run; a claude planner, codex for the rest, its reviewer headless", () => {
      const args = prepare("ABC-1");
      expect(args).toEqual({
        ticket: "ABC-1",
        runtimes: {
          planner: "claude",
          implementer: "codex",
          reviewer: { alias: "codex", placement: "headless" },
        },
      });
      expect(feature.id?.(args)).toBe("ABC-1");
    });

    test("flags set the revisions and add reviewers", () => {
      expect(
        prepare(
          "--revisions",
          "1",
          "ABC-1",
          "--reviewer",
          "security=claude",
          "--reviewer",
          "perf=pi",
        ),
      ).toMatchObject({
        ticket: "ABC-1",
        maxRevisions: 1,
        additionalReviewers: [
          { name: "security", runtime: "claude" },
          { name: "perf", runtime: "pi" },
        ],
      });
    });

    test.each([
      [[]],
      [["ABC-1", "ABC-2"]],
      [["ABC-1", "--revisions", "-1"]],
      [["ABC-1", "--revisions", ""]],
      [["ABC-1", "--reviewer", "security"]],
      [["ABC-1", "--reviewer", "x=claude", "--reviewer", "x=codex"]],
      [["ABC-1", "--verbose"]],
    ])("%p is refused with the usage", (argv) => {
      expect(() => prepare(...argv)).toThrow("-- {ticket}");
    });
  });
});
