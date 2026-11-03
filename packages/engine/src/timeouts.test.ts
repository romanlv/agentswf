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
import { DEPRECATIONS, type Deprecated, deprecationLine } from "./deprecations";
import { checkedKeepAlive } from "./keep-alive";
import { caseRun, createTempRunDirs, future, runNew, startCase } from "./testing";
import type { RunnableWorkflow } from "./workflow-runner";
import { answer, type TestRun, testWorkflow } from "./workflow-testing";

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

test("a timeout longer than the bound around it, a parallel in a stage, is cut to it, as a deadline was", async () => {
  let parallelEnd = 0;
  const seen = await deadlinesOf(async (wf, agent) => {
    await wf.stage("review", async () => {
      parallelEnd = Date.now() + 120_000;
      await wf.parallel(
        [0],
        async () => {
          await agent.run({ prompt: "Review.", timeout: "1h", nudge: false });
          await agent.run({ prompt: "Review.", timeout: new Date(Date.now() + 3_600_000) });
          await agent.run({ prompt: "Review.", deadline: future(3_600_000), nudge: false });
          await agent.run({ prompt: "Review.", timeoutMs: 3_600_000, nudge: false });
          await agent.run({ prompt: "Review.", timeout: false, nudge: false });
        },
        { timeout: "2m" },
      );
    });
  }, future(3_600_000));
  expect(seen).toHaveLength(5);
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

test("a shorter timeout wins, and the old fields resolve to the deadline the new one does", async () => {
  const at = Date.now() + 90_000;
  let before = 0;
  const seen = await deadlinesOf(async (_wf, agent) => {
    await agent.run({ prompt: "Review.", timeout: new Date(at), nudge: false });
    await agent.run({ prompt: "Review.", deadline: { unixMilliseconds: at }, nudge: false });
    await agent.run({
      prompt: "Review.",
      nudge: { deadline: { unixMilliseconds: at } },
    });
    before = Date.now();
    await agent.run({ prompt: "Review.", timeout: "90s", nudge: false });
    await agent.run({ prompt: "Review.", timeoutMs: 90_000, nudge: false });
    await agent.run({ prompt: "Review.", timeout: "1.5m", nudge: false });
  }, future(3_600_000));
  expect(seen.slice(0, 3)).toEqual([at, at, at]);
  for (const relative of seen.slice(3)) {
    expect(relative).toBeGreaterThanOrEqual(before + 90_000);
    expect(relative).toBeLessThan(before + 91_000);
  }
});

test("boundedDeadline: each form of a bound, the one it reports, and both at once refused", () => {
  const ceiling = { unixMilliseconds: Date.now() + 60_000 };
  const used: string[] = [];
  const report = (name: string, call: string) => used.push(`${name} ${call}`);
  const bound = (given: Parameters<typeof boundedDeadline>[0]) =>
    boundedDeadline(given, ceiling, report, "on run");
  const at = Date.now() + 30_000;
  expect(bound({ timeout: new Date(at) })).toEqual({ unixMilliseconds: at });
  expect(bound({ deadline: { unixMilliseconds: at } })).toEqual({ unixMilliseconds: at });
  expect(bound({ timeout: "1h" })).toBe(ceiling);
  expect(bound({ timeout: false })).toBe(ceiling);
  expect(boundedDeadline({}, undefined, report, "on run")).toBeUndefined();
  bound({ timeoutMs: 1_000 });
  expect(used).toEqual(["deadline-option on run", "timeout-ms on run"]);
  // An untyped caller's null is no bound, as the old truthy checks had it.
  const untyped = { timeout: null, deadline: null, timeoutMs: null } as unknown as Parameters<
    typeof boundedDeadline
  >[0];
  expect(bound(untyped)).toBe(ceiling);
  // An old form that is invalid throws, and isn't reported as well.
  expect(() => bound({ timeoutMs: -1 })).toThrow("timeoutMs is a positive duration");
  expect(() => bound({ deadline: { unixMilliseconds: Number.NaN } })).toThrow(
    "deadline.unixMilliseconds must be",
  );
  expect(used).toHaveLength(2);
  expect(() => bound({ timeout: "1m", timeoutMs: 1 })).toThrow("give timeout alone");
  expect(() => bound({ timeout: "1m", deadline: { unixMilliseconds: at } })).toThrow(
    "give timeout alone",
  );
  // A plain JavaScript caller, past what tsc checks.
  expect(() => bound({ timeout: "10x" as "10m" })).toThrow(
    'a timeout is a positive duration: a duration is a decimal and s, m, h or d, such as "90s"',
  );
  expect(() => bound({ timeout: "0s" })).toThrow('a timeout is a positive duration: not "0s"');
  expect(() => bound({ timeout: new Date(Number.NaN) })).toThrow(
    "a timeout's Date is a valid time",
  );
});

test("keepAlive's window and its deprecated timeoutMs are one window; both at once are refused", () => {
  const used: string[] = [];
  const report = () => used.push("keep-alive-timeout-ms");
  expect(checkedKeepAlive("a", { window: "90s" }, report)).toEqual({ windowMs: 90_000 });
  expect(checkedKeepAlive("a", { timeoutMs: 90_000 }, report)).toEqual({ windowMs: 90_000 });
  expect(used).toEqual(["keep-alive-timeout-ms"]);
  expect(() => checkedKeepAlive("a", { window: "90s", timeoutMs: 1 }, report)).toThrow(
    "keepAlive's window is given alone",
  );
  expect(() => checkedKeepAlive("a", { window: "soon" }, report)).toThrow(
    "agent a: keepAlive's window is a positive duration: a duration is",
  );
  expect(() => checkedKeepAlive("a", { window: "0m" }, report)).toThrow(
    `agent a: keepAlive's window is a positive duration: not "0m"`,
  );
});

/** How often the run logged each deprecated name's line, whatever call it names. */
function said(run: TestRun<JsonValue>): Partial<Record<Deprecated, number>> {
  const counts: Partial<Record<Deprecated, number>> = {};
  for (const name of Object.keys(DEPRECATIONS) as Deprecated[]) {
    const { old } = DEPRECATIONS[name];
    const n = run.logs.filter(
      (log) => log.message === deprecationLine(name) || log.message.startsWith(`awf: ${old}, `),
    ).length;
    if (n > 0) counts[name] = n;
  }
  return counts;
}

/** The calls the run named for a deprecated name. */
function calls(run: TestRun<JsonValue>, name: Deprecated): string[] {
  const prefix = `awf: ${DEPRECATIONS[name].old}, `;
  return run.logs
    .filter((log) => log.message.startsWith(prefix))
    .map((log) => log.message.slice(prefix.length).split(",")[0]!);
}

const plain = (run: (wf: WorkflowContext) => Promise<JsonValue>) =>
  defineWorkflow<null, JsonValue>({ meta: { name: "old-time", description: "old" }, run });

test("an agent's old bounds work, each logged once an attempt", async () => {
  const deadline = () => ({ unixMilliseconds: Date.now() + 60_000 });
  const run = await testWorkflow(
    plain(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude", deadline: deadline() });
      const first = await agent.run({ prompt: "One.", timeoutMs: 60_000 });
      await agent.run({ prompt: "Once more.", timeoutMs: 60_000 });
      await agent.run({ prompt: "Two.", deadline: deadline(), nudge: { deadline: deadline() } });
      await agent.compact({ prompt: "Keep it.", timeoutMs: 60_000 });
      await agent.set({ effort: "high", deadline: deadline() });
      return first.outcome.kind;
    }),
    null,
    { agents: { a: answer("yes") } },
  );
  expect(run.value).toBe("answered");
  // Each call's old form is named once an attempt: run's twice, once.
  expect(calls(run, "timeout-ms")).toEqual(["on run", "on compact"]);
  expect(calls(run, "deadline-option")).toEqual(["on open", "on run", "on set"]);
  expect(said(run)).toEqual({ "deadline-option": 3, "timeout-ms": 2, "nudge-deadline": 1 });
});

test("the new bounds log nothing", async () => {
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
    null,
    {
      agents: { a: answer("yes"), b: answer("yes") },
      decisions: { ok: { ok: true } },
      timeout: "10m",
      stall: "2s",
    },
  );
  expect(run.value).toEqual(["answered", 1]);
  expect(said(run)).toEqual({});
});

