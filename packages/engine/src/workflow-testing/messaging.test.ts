import { describe, expect, test } from "bun:test";
import type { JsonValue, OutputSchema, WorkflowDefinition } from "@agentswf/contract/workflow";
import { answer, reply, testWorkflow } from "./index";

const VERDICT: OutputSchema<{ kind: string; summary?: string; reason?: string }> = {
  type: "object",
  properties: { kind: { type: "string" }, summary: { type: "string" }, reason: { type: "string" } },
  required: ["kind"],
  additionalProperties: false,
};
const FINDINGS: OutputSchema<{ findings: number }> = {
  type: "object",
  properties: { findings: { type: "number" } },
  required: ["findings"],
  additionalProperties: false,
};
const FIX_REPORT: OutputSchema<{ fixed: string[] }> = {
  type: "object",
  properties: { fixed: { type: "array", items: { type: "string" } } },
  required: ["fixed"],
  additionalProperties: false,
};

/**
 * The design's review loop, cut to its shape: the implementer builds, the reviewer reviews the
 * ticket doc, then reviews the implementation, asking the implementer for a revision by message,
 * and the implementer records it.
 */
const reviewLoop: WorkflowDefinition<null, JsonValue> = {
  meta: { name: "review-loop", description: "review until both agree" },
  async run(workflow) {
    const implementer = await workflow.agents.open({ key: "implementer", runtime: "claude" });
    const reviewer = await workflow.agents.open({ key: "reviewer", runtime: "codex" });
    await workflow.messages.allow({
      between: [reviewer, implementer],
      purpose: "Revise the implementation until both agree it is ready.",
    });
    await implementer.run({ prompt: "Build the cache.", label: "Implement" });
    await reviewer.run({ prompt: "Review the ticket doc.", label: "Review ticket doc" });
    const { outcome } = await reviewer.run({
      prompt: "Review the implementation.",
      label: "Review implementation",
      schema: VERDICT,
    });
    await implementer.run({ prompt: "Record what you built.", label: "Record implementation" });
    return outcome.kind === "answered" ? outcome.value : outcome.kind;
  },
};

const reviewer = (ask = true) => [
  answer("doc ok"),
  answer(VERDICT, async (turn) => {
    const revised = await turn.send("implementer", "Handle a cache miss.", { awaitReply: ask });
    return revised.kind === "replied"
      ? { kind: "ready", summary: revised.text }
      : {
          kind: "inconclusive",
          reason: `no revision: ${revised.kind === "refused" ? `refused (${revised.code})` : revised.kind}`,
        };
  }),
];

/** b is working when a asks it, so the question joins b's own turn. */
const asksBack: WorkflowDefinition<null, JsonValue> = {
  meta: { name: "asks-back", description: "a question joins a workflow turn" },
  async run(workflow) {
    const a = await workflow.agents.open({ key: "a", runtime: "codex" });
    const b = await workflow.agents.open({ key: "b", runtime: "claude" });
    await workflow.messages.allow({ between: [a, b], purpose: "Talk." });
    await Promise.all([a.run({ prompt: "Ask b." }), b.run({ prompt: "Work." })]);
    return null;
  },
};

