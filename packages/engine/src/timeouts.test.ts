import { afterAll, expect, test } from "bun:test";
import {
  type AbsoluteDeadline,
  type AgentRef,
  defineWorkflow,
  type JsonValue,
  tool,
  type WorkflowContext,
  yesNo,
} from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentRunHostFactory, HarnessSession } from "@agentswf/harness/adapter";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { boundedDeadline } from "./deadlines";
import { checkedKeepAlive } from "./keep-alive";
import { createTempRunDirs, future, runNew } from "./testing";
import type { RunnableWorkflow } from "./workflow-runner";
import { answer, testWorkflow } from "./workflow-testing";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

/** A host whose turns, compactions and switches note the deadline each was handed. */
function noting(seen: number[]): AgentRunHostFactory {
  const inner = createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) }));
  return {
    async openRun(spec) {
      const run = await inner.openRun(spec);
      return {
        ...run,
        async openAgent(request) {
          const session = await run.openAgent(request);
          const start = session.start.bind(session) as (
            ...args: Parameters<HarnessSession["start"]>
          ) => ReturnType<HarnessSession["start"]>;
          return {
            ...session,
            start: ((...args: Parameters<HarnessSession["start"]>) => {
              seen.push(args[0].deadline.unixMilliseconds);
              return start(...args);
            }) as HarnessSession["start"],
          };
        },
      };
    },
  };
}

async function deadlinesOf(
  run: (wf: WorkflowContext, agent: AgentRef) => Promise<unknown>,
  deadline?: AbsoluteDeadline,
): Promise<number[]> {
  const seen: number[] = [];
  const workflow: RunnableWorkflow<null, null> = {
    meta: { name: "bounds", description: "bounds" },
    async run(wf) {
      const agent = await wf.agents.open({ key: "reviewer", runtime: "review" });
      await run(wf, agent);
      return null;
    },
  };
  await runNew(workflow, null, {
    runRoot: runDirs.tempRunDir(),
    ...(deadline ? { deadline } : {}),
    runtime: { aliases: { review: { harness: "fake", model: "fake" } }, host: noting(seen) },
  });
  return seen;
}

test("a timeout longer than the bound around it, a parallel in a stage, is cut to it", async () => {
  let parallelEnd = 0;
  const seen = await deadlinesOf(async (wf, agent) => {
    await wf.stage("review", async () => {
      parallelEnd = Date.now() + 120_000;
      await wf.parallel(
        [0],
        async () => {
          await agent.run({ prompt: "Review.", timeout: "1h", nudge: false });
          await agent.run({ prompt: "Review.", timeout: new Date(Date.now() + 3_600_000) });
          await agent.run({ prompt: "Review.", timeout: false, nudge: false });
        },
        { timeout: "2m" },
      );
    });
  }, future(3_600_000));
  expect(seen).toHaveLength(3);
  // The parallel's deadline is fixed once, when it is called: every turn in it gets that one.
  expect(new Set(seen).size).toBe(1);
  expect(seen[0]).toBeGreaterThanOrEqual(parallelEnd);
  expect(seen[0]).toBeLessThan(parallelEnd + 1_000);
});

test("a timeout longer than the run's is cut to the run's, and wf.deadline as a timeout is the run's", async () => {
  const run = future(5_000);
  const seen = await deadlinesOf(async (wf, agent) => {
    await wf.stage("review", async () => {
      await agent.run({ prompt: "Review.", timeout: "1h", nudge: false });
      await agent.run({ prompt: "Review.", timeout: wf.deadline, nudge: false });
    });
  }, run);
  expect(seen).toEqual([run.unixMilliseconds, run.unixMilliseconds]);
});

test("a shorter timeout wins, a Date or a duration", async () => {
  const at = Date.now() + 90_000;
  let before = 0;
  const seen = await deadlinesOf(async (_wf, agent) => {
    await agent.run({ prompt: "Review.", timeout: new Date(at), nudge: false });
    before = Date.now();
    await agent.run({ prompt: "Review.", timeout: "90s", nudge: false });
    await agent.run({ prompt: "Review.", timeout: "1.5m", nudge: false });
  }, future(3_600_000));
  expect(seen[0]).toBe(at);
  for (const relative of seen.slice(1)) {
    expect(relative).toBeGreaterThanOrEqual(before + 90_000);
    expect(relative).toBeLessThan(before + 91_000);
  }
});