test("a parallel's, a decision's and a tool's old bounds work, each logged once", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const agent = await wf.agents.open({
        key: "a",
        runtime: "claude",
        tools: { look: tool({ description: "Look.", handler: () => "seen", timeoutMs: false }) },
      });
      const [kind] = await wf.parallel(
        [0],
        async () => (await agent.run({ prompt: "One." })).outcome.kind,
        { deadline: future() },
      );
      const { answers } = await wf.decisions.decide({
        key: "ok",
        model: "jev",
        state: "x",
        questions: { ok: yesNo("Ok?") },
        deadline: future(),
      });
      return [kind!, answers.ok.yes];
    }),
    null,
    { agents: { a: answer("yes") }, decisions: { ok: { ok: true } } },
  );
  expect(run.value).toEqual(["answered", 1]);
  expect(calls(run, "deadline-option")).toEqual(["on parallel", "on decide"]);
  expect(calls(run, "timeout-ms")).toEqual(["on a tool"]);
});

test("old and new forms of one bound at once are refused, and log nothing", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const refused = async (call: () => Promise<unknown>) =>
        call().then(
          () => "ran",
          (error: Error) => error.message,
        );
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      return [
        await refused(() => agent.run({ prompt: "One.", timeout: "1m", timeoutMs: 1_000 })),
        await refused(() => agent.compact({ prompt: "Keep.", timeout: "1m", deadline: future() })),
        await refused(() => wf.parallel([0], async () => 0, { timeout: "1m", deadline: future() })),
        await refused(() =>
          wf.agents.open({
            key: "b",
            runtime: "claude",
            tools: {
              look: tool({ description: "Look.", handler: () => "", timeout: "1s", timeoutMs: 1 }),
            },
          }),
        ),
      ];
    }),
    null,
  );
  expect(run.value).toEqual([
    expect.stringContaining("give timeout alone"),
    expect.stringContaining("give timeout alone"),
    expect.stringContaining("give timeout alone"),
    expect.stringContaining("give timeout alone"),
  ]);
  expect(said(run)).toEqual({});
});

