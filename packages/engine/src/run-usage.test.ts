import { afterAll, describe, expect, jest, test } from "bun:test";
import type { TokenUsage } from "@wf/contract/records";
import type {
  JsonValue,
  OutputSchema,
  WorkflowContext,
  WorkflowDefinition,
} from "@wf/contract/workflow";
import {
  createSingleSessionHostFactory,
  type SessionAccounting,
  type UsageRecord,
} from "@wf/harness";
import type { AgentRuntimeConfig, AgentSessionAdapter } from "@wf/harness/adapter";
import { createFakeAdapter, type FakeAdapterTurnContext } from "@wf/harness/testing";
import { createRunLedger } from "./run-usage";
import { createTempRunDirs, future, submit } from "./testing";
import { runWorkflow, startWorkflow } from "./workflow-runner";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const ANSWER: OutputSchema<{ answer: string }> = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

/** Session files, as a fake: each session's requests, logged while the fake agent works. */
function sessionFiles() {
  const logged = new Map<string, UsageRecord[]>();
  let requests = 0;
  return {
    log(session: string, output: number, at = new Date().toISOString()) {
      requests += 1;
      const record: UsageRecord = {
        key: `req_${requests}`,
        at,
        model: "model-a",
        delegated: false,
        tokens: tokens(output),
      };
      logged.set(session, [...(logged.get(session) ?? []), record]);
      return record;
    },
    /** Sessions whose turn the fake still reports as being written. */
    open: new Set<string>(),
    accounting(overrides: Partial<SessionAccounting> = {}): SessionAccounting & { reads: number } {
      const files = this;
      const accounting = {
        reads: 0,
        pollMs: 5,
        stalledMs: 1_000,
        statusMs: 50,
        async read(_execution: unknown, sessions: readonly string[]) {
          accounting.reads += 1;
          const found = sessions.filter((session) => logged.has(session));
          return found.length === 0
            ? undefined
            : {
                records: found.flatMap((session) => logged.get(session)!),
                open: found.some((session) => files.open.has(session)),
              };
        },
        async billing() {
          return "subscription" as const;
        },
        ...overrides,
      };
      return accounting;
    },
  };
}