test("boundedDeadline: a timeout's deadline, never past the bound around it", () => {
  const ceiling = { unixMilliseconds: Date.now() + 60_000 };
  const at = Date.now() + 30_000;
  expect(boundedDeadline(new Date(at), ceiling)).toEqual({ unixMilliseconds: at });
  expect(boundedDeadline("1h", ceiling)).toBe(ceiling);
  expect(boundedDeadline(false, ceiling)).toBe(ceiling);
  expect(boundedDeadline(undefined, ceiling)).toBe(ceiling);
  expect(boundedDeadline(undefined, undefined)).toBeUndefined();
  // An untyped caller's null is no bound.
  expect(boundedDeadline(null, ceiling)).toBe(ceiling);
  // A plain JavaScript caller, past what tsc checks.
  expect(() => boundedDeadline("10x" as "10m", ceiling)).toThrow(
    'a timeout is a positive duration: a duration is a decimal and s, m, h or d, such as "90s"',
  );
  expect(() => boundedDeadline("0s", ceiling)).toThrow(
    'a timeout is a positive duration: not "0s"',
  );
  expect(() => boundedDeadline(new Date(Number.NaN), ceiling)).toThrow(
    "a timeout's Date is a valid time",
  );
});

test("keepAlive's window is checked", () => {
  expect(checkedKeepAlive("a", { window: "90s" })).toEqual({ windowMs: 90_000 });
  expect(checkedKeepAlive("a", {})).toEqual({});
  expect(() => checkedKeepAlive("a", { window: "soon" })).toThrow(
    "agent a: keepAlive's window is a positive duration: a duration is",
  );
  expect(() => checkedKeepAlive("a", { window: "0m" })).toThrow(
    `agent a: keepAlive's window is a positive duration: not "0m"`,
  );
});

const plain = (run: (wf: WorkflowContext) => Promise<JsonValue>) =>
  defineWorkflow<null, JsonValue>({ meta: { name: "old-time", description: "old" }, run });

test("each call takes its timeout", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const agent = await wf.agents.open({
        key: "a",
        runtime: "claude",
        timeout: "1m",
        tools: { look: tool({ description: "Look.", handler: () => "seen", timeout: "30s" }) },
      });
      const [first] = await wf.parallel(
        [0],
        () => agent.run({ prompt: "One.", timeout: new Date(Date.now() + 60_000) }),
        { timeout: "5m" },
      );
      await agent.compact({ prompt: "Keep it.", timeout: "1m" });
      await agent.set({ effort: "high", timeout: false });
      const fork = await agent.fork({ key: "b", timeout: "1m" });
      await fork.run({ prompt: "Fork.", timeout: "1m" });
      const { answers } = await wf.decisions.decide({
        key: "ok",
        model: "jev",
        state: "x",
        questions: { ok: yesNo("Ok?") },
        timeout: "30s",
      });
      return [first!.outcome.kind, answers.ok.yes];
    }),
    {
      agents: { a: answer("yes"), b: answer("yes") },
      decisions: { ok: { ok: true } },
      timeout: "10m",
      stall: "2s",
    },
  );
  expect(run.value).toEqual(["answered", 1]);
});

test("wf.deadline is a Date, a new one at each read", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const end = wf.deadline!;
      const ms = end.getTime();
      // Each read is a new Date: changing one doesn't move the run's.
      end.setTime(0);
      return [end instanceof Date, ms === wf.deadline!.getTime(), wf.deadline!.getTime() > 0];
    }),
    { timeout: "1h" },
  );
  expect(run.value).toEqual([true, true, true]);
});

test("wf.deadline bounds a call as a timeout", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      return (await agent.run({ prompt: "Go.", timeout: wf.deadline })).outcome.kind;
    }),
    { agents: { a: answer("yes") }, timeout: "1h" },
  );
  expect(run.value).toBe("answered");
});

