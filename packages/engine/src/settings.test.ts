import { afterAll, describe, expect, test } from "bun:test";
import type {
  AgentRef,
  JsonValue,
  OutputSchema,
  RuntimeSelection,
  SettingsSpec,
  WorkflowContext,
  WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentRuntimeConfig } from "@agentswf/harness/adapter";
import { createFakeAdapter, type FakeSet } from "@agentswf/harness/testing";
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

/** A fake that answers every turn, forks, and switches settings unless `refuse` names why not. */
function settingAdapter(
  options: {
    sets?: boolean;
    refuse?: (set: FakeSet) => string | undefined | Promise<string | undefined>;
  } = {},
) {
  const sets: FakeSet[] = [];
  const adapter = createFakeAdapter({
    harnesses: ["fake", "claude"],
    continues: true,
    forks: () => true,
    sets: () => options.sets ?? true,
    onSet: (set) => {
      sets.push(set);
      return options.refuse?.(set);
    },
    script: (context) => ({
      act: async () => {
        await submit(context.binding!, { answer: context.activation.key });
      },
    }),
  });
  return Object.assign(adapter, { sets });
}

function run<Result extends JsonValue>(
  adapter: ReturnType<typeof settingAdapter>,
  body: (context: WorkflowContext) => Promise<Result>,
) {
  const runtime: AgentRuntimeConfig = {
    aliases: {
      review: { harness: "fake", model: "fake" },
      deep: { harness: "claude", model: "opus", effort: "high" },
    },
    host: createSingleSessionHostFactory(adapter),
  };
  const workflow: WorkflowDefinition<null, Result> = {
    meta: { name: "settings", description: "settings" },
    run: body,
  };
  return runWorkflow(workflow, null, {
    runRoot: runDirs.tempRunDir(),
    deadline: future(),
    runtime,
  });
}

const ask = (agent: AgentRef, prompt = "Go.") => agent.run({ prompt, schema: ANSWER });

const settled = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    (value) =>
      typeof value === "object" && value !== null && "kind" in value
        ? String(value.kind)
        : "opened",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("effort at open", () => {
  test("an alias's effort is a default the workflow's replaces; reopening compares as opened", async () => {
    const adapter = settingAdapter();
    const result = await run(adapter, async (context) => {
      const open = (key: string, runtime: RuntimeSelection) =>
        settled(context.agents.open({ key, runtime }));
      return [
        await open("a", "deep"),
        await open("b", { alias: "deep", effort: "low" }),
        await open("c", { harness: "claude", model: "sonnet", effort: "max" }),
        await open("d", { harness: "claude", model: "sonnet" }),
        await open("e", { alias: "deep", effort: "medium-ish" }),
        await open("f", { harness: "fake", model: "fake", effort: "anything" }),
        await open("b", { alias: "deep", effort: "low" }),
        await open("b", "deep"),
        await open("b", { alias: "deep", effort: "high" }),
      ];
    });

    expect(result.value).toEqual([
      "opened",
      "opened",
      "opened",
      "opened",
      'claude has no effort "medium-ish"; its levels are low, medium, high, xhigh, max',
      // A harness the table does not know is its host's to refuse, effort and all.
      "opened",
      "opened",
      "opened",
      "existing agent was opened at a different effort",
    ]);
    expect(adapter.activations.map(({ execution }) => execution)).toEqual([
      { harness: "claude", model: "opus", effort: "high", alias: "deep" },
      { harness: "claude", model: "opus", effort: "low", alias: "deep" },
      { harness: "claude", model: "sonnet", effort: "max" },
      { harness: "claude", model: "sonnet" },
      { harness: "fake", model: "fake", effort: "anything" },
    ]);
  });
});