describe("scripted messaging", () => {
  test("the review loop: a question wakes the idle implementer, and its reply resumes the same call", async () => {
    const run = await testWorkflow(reviewLoop, null, {
      awaitReply: "anywhere",
      agents: { implementer: [answer("built"), answer("recorded")], reviewer: reviewer() },
      messages: {
        implementer: (message) => message.reply("A miss now falls through to the store."),
      },
    });

    expect(run.value).toEqual({ kind: "ready", summary: "A miss now falls through to the store." });
    expect(run.messagesOf("implementer")).toEqual([
      { from: "reviewer", awaitReply: true, end: "replied" },
    ]);
    expect(run.messagesOf("reviewer")).toEqual([
      { from: "implementer", awaitReply: false, end: "delivered" },
    ]);
    expect(run.turnsOf("implementer").map((turn) => turn.cause)).toEqual([
      undefined,
      { message: { from: "reviewer" } },
      undefined,
    ]);
    // The reply continues the implementation review: a turn of its own, sharing that turn's number.
    expect(run.turnsOf("reviewer").map(({ label, n, outcome }) => ({ label, n, outcome }))).toEqual(
      [
        { label: "Review ticket doc", n: 1, outcome: "answered" },
        { label: "Review implementation", n: 2, outcome: "awaiting-reply" },
        { label: "Review implementation", n: 2, outcome: "answered" },
      ],
    );
    expect(run.turnsOf("reviewer")[2]?.messages).toEqual([
      { from: "implementer", text: "A miss now falls through to the store.", answers: true },
    ]);
    expect(run.turnsOf("implementer")[1]?.messages).toEqual([
      { from: "reviewer", text: "Handle a cache miss.", asks: true },
    ]);
  });

  test("lenses report to a fixer that waits for all of them", async () => {
    const LENSES = ["lens-perf", "lens-safety"];
    const lenses: WorkflowDefinition<null, JsonValue> = {
      meta: { name: "lenses", description: "lenses and a fixer" },
      async run(workflow) {
        const fixer = await workflow.agents.open({ key: "fixer", runtime: "claude" });
        const opened = await Promise.all(
          LENSES.map((key) => workflow.agents.open({ key, runtime: "codex" })),
        );
        for (const lens of opened) {
          await workflow.messages.allow({ from: lens, to: fixer, purpose: "Report findings." });
        }
        const [fixed] = await Promise.all([
          fixer.run({ prompt: "Fix what the lenses report.", schema: FIX_REPORT }),
          ...opened.map((lens) => lens.run({ prompt: "Review.", schema: FINDINGS })),
        ]);
        return fixed.outcome.kind === "answered" ? fixed.outcome.value : fixed.outcome.kind;
      },
    };
    const findings: string[] = [];
    const done = new Set<string>();
    const run = await testWorkflow(lenses, null, {
      agents: {
        fixer: answer(FIX_REPORT, (turn) => {
          for (const m of turn.messages)
            m.text === "done" ? done.add(m.from) : findings.push(m.text);
          return done.size === LENSES.length
            ? { fixed: [...findings].sort() }
            : reply.waiting("waiting for findings");
        }),
        "lens-*": answer(FINDINGS, async (turn) => {
          await turn.send("fixer", `Finding from ${turn.agent}`);
          await turn.send("fixer", "done");
          return { findings: 1 };
        }),
      },
    });
    expect(run.value).toEqual({ fixed: ["Finding from lens-perf", "Finding from lens-safety"] });
    expect(run.messagesOf("fixer")).toHaveLength(4);
    expect(run.messagesOf("fixer").every(({ end }) => end === "delivered")).toBe(true);
    expect(run.turnsOf("fixer").every((turn) => turn.n === 1)).toBe(true);
  });

  test("a question to an agent that has not run starts it", async () => {
    const planning: WorkflowDefinition<null, JsonValue> = {
      meta: { name: "planning", description: "a planner asks an architect" },
      async run(workflow) {
        const planner = await workflow.agents.open({ key: "planner", runtime: "codex" });
        const architect = await workflow.agents.open({ key: "architect", runtime: "codex" });
        await workflow.messages.allow({
          from: planner,
          to: architect,
          purpose: "Ask about design.",
        });
        const { outcome } = await planner.run({ prompt: "Plan the retries." });
        return outcome.kind === "answered" ? outcome.value : outcome.kind;
      },
    };
    const run = await testWorkflow(planning, null, {
      awaitReply: "anywhere",
      agents: {
        planner: answer(async (turn) => {
          const asked = await turn.send("architect", "Where do retries live?", {
            awaitReply: true,
          });
          return asked.kind === "replied" ? `plan: ${asked.text}` : asked.kind;
        }),
      },
      messages: { architect: (message) => message.reply("Retries live in the queue.") },
    });
    expect(run.value).toBe("plan: Retries live in the queue.");
    expect(run.turnsOf("architect").map(({ n, cause }) => ({ n, cause }))).toEqual([
      { n: 1, cause: { message: { from: "planner" } } },
    ]);
  });

  test("a refusal is a value: an asker that cannot await here is told so", async () => {
    const run = await testWorkflow(reviewLoop, null, {
      agents: { implementer: [answer("built"), answer("recorded")], reviewer: reviewer() },
    });
    expect(run.value).toEqual({
      kind: "inconclusive",
      reason: "no revision: refused (unsupported)",
    });
    expect(run.messagesOf("implementer")).toEqual([]);
  });

  test("a send without a reply asked for resolves sent; returning without awaiting a wait drops it", async () => {
    let dropped: unknown;
    const run = await testWorkflow(reviewLoop, null, {
      awaitReply: "anywhere",
      agents: {
        implementer: [answer("built"), answer("recorded")],
        reviewer: [
          answer("doc ok"),
          answer(VERDICT, async (turn) => {
            const noted = await turn.send("implementer", "A note.");
            const asked = turn.send("implementer", "Why?", { awaitReply: true });
            void asked.then((outcome) => {
              dropped = outcome;
            });
            return { kind: noted.kind };
          }),
        ],
      },
      messages: { implementer: (message) => message.silent() },
    });
    expect(run.value).toEqual({ kind: "sent" });
    expect(dropped).toEqual({ kind: "failed", reason: "dropped" });
  });

  test("a peer that stays silent is reminded once, and the asker's wait fails", async () => {
    const run = await testWorkflow(reviewLoop, null, {
      awaitReply: "anywhere",
      agents: { implementer: [answer("built"), answer("recorded")], reviewer: reviewer() },
      messages: { implementer: (message) => message.silent() },
    });
    expect(run.value).toEqual({ kind: "inconclusive", reason: "no revision: failed" });
    expect(run.messagesOf("implementer")).toMatchObject([
      { from: "reviewer", awaitReply: true, end: "failed" },
    ]);
    expect(run.turnsOf("implementer").map(({ n, nudge, cause }) => ({ n, nudge, cause }))).toEqual([
      { n: 1, nudge: false, cause: undefined },
      { n: 2, nudge: false, cause: { message: { from: "reviewer" } } },
      { n: 2, nudge: true, cause: { message: { from: "reviewer" } } },
      { n: 3, nudge: false, cause: undefined },
    ]);
  });

  test("a script that answers while it owes a reply fails the test", async () => {
    // b's own run is open before a asks, so the question joins it rather than waking b.
    const working = Promise.withResolvers<void>();
    await expect(
      testWorkflow(asksBack, null, {
        awaitReply: "anywhere",
        agents: {
          a: answer(async (turn) => {
            await working.promise;
            const asked = await turn.send("b", "Ready?", { awaitReply: true });
            return asked.kind;
          }),
          b: answer((turn) => {
            working.resolve();
            return turn.messages.length > 0 ? "done" : reply.waiting("for a's question");
          }),
        },
      }),
    ).rejects.toThrow("its script answered while it owes a reply");
  });

  test("a question that joins a workflow turn is answered with turn.reply, then the result is taken", async () => {
    const working = Promise.withResolvers<void>();
    const run = await testWorkflow(asksBack, null, {
      awaitReply: "anywhere",
      agents: {
        a: answer(async (turn) => {
          await working.promise;
          const asked = await turn.send("b", "Ready?", { awaitReply: true });
          return asked.kind === "replied" ? asked.text : asked.kind;
        }),
        b: answer(async (turn) => {
          working.resolve();
          const question = turn.messages.find((message) => message.asks);
          if (!question) return reply.waiting("for a's question");
          const replied = await turn.reply(question.from, "Yes.");
          return replied.kind;
        }),
      },
    });
    expect(run.messagesOf("b")).toEqual([{ from: "a", awaitReply: true, end: "replied" }]);
    expect(run.turnsOf("b").map(({ n, outcome }) => [n, outcome])).toEqual([
      [1, "waiting"],
      [1, "answered"],
    ]);
  });

  test("a turn that ends silent is run again with the messages held for it", async () => {
    const sent = Promise.withResolvers<void>();
    const notes: WorkflowDefinition<null, JsonValue> = {
      meta: { name: "notes", description: "a note held for a busy agent" },
      async run(workflow) {
        const writer = await workflow.agents.open({ key: "writer", runtime: "codex" });
        const lens = await workflow.agents.open({ key: "lens", runtime: "codex" });
        await workflow.messages.allow({ from: lens, to: writer, purpose: "Notes." });
        const [written] = await Promise.all([
          writer.run({ prompt: "Write." }),
          lens.run({ prompt: "Note." }),
        ]);
        return written.outcome.kind === "answered" ? written.outcome.value : written.outcome.kind;
      },
    };
    const run = await testWorkflow(notes, null, {
      agents: {
        writer: answer(async (turn) => {
          if (turn.messages.length > 0) return turn.messages.map((m) => m.text).join(" ");
          await sent.promise;
          return reply.silent();
        }),
        lens: answer(async (turn) => {
          await turn.send("writer", "Mind the cache.");
          sent.resolve();
          return "noted";
        }),
      },
    });
    expect(run.value).toBe("Mind the cache.");
    expect(run.turnsOf("writer").map(({ n, nudge, outcome }) => [n, nudge, outcome])).toEqual([
      [1, false, "silent"],
      [1, false, "answered"],
    ]);
  });

  test("a message script may send on, and a note it sends comes with its reply", async () => {
    const planning: WorkflowDefinition<null, JsonValue> = {
      meta: { name: "planning", description: "an architect notes before it replies" },
      async run(workflow) {
        const planner = await workflow.agents.open({ key: "planner", runtime: "codex" });
        const architect = await workflow.agents.open({ key: "architect", runtime: "codex" });
        await workflow.messages.allow({ between: [planner, architect], purpose: "Design." });
        const { outcome } = await planner.run({ prompt: "Plan." });
        return outcome.kind === "answered" ? outcome.value : outcome.kind;
      },
    };
    const run = await testWorkflow(planning, null, {
      awaitReply: "anywhere",
      agents: {
        planner: answer(async (turn) => {
          const asked = await turn.send("architect", "Where?", { awaitReply: true });
          return [...turn.messages.map((m) => m.text), asked.kind].join(" | ");
        }),
      },
      messages: {
        architect: async (message) => {
          await message.send("planner", "See ADR 7.");
          return message.reply("In the queue.");
        },
      },
    });
    expect(run.value).toBe("See ADR 7. | In the queue. | replied");
  });

  test("a message script that fails fails the run, as any operation the run owns does", async () => {
    const run = await testWorkflow(reviewLoop, null, {
      awaitReply: "anywhere",
      agents: { implementer: answer("built"), reviewer: reviewer() },
      messages: { implementer: (message) => message.fail("harness crashed") },
    });
    expect(() => run.value).toThrow(
      "agent implementer's message operation failed: harness crashed",
    );
    expect(run.messagesOf("implementer")).toMatchObject([
      { from: "reviewer", awaitReply: true, end: "failed" },
    ]);
  });

  test("a script awaiting a reply when its call times out is let go, its wait cancelled", async () => {
    let awaited: unknown;
    const timing: WorkflowDefinition<null, JsonValue> = {
      meta: { name: "timing", description: "an asker's call times out" },
      async run(workflow) {
        const asker = await workflow.agents.open({ key: "asker", runtime: "codex" });
        const slow = await workflow.agents.open({ key: "slow", runtime: "codex" });
        await workflow.messages.allow({ between: [asker, slow], purpose: "Ask." });
        // A timeout stops the asker: its session closes.
        const { outcome } = await asker.run({ prompt: "Ask.", timeoutMs: 200 });
        return outcome.kind;
      },
    };
    const run = await testWorkflow(timing, null, {
      awaitReply: "anywhere",
      agents: {
        asker: answer(async (turn) => {
          awaited = await turn.send("slow", "Why?", { awaitReply: true });
          return "late";
        }),
      },
      messages: {
        slow: async (message) => {
          await Bun.sleep(300);
          return message.reply("Because.");
        },
      },
    });
    expect(run.value).toBe("timed-out");
    expect(awaited).toEqual({ kind: "failed", reason: "cancelled" });
  });

  test("an agent a message wakes with no message script fails the test", async () => {
    await expect(
      testWorkflow(reviewLoop, null, {
        awaitReply: "anywhere",
        agents: { implementer: [answer("built"), answer("recorded")], reviewer: reviewer() },
      }),
    ).rejects.toThrow(
      'agent "implementer" turn 2, woken by reviewer: no agent has a message script',
    );
  });

  test("a list of message scripts is one per message operation, and one left over fails the test", async () => {
    await expect(
      testWorkflow(reviewLoop, null, {
        awaitReply: "anywhere",
        agents: { implementer: [answer("built"), answer("recorded")], reviewer: reviewer() },
        messages: {
          implementer: [(message) => message.reply("Done."), (message) => message.silent()],
        },
      }),
    ).rejects.toThrow(
      'agent "implementer" was asked 1 message operation; its message script has 2',
    );
  });
});
