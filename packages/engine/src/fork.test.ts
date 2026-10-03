import { afterAll, describe, expect, test } from "bun:test";
import type {
  AgentRef,
  JsonValue,
  OutputSchema,
  WorkflowContext,
  WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentRuntimeConfig, HarnessOperationBinding } from "@agentswf/harness/adapter";
import {
  createFakeAdapter,
  type FakeAdapterTurnContext,
  type FakeFork,
} from "@agentswf/harness/testing";
import { createTempRunDirs, future, submit } from "./testing";
import { runWorkflow } from "./workflow-runner";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const ANSWER: OutputSchema<{ answer: string }> = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

/** A fake whose agents fork, answering every turn through its own binding unless told otherwise. */
function forkingAdapter(
  options: {
    act?: (context: FakeAdapterTurnContext) => Promise<void>;
    forks?: (key: string) => boolean;
  } = {},
) {
  const forks: FakeFork[] = [];
  const adapter = createFakeAdapter({
    continues: true,
    forks: (activation) => options.forks?.(activation.key) ?? true,
    onFork: (fork) => forks.push(fork),
    script: (context) => ({
      act: async () => {
        if (options.act) return options.act(context);
        await submit(context.binding!, { answer: context.activation.key });
      },
    }),
  });
  return Object.assign(adapter, { forks });
}

function runtime(adapter: ReturnType<typeof forkingAdapter>): AgentRuntimeConfig {
  return {
    aliases: { review: { harness: "fake", model: "fake" } },
    host: createSingleSessionHostFactory(adapter),
  };
}

function run<Result extends JsonValue>(
  adapter: ReturnType<typeof forkingAdapter>,
  body: (context: WorkflowContext) => Promise<Result>,
) {
  const workflow: WorkflowDefinition<null, Result> = {
    meta: { name: "fork", description: "fork" },
    run: body,
  };
  return runWorkflow(workflow, null, {
    runRoot: runDirs.tempRunDir(),
    deadline: future(),
    runtime: runtime(adapter),
  });
}

const open = (context: WorkflowContext, key = "worker") =>
  context.agents.open({ key, runtime: "review", instructions: "You are the worker." });

const ask = async (agent: AgentRef, prompt: string) => {
  const { outcome } = await agent.run({ prompt, schema: ANSWER });
  return outcome.kind === "answered" ? outcome.value.answer : outcome.kind;
};

