import { describe, expect, test } from "bun:test";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runWorkflow, type Agent, type RunCall } from "./journal";
import { tempRunDir } from "./deps";
import type { CallResult, Step } from "./deps";

/**
 * What the journal cannot see. Each test here is a workflow that resumes cleanly and is wrong,
 * or resumes correctly and saves nothing. They are the evidence behind E6 in `docs/findings/README.md`.
 */

function step(prompt: string): Step {
  return { prompt, harness: "claude" };
}

const answers =
  (make: (spec: Step) => unknown | Promise<unknown>): RunCall =>
  async (spec) => ({ kind: "answered", value: await make(spec) });

const seen = (result: CallResult) => (result.kind === "answered" ? result.value : result.kind);

describe("what the journal handles", () => {
  test("control flow that branches on a cached value takes the same branch", async () => {
    const runDir = tempRunDir();
    const branching = (agent: Agent) => async () => {
      const size = seen(await agent(step("is the diff big?"))) as { big: boolean };
      return seen(await agent(step(size.big ? "split it" : "review it whole")));
    };

    const sizes = (big: boolean) =>
      answers((spec) => (spec.prompt.startsWith("is") ? { big } : spec.prompt));

    const one = await runWorkflow(runDir, sizes(true), (agent) => branching(agent)());
    // The world moved on, but the branch follows the replayed value, not this run's agent.
    const two = await runWorkflow(runDir, sizes(false), (agent) => branching(agent)());

    expect(two.stats).toEqual({ hits: 2, misses: 0 });
    expect(one.value).toBe("split it");
    expect(two.value).toBe("split it");
  });
});

describe("what the journal replays wrongly", () => {
  test("an input the agent reads for itself is not in the key, so the answer goes stale", async () => {
    const runDir = tempRunDir();
    const source = join(runDir, "code.ts");
    await Bun.write(source, "version A");
    // The prompt a review fan-out sends is constant; the code under review is the input.
    const review = (agent: Agent) => agent(step("review the working tree"));
    const reader = answers(async () => ({ verdict: await Bun.file(source).text() }));

    await runWorkflow(runDir, reader, review);
    await Bun.write(source, "version B");
    const two = await runWorkflow(runDir, reader, review);

    expect(two.stats).toEqual({ hits: 1, misses: 0 });
    expect(seen(two.value)).toEqual({ verdict: "version A" });
  });

  test("the script's own side effects run again on a resume that replayed everything", async () => {
    const runDir = tempRunDir();
    const posted = join(runDir, "posted.log");
    const script = async (agent: Agent) => {
      const note = seen(await agent(step("write the review note")));
      await appendFile(posted, `${JSON.stringify(note)}\n`);
    };

    await runWorkflow(runDir, answers(() => "looks fine"), script);
    const two = await runWorkflow(runDir, answers(() => "looks fine"), script);

    expect(two.stats).toEqual({ hits: 1, misses: 0 });
    expect((await Bun.file(posted).text()).trim().split("\n")).toHaveLength(2);
  });

  test("an agent's side effect is not replayed with its value", async () => {
    const runDir = tempRunDir();
    const patch = join(runDir, "fix.patch");
    const writes = answers(async () => {
      await Bun.write(patch, "diff --git a/x b/x");
      return "applied";
    });

    await runWorkflow(runDir, writes, (agent) => agent(step("fix the bug")));
    // Resuming in a fresh worktree, which is the only reason to resume a write step at all.
    await rm(patch);
    const two = await runWorkflow(runDir, writes, (agent) => agent(step("fix the bug")));

    expect(seen(two.value)).toBe("applied");
    expect(await Bun.file(patch).exists()).toBe(false);
  });
});

describe("what the journal cannot cache at all", () => {
  test("a clock or a random value in the prompt misses every time", async () => {
    const runDir = tempRunDir();
    let tick = 0;
    const script = (agent: Agent) => {
      tick += 1;
      return agent(step(`summarise the log as of ${tick}`));
    };

    await runWorkflow(runDir, answers(() => "summary"), script);
    const two = await runWorkflow(runDir, answers(() => "summary"), script);

    expect(two.stats).toEqual({ hits: 0, misses: 1 });
  });

  test("a fan-out admitted in a different order replays none of it", async () => {
    const runDir = tempRunDir();
    const lenses = ["security", "perf", "naming", "tests"];
    const inOrder = (order: readonly string[]) => (agent: Agent) =>
      Promise.all(order.map((lens) => agent(step(`review for ${lens}`))));

    await runWorkflow(runDir, answers((spec) => spec.prompt), inOrder(lenses));
    // A slot pool admits whichever call a freed slot reaches first, so position is not stable.
    const two = await runWorkflow(
      runDir,
      answers((spec) => spec.prompt),
      inOrder(["perf", "security", "naming", "tests"]),
    );

    expect(two.stats).toEqual({ hits: 0, misses: 4 });
  });
});