describe("set", () => {
  test("switches the settings every later operation runs at, in queue order, and records each", async () => {
    const adapter = settingAdapter();
    const result = await run(adapter, async (context) => {
      const agent = await context.agents.open({ key: "reviewer", runtime: "review" });
      const first = ask(agent);
      const low = agent.set({ effort: "low" });
      const second = ask(agent);
      const other = agent.set({ model: "other" });
      const third = ask(agent);
      await Promise.all([first, second, third]);
      const reopened = await context.agents.open({ key: "reviewer", runtime: "review" });
      const answered = await low;
      return {
        low: answered.kind === "answered" ? answered.value : answered.kind,
        lowRecord: answered.usage.execution,
        other: (await other).usage.execution,
        now: agent.execution,
        same: reopened === agent,
      };
    });

    expect(result.value).toEqual({
      low: null,
      lowRecord: { harness: "fake", model: "fake", alias: "review", effort: "low" },
      other: { harness: "fake", model: "other", alias: "review", effort: "low" },
      now: { harness: "fake", model: "other", alias: "review", effort: "low" },
      same: true,
    });
    expect(adapter.turns.map(({ settings }) => settings)).toEqual([
      { model: "fake" },
      { model: "fake", effort: "low" },
      { model: "other", effort: "low" },
    ]);
    expect(adapter.sets.map(({ previous, settings }) => [previous, settings])).toEqual([
      [{ model: "fake" }, { model: "fake", effort: "low" }],
      [
        { model: "fake", effort: "low" },
        { model: "other", effort: "low" },
      ],
    ]);
    expect(result.usage.map(({ execution }) => [execution.model, execution.effort])).toEqual([
      ["fake", undefined],
      ["fake", "low"],
      ["fake", "low"],
      ["other", "low"],
      ["other", "low"],
    ]);
  });

  test("a repeated id is the same switch; one reused with another spec is refused", async () => {
    const adapter = settingAdapter();
    const result = await run(adapter, async (context) => {
      const agent = await context.agents.open({ key: "reviewer", runtime: "review" });
      const once = agent.set({ id: "quiet", effort: "low" });
      const again = agent.set({ id: "quiet", effort: "low" });
      const other = await settled(agent.set({ id: "quiet", effort: "high" }));
      await once;
      return [once === again, other];
    });

    expect(result.value).toEqual([
      true,
      "settings id quiet was reused with a different specification",
    ]);
    expect(adapter.sets).toHaveLength(1);
  });

  test("is refused before it is queued: another harness, nothing to set, a level the harness lacks, or a host that cannot switch", async () => {
    const adapter = settingAdapter();
    const fixed = settingAdapter({ sets: false });
    const result = await run(adapter, async (context) => {
      const fake = await context.agents.open({ key: "fake", runtime: "review" });
      const claude = await context.agents.open({ key: "claude", runtime: "deep" });
      return Promise.all([
        settled(fake.set({ harness: "codex", model: "x" } as SettingsSpec)),
        settled(fake.set({})),
        settled(fake.set({ model: "" })),
        settled(claude.set({ effort: "huge" })),
      ]);
    });
    const unswitchable = await run(fixed, async (context) => {
      const agent = await context.agents.open({ key: "fake", runtime: "review" });
      return settled(agent.set({ effort: "low" }));
    });

    expect(result.value).toEqual([
      "set changes an agent's model and effort, not its harness: another harness or placement is another agent",
      "set names neither a model nor an effort",
      'set names no model: ""',
      'agent claude: claude has no effort "huge"; its levels are low, medium, high, xhigh, max',
    ]);
    expect(adapter.sets).toHaveLength(0);
    expect(unswitchable.value).toBe(
      "agent fake: fake pane agents cannot switch model or effort yet",
    );
  });

  test("a pane whose switch failed is closed, its settings unknown", async () => {
    const adapter = settingAdapter({ refuse: () => "the screen never showed the switch" });
    const result = await run(adapter, async (context) => {
      const agent = await context.agents.open({ key: "reviewer", runtime: "review" });
      await ask(agent);
      const failed = await agent.set({ effort: "low" });
      return [failed.kind, failed.usage.execution.effort ?? null, await settled(ask(agent))];
    });

    expect(result.value).toEqual(["failed", null, "logical agent is closed"]);
    expect(adapter.closed).toEqual(["reviewer"]);
  });
});