describe("fork", () => {
  test("copies the session after the operations before it, never one after", async () => {
    const adapter = forkingAdapter();
    const result = await run(adapter, async (context) => {
      const worker = await open(context);
      const first = worker.run({ prompt: "Plan.", schema: ANSWER });
      const tests = worker.fork({ key: "tests", instructions: "You write the tests." });
      const second = worker.run({ prompt: "Go on.", schema: ANSWER });
      const forked = await tests;
      await Promise.all([first, second]);
      return [forked.key, await ask(forked, "Which tests?")];
    });

    expect(result.value).toEqual(["tests", "tests"]);
    expect(adapter.forks.map(({ activation, turns }) => [activation.key, turns])).toEqual([
      ["worker", 1],
    ]);
    const child = adapter.activations.find((activation) => activation.key === "tests")!;
    expect(child.continues).toEqual({ harness: "fake", sessionRef: adapter.forks[0]!.sessionRef });
    expect(child.instructions).toBe("You write the tests.");
    expect(child.execution).toEqual(
      adapter.activations.find((activation) => activation.key === "worker")!.execution,
    );
    const childTurn = adapter.turns.find((turn) => turn.activation.key === "tests")!;
    expect(childTurn.previousSessionRef).toBe(adapter.forks[0]!.sessionRef);
  });

  test("a fork's answer comes through its own channel; one with a call its copy holds from its parent is refused, and its session stays the fork's", async () => {
    let parentBinding: HarnessOperationBinding | undefined;
    const refused: string[] = [];
    const adapter = forkingAdapter({
      act: async (context) => {
        if (context.activation.key === "worker") {
          parentBinding = context.binding;
          await submit(context.binding!, { answer: "worker" });
          return;
        }
        // The copied context names the parent's launcher; a fork that reuses it reaches the parent.
        const response = await submit(
          parentBinding!,
          { answer: "wrong door" },
          context.previousSessionRef,
        );
        if (response.kind !== "accepted") refused.push(response.kind);
        await submit(context.binding!, { answer: "tests" });
      },
    });
    const result = await run(adapter, async (context) => {
      const worker = await open(context);
      await ask(worker, "Plan.");
      const tests = await worker.fork({ key: "tests" });
      return [await ask(tests, "Which tests?"), await ask(worker, "And now?")];
    });

    expect(result.value).toEqual(["tests", "worker"]);
    expect(refused).toHaveLength(1);
    const forkSession = adapter.forks[0]!.sessionRef;
    const sessionsOf = (agent: string) =>
      result.usage
        .filter((usage) => usage.agent === agent)
        .flatMap((usage) => usage.sessions.map((session) => session.id));
    expect(sessionsOf("worker")).not.toContain(forkSession);
    expect(sessionsOf("tests")).toContain(forkSession);
  });

  test("the same key and spec is the same fork; anything else under it conflicts", async () => {
    const adapter = forkingAdapter();
    const result = await run(adapter, async (context) => {
      const worker = await open(context);
      const other = await open(context, "other");
      await Promise.all([ask(worker, "Plan."), ask(other, "Plan.")]);
      const [a, b] = await Promise.all([
        worker.fork({ key: "tests" }),
        worker.fork({ key: "tests" }),
      ]);
      const outcomes = await Promise.allSettled([
        worker.fork({ key: "tests", instructions: "Something else." }),
        other.fork({ key: "tests" }),
        worker.fork({ key: "other" }),
        context.agents.open({ key: "tests", runtime: "review" }),
      ]);
      return [
        a === b,
        ...outcomes.map((outcome) =>
          outcome.status === "rejected" ? (outcome.reason as Error).message : "opened",
        ),
      ];
    });

    expect(result.value).toEqual([
      true,
      "agent tests is already open, not as this fork of worker",
      "agent tests is already open, not as this fork of other",
      "agent other is already open, not as this fork of worker",
      // The fork is reattached by its key, as any agent is.
      "opened",
    ]);
    expect(adapter.forks).toHaveLength(1);
  });

  test("a fork racing an open of its key builds one agent", async () => {
    const adapter = forkingAdapter();
    const result = await run(adapter, async (context) => {
      const worker = await open(context);
      await ask(worker, "Plan.");
      const outcomes = await Promise.allSettled([
        context.agents.open({ key: "tests", runtime: "review" }),
        worker.fork({ key: "tests" }),
      ]);
      return outcomes.map((outcome) =>
        outcome.status === "rejected" ? (outcome.reason as Error).message : "opened",
      );
    });

    expect(result.value).toEqual([
      "opened",
      "agent tests is already open, not as this fork of worker",
    ]);
    expect(adapter.activations.filter((activation) => activation.key === "tests")).toHaveLength(1);
    expect(adapter.forks).toHaveLength(0);
  });

  test("a fork forks once it has run; before its own first turn it is refused", async () => {
    const adapter = forkingAdapter();
    const result = await run(adapter, async (context) => {
      const worker = await open(context);
      await ask(worker, "Plan.");
      const tests = await worker.fork({ key: "tests" });
      const early = await tests.fork({ key: "early" }).then(
        () => "forked",
        (error: Error) => error.message,
      );
      await ask(tests, "Which tests?");
      const grandchild = await tests.fork({ key: "edge-cases" });
      return [early, await ask(grandchild, "Which edge cases?")];
    });

    expect(result.value).toEqual(["an agent cannot be forked before its first turn", "edge-cases"]);
    expect(adapter.forks.map(({ activation }) => activation.key)).toEqual(["worker", "tests"]);
    const grandchild = adapter.activations.find((activation) => activation.key === "edge-cases")!;
    expect(grandchild.continues?.sessionRef).toBe(adapter.forks[1]!.sessionRef);
  });

  test("refused before the parent's first turn, where its host cannot fork, and once it is closed", async () => {
    const adapter = forkingAdapter({
      forks: (key) => key !== "plain",
      act: async (context) => {
        if (context.activation.key === "doomed") {
          // A turn that times out closes the agent.
          await new Promise((resolve) =>
            context.signal.addEventListener("abort", resolve, { once: true }),
          );
          return;
        }
        await submit(context.binding!, { answer: "ok" });
      },
    });
    const result = await run(adapter, async (context) => {
      const message = (forking: Promise<unknown>) =>
        forking.then(
          () => "forked",
          (error: Error) => error.message,
        );
      const worker = await open(context);
      const beforeTurn = await message(worker.fork({ key: "a" }));
      await ask(worker, "Plan.");
      // A fork that was not made left its key free.
      const afterTurn = await message(worker.fork({ key: "a" }));
      const plain = await open(context, "plain");
      await ask(plain, "Plan.");
      const noFork = await message(plain.fork({ key: "b" }));
      const doomed = await open(context, "doomed");
      await doomed.run({ prompt: "Fail.", nudge: false, timeoutMs: 50 });
      const closed = await message(doomed.fork({ key: "c" }));
      return [beforeTurn, afterTurn, noFork, closed];
    });

    expect(result.value).toEqual([
      "an agent cannot be forked before its first turn",
      "forked",
      "agent plain cannot be forked: fake pane agents have no fork yet",
      "logical agent is closed",
    ]);
  });
});