test("wf.deadline is a Date, whose deprecated unixMilliseconds reads the same time, logged once", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const end = wf.deadline!;
      const ms = end.unixMilliseconds;
      void wf.deadline?.unixMilliseconds;
      // Each read is a new Date: changing one doesn't move the run's.
      end.setTime(0);
      return [end instanceof Date, ms === wf.deadline!.getTime(), wf.deadline!.getTime() > 0];
    }),
    null,
    { timeout: "1h" },
  );
  expect(run.value).toEqual([true, true, true]);
  expect(said(run)).toEqual({ "run-deadline-ms": 1 });
});

test("wf.deadline bounds a call as a timeout, and as the deprecated deadline it was", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      const kinds: string[] = [];
      for (const bound of [
        { timeout: wf.deadline },
        { deadline: wf.deadline, nudge: { deadline: wf.deadline } },
      ])
        kinds.push((await agent.run({ prompt: "Go.", ...bound })).outcome.kind);
      return kinds;
    }),
    null,
    { agents: { a: answer("yes") }, timeout: "1h" },
  );
  expect(run.value).toEqual(["answered", "answered"]);
  expect(said(run)).toEqual({ "deadline-option": 1, "nudge-deadline": 1, "run-deadline-ms": 1 });
  expect(calls(run, "deadline-option")).toEqual(["on run"]);
});

test("keepAlive's timeoutMs keeps the run live as window does, logged once", async () => {
  const run = await testWorkflow(
    caseRun(async (workflow) => {
      const agent = await workflow.agents.open({
        key: "investigator",
        runtime: "claude",
        keepAlive: { timeoutMs: 100 },
      });
      await workflow.agents.open({ key: "investigator", runtime: "claude", keepAlive: {} });
      await workflow.receive();
      await agent.run({ prompt: "look" });
      for (;;) await workflow.receive();
    }),
    { ...startCase, agents: { investigator: answer("looked") } },
  );
  expect(run.ending.kind).toBe("parked");
  expect(said(run)).toEqual({ "keep-alive-timeout-ms": 1 });
});