test("a test's timeout and stall, and a send's timeout", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      const coordinator = await wf.participants.connect({ key: "coordinator" });
      await wf.messages.allow({ between: [agent, coordinator], purpose: "ask" });
      const { outcome } = await agent.run({ prompt: "Ask." });
      await coordinator.release("done");
      return [wf.deadline !== undefined, outcome.kind];
    }),
    {
      agents: {
        a: answer(async (turn) => {
          const sent = await turn.send("coordinator", "Which?", {
            awaitReply: true,
            timeout: "1m",
          });
          return sent.kind;
        }),
      },
      participants: {
        coordinator: (event) =>
          event.kind === "message" && event.asks ? event.reply("That one.") : undefined,
      },
      timeout: "10m",
      stall: "2s",
    },
  );
  expect(run.value).toEqual([true, "answered"]);
});

test("a test's timeoutMs and stallMs are refused by name", async () => {
  const workflow = plain(async () => null);
  await expect(testWorkflow(workflow, { timeoutMs: 1 } as never)).rejects.toThrow(
    'testWorkflow has no option "timeoutMs"',
  );
  await expect(testWorkflow(workflow, { stallMs: 1 } as never)).rejects.toThrow(
    'testWorkflow has no option "stallMs"',
  );
});

test("a tool's timeout bounds each call", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const hang = tool({
        description: "Hangs.",
        handler: (_input, call) =>
          new Promise((resolve) => call.signal.addEventListener("abort", () => resolve("x"))),
        timeout: "0.05s",
      });
      const agent = await wf.agents.open({
        key: "a",
        runtime: "claude",
        tools: { slow: hang, other: hang },
      });
      const { outcome } = await agent.run({ prompt: "Call both." });
      return outcome.answered ? outcome.value : outcome.kind;
    }),
    {
      agents: {
        a: answer(async (turn) => {
          const slow = await turn.tool("slow");
          const other = await turn.tool("other");
          return [slow, other].map((r) => ("error" in r ? r.error : r.kind)).join(" | ");
        }),
      },
    },
  );
  const late = (name: string) =>
    `${name} didn't answer in time (0.05 s); it may have run, so check before calling it again`;
  expect(run.value).toBe(`${late("slow")} | ${late("other")}`);
});

test("a tool's timeout: false leaves only the turn's deadline", async () => {
  const slow = (timeout: "0.05s" | false) =>
    tool({
      description: "Answers in 100 ms.",
      timeout,
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "done";
      },
    });
  const calling = answer(async (turn) => {
    const results = [];
    for (const name of ["unbounded", "bounded"]) {
      const called = await turn.tool(name);
      results.push("error" in called ? called.error : called.kind);
    }
    return results.join(" | ");
  });
  const run = await testWorkflow(
    plain(async (wf) => {
      const tools = { unbounded: slow(false), bounded: slow("0.05s") };
      const agent = await wf.agents.open({ key: "a", runtime: "claude", tools });
      const roomy = await agent.run({ prompt: "Call both.", timeout: "1m" });
      // A turn shorter than the call: only its deadline ends an unbounded one.
      const other = await wf.agents.open({ key: "b", runtime: "claude", tools });
      const tight = await other.run({ prompt: "Call both.", timeout: "0.05s" });
      return [
        roomy.outcome.answered ? roomy.outcome.value : roomy.outcome.kind,
        tight.outcome.kind,
      ];
    }),
    { agents: { a: calling, b: answer(async (turn) => (await turn.tool("unbounded")).kind) } },
  );
  expect(run.value).toEqual([
    "result | bounded didn't answer in time (0.05 s); it may have run, so check before calling it again",
    "timed-out",
  ]);
});

test("a timeout Date already past fails open and decide with DeadlineExceededError", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const past = new Date(Date.now() - 1_000);
      const name = (call: () => Promise<unknown>) =>
        call().then(
          () => "ran",
          (error: Error) => error.name,
        );
      return [
        await name(() => wf.agents.open({ key: "a", runtime: "claude", timeout: past })),
        await name(() =>
          wf.decisions.decide({
            key: "ok",
            model: "jev",
            state: "x",
            questions: { ok: yesNo("Ok?") },
            timeout: past,
          }),
        ),
      ];
    }),
    { decisions: { ok: { ok: true } } },
  );
  expect(run.value).toEqual(["DeadlineExceededError", "DeadlineExceededError"]);
});