describe("usage read when the run ends", () => {
  test("an agent that timed out is charged with what it spent", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: async (context) => {
        files.log("s-slow", 40);
        await aborted(context);
        return { sessionRef: "s-slow" };
      },
    });

    const result = await run(adapter, files.accounting(), async (context) => {
      const agent = await open(context, "slow");
      return (await agent.run({ prompt: "Wait.", timeoutMs: 30, nudge: false })).outcome.kind;
    });

    expect(result.value).toBe("timed-out");
    expect(result.usage[0]).toMatchObject({
      billing: "subscription",
      sessions: [{ harness: "fake", id: "s-slow" }],
      spend: [{ model: "model-a", delegated: false, tokens: tokens(40) }],
    });
  });

  test("an agent's two operations are split where the second was delivered", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "s-1",
        act: async () => {
          // Clear of the millisecond each delivery is stamped in, on both sides.
          await Bun.sleep(5);
          files.log("s-1", context.turn * 10);
          await Bun.sleep(5);
          files.log("s-1", context.turn * 100);
          await Bun.sleep(5);
          await submit(context.binding!, { answer: "ok" });
        },
      }),
    });

    const result = await run(adapter, files.accounting(), async (context) => {
      const agent = await open(context, "twice");
      await agent.run({ prompt: "First.", schema: ANSWER });
      await agent.run({ prompt: "Second.", schema: ANSWER });
      return null;
    });

    expect(result.usage.map((usage) => usage.spend?.[0]?.tokens.output)).toEqual([110, 220]);
  });

  test("no sessions or no files is unknown; an operation never delivered spent nothing", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        ...(context.activation.key === "unnamed" ? {} : { sessionRef: context.activation.key }),
        act: async () => {
          if (context.activation.key === "logged") files.log("logged", 7);
          await submit(context.binding!, { answer: "ok" });
        },
      }),
    });

    const result = await run(adapter, files.accounting(), async (context) => {
      for (const key of ["unnamed", "unlogged", "logged"]) {
        await (await open(context, key)).run({ prompt: "Go.", schema: ANSWER });
      }
      const logged = await open(context, "logged");
      await logged.run({ prompt: "Late.", deadline: { unixMilliseconds: Date.now() - 1 } });
      return null;
    });

    const [unnamed, unlogged, logged, undelivered] = result.usage;
    expect(unnamed).not.toHaveProperty("spend");
    expect(unlogged).not.toHaveProperty("spend");
    expect(logged!.spend).toEqual([{ model: "model-a", delegated: false, tokens: tokens(7) }]);
    expect(undelivered!.spend).toEqual([]);
  });

  test("a turn still being written is read again until it closes", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "s-late",
        act: async () => {
          files.log("s-late", 1);
          files.open.add("s-late");
          await submit(context.binding!, { answer: "ok" });
        },
      }),
    });
    const accounting = files.accounting();
    const read = accounting.read;
    accounting.read = async (...args) => {
      // The released turn writes its last request, and ends, after the run has returned.
      if (accounting.reads === 2) {
        files.log("s-late", 2);
        files.open.delete("s-late");
      }
      return read(...args);
    };

    const result = await run(adapter, accounting, async (context) => {
      await (await open(context, "late")).run({ prompt: "Go.", schema: ANSWER });
      return null;
    });

    expect(result.usage[0]!.spend![0]!.tokens.output).toBe(3);
    expect(accounting.reads).toBe(3);
  });

  test("a turn left open by a closed pane is given up once it stops changing", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "s-cut",
        act: async () => {
          files.log("s-cut", 4);
          files.open.add("s-cut");
          await submit(context.binding!, { answer: "ok" });
        },
      }),
    });
    const accounting = files.accounting({ stalledMs: 30 });

    const started = Date.now();
    const result = await run(adapter, accounting, async (context) => {
      await (await open(context, "cut")).run({ prompt: "Go.", schema: ANSWER });
      return null;
    });

    expect(result.usage[0]!.spend![0]!.tokens.output).toBe(4);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("stopping the run while its spend is read keeps the records as they settled", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "s-stop",
        act: async () => {
          files.open.add("s-stop");
          files.log("s-stop", 4);
          await submit(context.binding!, { answer: "ok" });
        },
      }),
    });
    const accounting = files.accounting({ pollMs: 50, stalledMs: 60_000 });
    const handle = await startWorkflow(
      workflow(async (context) => {
        await (await open(context, "stopped")).run({ prompt: "Go.", schema: ANSWER });
        return null;
      }),
      null,
      {
        runRoot: runDirs.tempRunDir(),
        deadline: future(),
        runtime: { aliases: ALIASES, host: createSingleSessionHostFactory(adapter, accounting) },
      },
    );
    while (accounting.reads === 0) await Bun.sleep(5);

    const started = Date.now();
    await handle.stop("operator");
    const result = await handle.result;

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.usage[0]).toMatchObject({ billing: "unknown", sessions: [{ id: "s-stop" }] });
    expect(result.usage[0]).not.toHaveProperty("spend");
  });

  test("a reader or billing that throws, even at once, leaves spend unknown and the run intact", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "s-bad",
        act: () => submit(context.binding!, { answer: "ok" }).then(() => undefined),
      }),
    });
    const accounting = files.accounting({
      read: () => {
        throw new Error("unreadable");
      },
      billing: () => {
        throw new Error("no status");
      },
    });

    const result = await run(adapter, accounting, async (context) => {
      await (await open(context, "bad")).run({ prompt: "Go.", schema: ANSWER });
      return "done";
    });

    expect(result.value).toBe("done");
    expect(result.usage[0]).toMatchObject({ billing: "unknown", sessions: [{ id: "s-bad" }] });
    expect(result.usage[0]).not.toHaveProperty("spend");
  });

  test("a request before the first delivery is the first operation's; a bad time is dropped", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "s-early",
        act: async () => {
          await Bun.sleep(5);
          files.log("s-early", 3);
          await submit(context.binding!, { answer: "ok" });
        },
      }),
    });
    let startedAt = 0;
    const result = await run(adapter, files.accounting(), async (context) => {
      startedAt = Date.now();
      // Logged while the agent was starting, before any prompt reached it.
      files.log("s-early", 20, new Date(startedAt).toISOString());
      files.log("s-early", 900, "not a time");
      await (await open(context, "early")).run({ prompt: "Go.", schema: ANSWER });
      return null;
    });

    expect(result.usage[0]!.spend![0]!.tokens.output).toBe(23);
  });

  test("an answer that came before its turn was held still marks where its spend begins", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          files.log("s-eager", 4);
          await Bun.sleep(5);
          await submit(context.binding!, { answer: "ok" });
          await Bun.sleep(5);
        },
      }),
    });
    const eager = {
      ...adapter,
      async activate(request: Parameters<AgentSessionAdapter["activate"]>[0]) {
        const session = await adapter.activate(request);
        let starts = 0;
        return {
          ...session,
          sessions: () => ["s-eager"],
          start: (async (turn: never, binding: { endpoint: string; operationId: string }) => {
            starts += 1;
            // The second operation's agent answers while the harness still reports it starting.
            if (starts === 2) {
              await Bun.sleep(5);
              files.log("s-eager", 6);
              await submit(binding, { answer: "ok" });
            }
            return (session.start as (t: never, b: typeof binding) => unknown)(turn, binding);
          }) as typeof session.start,
        };
      },
    };

    const result = await run(eager, files.accounting(), async (context) => {
      const agent = await open(context, "eager");
      await agent.run({ prompt: "First.", schema: ANSWER });
      await agent.run({ prompt: "Second.", schema: ANSWER });
      return null;
    });

    expect(result.usage[1]!.deliveredAt).toBeDefined();
    expect(result.usage.map((usage) => usage.spend?.[0]?.tokens.output)).toEqual([4, 6]);
  });

  test("which of two agents keeps a request they both name follows the order they were opened", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "shared",
        act: async () => {
          if (context.activation.key === "b") files.log("shared", 5);
          await submit(context.binding!, { answer: "ok" });
        },
      }),
    });
    const slow = {
      ...adapter,
      async activate(request: Parameters<AgentSessionAdapter["activate"]>[0]) {
        // The agent opened first finishes starting last.
        if (request.key === "a") await Bun.sleep(20);
        return adapter.activate(request);
      },
    };

    const result = await run(slow, files.accounting(), async (context) => {
      const [a, b] = await Promise.all([open(context, "a"), open(context, "b")]);
      await b.run({ prompt: "Go.", schema: ANSWER });
      await a.run({ prompt: "Go.", schema: ANSWER });
      return null;
    });

    const byAgent = Object.fromEntries(result.usage.map((usage) => [usage.agent, usage.spend]));
    expect(byAgent).toEqual({
      a: [{ model: "model-a", delegated: false, tokens: tokens(5) }],
      b: [],
    });
  });

  test("a request two agents both name, or one from before the run, is not counted", async () => {
    const files = sessionFiles();
    files.log("shared", 1_000, "2020-01-01T00:00:00.000Z");
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "shared",
        act: async () => {
          if (context.activation.key === "first") files.log("shared", 5);
          await submit(context.binding!, { answer: "ok" });
        },
      }),
    });

    const result = await run(adapter, files.accounting(), async (context) => {
      await (await open(context, "first")).run({ prompt: "Go.", schema: ANSWER });
      await (await open(context, "second")).run({ prompt: "Go.", schema: ANSWER });
      return null;
    });

    expect(result.usage.map((usage) => usage.spend)).toEqual([
      [{ model: "model-a", delegated: false, tokens: tokens(5) }],
      [],
    ]);
  });

  test("a harness's own dollar figure is a charge only when billing is per token", async () => {
    const outcomes = async (billing: "metered" | "subscription") => {
      const files = sessionFiles();
      const adapter = createFakeAdapter({
        script: (context) => ({
          chargesUsd: [0.25],
          act: () => submit(context.binding!, { answer: "ok" }).then(() => undefined),
        }),
      });
      const result = await run(
        adapter,
        files.accounting({ billing: async () => billing }),
        async (context) => {
          await (await open(context, "priced")).run({ prompt: "Go.", schema: ANSWER });
          return null;
        },
      );
      return result.usage[0]!;
    };

    expect((await outcomes("metered")).charged).toEqual({ amount: 0.25, currency: "USD" });
    expect(await outcomes("subscription")).not.toHaveProperty("charged");
  });

  test("the run's finish is taken before its spend is read, so waiting on files is not its time", async () => {
    const files = sessionFiles();
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "s-slow-read",
        act: () => submit(context.binding!, { answer: "ok" }).then(() => undefined),
      }),
    });
    let readAt = 0;
    const accounting = files.accounting({
      async read() {
        readAt = Date.now();
        await Bun.sleep(50);
        return undefined;
      },
    });

    const result = await run(adapter, accounting, async (context) => {
      await (await open(context, "slow-read")).run({ prompt: "Go.", schema: ANSWER });
      return null;
    });

    expect(Date.parse(result.finishedAt)).toBeLessThanOrEqual(readAt);
    expect(result.accounting.wallMs).toBe(
      Date.parse(result.finishedAt) - Date.parse(result.startedAt),
    );
  });

  test("a host with no accounting reads nothing and leaves billing unknown", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "s",
        act: () => submit(context.binding!, { answer: "ok" }).then(() => undefined),
      }),
    });

    const result = await runWorkflow(
      workflow(async (context) => {
        await (await open(context, "plain")).run({ prompt: "Go.", schema: ANSWER });
        return null;
      }),
      null,
      {
        runRoot: runDirs.tempRunDir(),
        deadline: future(),
        runtime: { aliases: ALIASES, host: createSingleSessionHostFactory(adapter) },
      },
    );

    expect(result.usage[0]).toMatchObject({ billing: "unknown", sessions: [{ id: "s" }] });
    expect(result.usage[0]).not.toHaveProperty("spend");
  });
});