describe("set, as it ends", () => {
  test("a pane's switch past its deadline closes the agent", async () => {
    const adapter = settingAdapter({
      refuse: ({ signal }) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve("aborted"))),
    });
    const result = await run(adapter, async (context) => {
      const agent = await context.agents.open({ key: "reviewer", runtime: "review" });
      await ask(agent);
      const late = await agent.set({ effort: "low", timeoutMs: 50 });
      return [late.kind, late.usage.execution.effort ?? null, await settled(ask(agent))];
    });

    expect(result.value).toEqual(["timed-out", null, "logical agent is closed"]);
    expect(adapter.closed).toEqual(["reviewer"]);
  });

  test("a headless switch that failed leaves the agent open at its old settings", async () => {
    const adapter = settingAdapter({ refuse: () => "no" });
    const result = await run(adapter, async (context) => {
      const agent = await context.agents.open({
        key: "reviewer",
        runtime: { alias: "review", placement: "headless" },
      });
      await ask(agent);
      const failed = await agent.set({ effort: "low" });
      return [failed.kind, (await ask(agent)).outcome.kind];
    });

    expect(result.value).toEqual(["failed", "answered"]);
    expect(adapter.turns.map(({ settings }) => settings)).toEqual([
      { model: "fake" },
      { model: "fake" },
    ]);
    expect(result.usage.map(({ execution }) => execution.effort ?? null)).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("one past its deadline before it runs asks the host nothing and leaves the agent open", async () => {
    const adapter = settingAdapter();
    const result = await run(adapter, async (context) => {
      const agent = await context.agents.open({ key: "reviewer", runtime: "review" });
      const slow = agent.run({ prompt: "Go.", schema: ANSWER });
      const late = agent.set({ effort: "low", deadline: { unixMilliseconds: Date.now() + 1 } });
      await slow;
      return [(await late).kind, (await ask(agent)).outcome.kind];
    });

    expect(result.value).toEqual(["timed-out", "answered"]);
    expect(adapter.sets).toHaveLength(0);
  });

  test("before the first turn, and before a compaction, the switch is what they run at", async () => {
    const adapter = settingAdapter();
    const result = await run(adapter, async (context) => {
      const agent = await context.agents.open({ key: "reviewer", runtime: "review" });
      await agent.set({ effort: "low" });
      await ask(agent);
      await agent.set({ effort: "high" });
      return (await agent.compact({ prompt: "Keep the plan." })).usage.execution.effort ?? null;
    });

    expect(result.value).toBe("high");
    expect(adapter.turns.map(({ kind, settings }) => [kind, settings.effort])).toEqual([
      ["turn", "low"],
      ["compact", "high"],
    ]);
  });

  test("an effort that is no level's name is refused, whatever the harness", async () => {
    const adapter = settingAdapter();
    const result = await run(adapter, async (context) => {
      const agent = await context.agents.open({ key: "reviewer", runtime: "review" });
      return [
        await settled(agent.set({ effort: null as unknown as string })),
        await settled(
          context.agents.open({
            key: "other",
            runtime: { harness: "fake", model: "fake", effort: 3 as unknown as string },
          }),
        ),
      ];
    });

    expect(result.value).toEqual([
      "an effort is a level's name, not null",
      "an effort is a level's name, not 3",
    ]);
  });
});

describe("a fork's settings", () => {
  test("are its parent's after every set queued before it, or the effort it names", async () => {
    const adapter = settingAdapter();
    const result = await run(adapter, async (context) => {
      const worker = await context.agents.open({ key: "worker", runtime: "deep" });
      await ask(worker);
      void worker.set({ model: "sonnet", effort: "low" });
      const same = await worker.fork({ key: "same" });
      const deeper = await worker.fork({ key: "deeper", effort: "max" });
      const refused = await settled(worker.fork({ key: "bogus", effort: "huge" }));
      return [same.execution, deeper.execution, refused];
    });

    expect(result.value).toEqual([
      { harness: "claude", model: "sonnet", effort: "low", alias: "deep" },
      { harness: "claude", model: "sonnet", effort: "max", alias: "deep" },
      'claude has no effort "huge"; its levels are low, medium, high, xhigh, max',
    ]);
  });

  test("is refused when a set queued before it did not take", async () => {
    const adapter = settingAdapter({ refuse: () => "no" });
    const result = await run(adapter, async (context) => {
      const worker = await context.agents.open({
        key: "worker",
        runtime: { alias: "review", placement: "headless" },
      });
      await ask(worker);
      const failed = worker.set({ effort: "low" });
      const fork = settled(worker.fork({ key: "copy" }));
      return [(await failed).kind, await fork, worker.execution.effort ?? null];
    });

    expect(result.value).toEqual([
      "failed",
      "agent worker was not at the settings its fork was opened at: a set queued before the fork did not take",
      null,
    ]);
  });
});