test("a route's timeoutMs is its timeout, logged once; both at once are refused", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      const coordinator = await wf.participants.connect({ key: "coordinator" });
      await wf.messages.allow({ from: agent, to: coordinator, purpose: "ask", timeoutMs: 60_000 });
      const both = await wf.messages
        .allow({ from: agent, to: coordinator, purpose: "ask", timeout: "1m", timeoutMs: 60_000 })
        .then(
          () => "granted",
          (error: Error) => error.message,
        );
      // The same grant, in either form: granting it again must match.
      await wf.messages.allow({ from: agent, to: coordinator, purpose: "ask", timeout: "1m" });
      await coordinator.release("done");
      return both;
    }),
    null,
    { participants: { coordinator: () => undefined } },
  );
  expect(run.value).toContain("a route's timeout is given alone");
  expect(calls(run, "timeout-ms")).toEqual(["on a route"]);
});

test("a test's timeoutMs, stallMs and a send's timeoutMs work as their new forms do, each logged once", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const agent = await wf.agents.open({ key: "a", runtime: "claude" });
      const coordinator = await wf.participants.connect({ key: "coordinator" });
      await wf.messages.allow({ between: [agent, coordinator], purpose: "ask" });
      const { outcome } = await agent.run({ prompt: "Ask." });
      await coordinator.release("done");
      return [wf.deadline !== undefined, outcome.kind];
    }),
    null,
    {
      agents: {
        a: answer(async (turn) => {
          const sent = await turn.send("coordinator", "Which?", {
            awaitReply: true,
            timeoutMs: 60_000,
          });
          return sent.kind;
        }),
      },
      participants: {
        coordinator: (event) =>
          event.kind === "message" && event.asks ? event.reply("That one.") : undefined,
      },
      timeoutMs: 600_000,
      stallMs: 2_000,
    },
  );
  expect(run.value).toEqual([true, "answered"]);
  expect(calls(run, "timeout-ms")).toEqual(["in testWorkflow's options", "on a script's send"]);
  expect(said(run)).toEqual({ "timeout-ms": 2, "stall-ms": 1 });
});

test("a test's timeout and stall refuse their old forms beside them", async () => {
  const workflow = plain(async () => null);
  await expect(testWorkflow(workflow, null, { timeout: "1m", timeoutMs: 1 })).rejects.toThrow(
    "give timeout alone: timeoutMs is its deprecated form",
  );
  await expect(testWorkflow(workflow, null, { stall: "1s", stallMs: 1 })).rejects.toThrow(
    "give stall alone: stallMs is its deprecated form",
  );
});

test("a tool's timeout bounds each call as its timeoutMs did", async () => {
  const run = await testWorkflow(
    plain(async (wf) => {
      const hang = (bound: { timeout: "0.05s" } | { timeoutMs: number }) =>
        tool({
          description: "Hangs.",
          handler: (_input, call) =>
            new Promise((resolve) => call.signal.addEventListener("abort", () => resolve("x"))),
          ...bound,
        });
      const agent = await wf.agents.open({
        key: "a",
        runtime: "claude",
        tools: { slow: hang({ timeout: "0.05s" }), old: hang({ timeoutMs: 50 }) },
      });
      const { outcome } = await agent.run({ prompt: "Call both." });
      return outcome.answered ? outcome.value : outcome.kind;
    }),
    null,
    {
      agents: {
        a: answer(async (turn) => {
          const slow = await turn.tool("slow");
          const old = await turn.tool("old");
          return [slow, old].map((r) => ("error" in r ? r.error : r.kind)).join(" | ");
        }),
      },
    },
  );
  const late = (name: string) =>
    `${name} didn't answer in time (0.05 s); it may have run, so check before calling it again`;
  expect(run.value).toBe(`${late("slow")} | ${late("old")}`);
  expect(calls(run, "timeout-ms")).toEqual(["on a tool"]);
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
    null,
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
    null,
    { decisions: { ok: { ok: true } } },
  );
  expect(run.value).toEqual(["DeadlineExceededError", "DeadlineExceededError"]);
});