describe("the bound on reading spend", () => {
  test("a read that outlasts it starts no status command once the records are returned", async () => {
    let finishRead: (() => void) | undefined;
    let billed = 0;
    const accounting: SessionAccounting = {
      pollMs: 5,
      stalledMs: 1_000,
      statusMs: 50,
      read: () =>
        new Promise((resolve) => {
          finishRead = () => resolve({ records: [], open: false });
        }),
      billing: async () => {
        billed += 1;
        return "subscription";
      },
    };
    jest.useFakeTimers();
    try {
      const ledger = createRunLedger({ accounting, startedAt: Date.now() });
      ledger
        .agent({
          key: "slow",
          execution: { harness: "fake", model: "fake" },
          cwd: "/",
          sessions: () => ["s"],
        })
        .reserve("op-1")
        .settle({ settledAt: Date.now() }, []);

      const settling = ledger.settle(new AbortController().signal);
      jest.advanceTimersByTime(60_000);
      expect(await settling).toMatchObject([{ billing: "unknown" }]);
      finishRead!();
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();

      expect(billed).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

const ALIASES = { review: { harness: "fake", model: "fake" } };

function tokens(output: number): TokenUsage {
  return { input: 1, cacheRead: 2, cacheWrite: 0, output };
}

function open(context: WorkflowContext, key: string) {
  return context.agents.open({ key, runtime: "review" });
}

function aborted(context: FakeAdapterTurnContext): Promise<void> {
  return new Promise((resolve) =>
    context.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function workflow<Result extends JsonValue>(
  body: (context: WorkflowContext) => Promise<Result>,
): WorkflowDefinition<null, Result> {
  return { meta: { name: "usage", description: "fixture" }, run: body };
}

function run<Result extends JsonValue>(
  adapter: AgentSessionAdapter,
  accounting: SessionAccounting,
  body: (context: WorkflowContext) => Promise<Result>,
) {
  const runtime: AgentRuntimeConfig = {
    aliases: ALIASES,
    host: createSingleSessionHostFactory(adapter, accounting),
  };
  return runWorkflow(workflow(body), null, {
    runRoot: runDirs.tempRunDir(),
    deadline: future(),
    runtime,
  });
}
