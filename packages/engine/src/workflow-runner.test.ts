import { afterAll, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type {
  AgentRuntimeConfig,
  AgentSessionAdapter,
  HarnessOperationBinding,
  HarnessSession,
  HarnessTurn,
} from "@wf/harness/adapter";
import { createFakeAdapter } from "@wf/harness/testing";
import { createSingleSessionHostFactory } from "@wf/harness";
import type {
  JsonValue,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  OutputSchema,
  RunResult,
  WorkflowContext,
  WorkflowDefinition,
} from "@wf/contract/workflow";
import { DeadlineExceededError } from "@wf/contract/workflow";
import type { ResultSubmitResponse } from "@wf/contract/wire";
import { runWorkflow, startWorkflow, WorkflowCancelledError } from "./workflow-runner";
import { createTempRunDirs, future, submit } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

type Answer = { answer: string };

const ANSWER_SCHEMA: OutputSchema<Answer> = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

describe("runWorkflow", () => {
  test("a run handle exposes live peer state and stops through owned cleanup", async () => {
    let starts = 0;
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const adapter = createFakeAdapter({
      script: async (context) => {
        starts += 1;
        if (starts === 2) bothStarted();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {};
      },
    });
    const workflow = workflowOf("inspectable-run", async (context) => {
      const agents = await Promise.all(
        ["first", "second"].map((key) => openReviewer(context, key)),
      );
      await Promise.all(
        agents.map((agent, index) =>
          agent.run({ id: `turn-${index}`, prompt: "wait", deadline: future() }),
        ),
      );
      return null;
    });
    const handle = await startWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: future(),
    });
    await started;

    expect(handle.inspect()).toMatchObject({
      state: "running",
      agents: expect.arrayContaining([
        expect.objectContaining({ key: "first", state: "working" }),
        expect.objectContaining({ key: "second", state: "working" }),
      ]),
    });
    await handle.stop("operator stop");
    await expect(handle.result).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(handle.inspect().state).toBe("closed");
    expect(adapter.closed.sort()).toEqual(["first", "second"]);
  });

  test("a pre-aborted signal never enters the workflow", async () => {
    const controller = new AbortController();
    controller.abort("SIGINT");
    let entered = 0;
    const workflow = workflowOf("pre-aborted", async () => {
      entered += 1;
      return null;
    });

    await expect(
      runWorkflow(workflow, null, {
        runRoot: tempRunDir(),
        runtime: emptyRuntime(),
        deadline: future(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(entered).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("exposes and enforces the invocation deadline even without a workflow wait", async () => {
    const controller = new AbortController();
    const deadline = { unixMilliseconds: Date.now() + 20 };
    const workflow = workflowOf("run-deadline", async (context) => {
      expect(context.deadline).toEqual(deadline);
      expect(context.cwd).toBe("/repo");
      return await new Promise<never>(() => undefined);
    });

    await expect(
      runWorkflow(workflow, null, {
        runRoot: tempRunDir(),
        runtime: emptyRuntime(),
        deadline,
        cwd: "/repo",
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort("too late");
  });

  test("signal cancellation removes its listener and cancels the deadline timer", async () => {
    const controller = new AbortController();
    const deadline = { unixMilliseconds: Date.now() + 40 };
    const workflow = workflowOf("run-signal", async () => {
      return await new Promise<never>(() => undefined);
    });
    const running = runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      runtime: emptyRuntime(),
      deadline,
      signal: controller.signal,
    });
    controller.abort("SIGINT");

    await expect(running).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await Bun.sleep(50);
  });

  test("a host acquired after the run deadline is still closed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let closed = false;
    const runtime: AgentRuntimeConfig = {
      aliases: {},
      host: {
        async openRun() {
          await gate;
          return {
            openAgent: async () => {
              throw new Error("unused");
            },
            inspect: () => ({ state: "running" as const, agents: [] }),
            close: async () => {
              closed = true;
            },
          };
        },
      },
    };
    const workflow = workflowOf("late-host", async () => {
      return null;
    });
    const running = runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      runtime,
      deadline: { unixMilliseconds: Date.now() + 20 },
    });

    await expect(running).rejects.toBeInstanceOf(DeadlineExceededError);
    release();
    await Bun.sleep(0);
    expect(closed).toBe(true);
  });

  test("a synchronous host acquisition failure still closes the result endpoint", async () => {
    const runRoot = tempRunDir();
    const runtime: AgentRuntimeConfig = {
      aliases: {},
      host: {
        openRun() {
          throw new Error("host construction failed");
        },
      },
    };

    await expect(
      runWorkflow(
        workflowOf("sync-host-failure", async () => null),
        null,
        { runRoot, runtime, deadline: future() },
      ),
    ).rejects.toThrow("host construction failed");

    const [runId] = await readdir(runRoot);
    expect(runId).toBeDefined();
    expect((await readdir(join(runRoot, runId!))).some((name) => name.startsWith("wf-control-"))).toBe(false);
  });

  test("the run deadline cancels and closes an active turn with a later operation deadline", async () => {
    let nativeCancelled = 0;
    const adapter = createFakeAdapter({
      script: () => ({
        act: (context) =>
          new Promise<void>((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                nativeCancelled += 1;
                resolve();
              },
              { once: true },
            );
          }),
      }),
    });
    const workflow = workflowOf("active-run-deadline", async (context) => {
      const agent = await context.agents.open({
        key: "reviewer",
        deadline: future(1_000),
        runtime: "review",
      });
      await agent.run({ id: "wait", prompt: "Wait.", deadline: future(1_000) });
      return null;
    });
    const runRoot = tempRunDir();

    await expect(
      runWorkflow(workflow, null, {
        runRoot,
        runtime: runtime(adapter),
        deadline: { unixMilliseconds: Date.now() + 30 },
      }),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(nativeCancelled).toBe(1);
    expect(adapter.closed).toEqual(["reviewer"]);
    const [runId] = await readdir(runRoot);
    expect(runId).toBeDefined();
    expect((await readdir(join(runRoot, runId!))).some((name) => name.startsWith("wf-control-"))).toBe(false);
  });

  test("cleanup is bounded when activation and adapter close never settle", async () => {
    let closeStarted = 0;
    const base = createFakeAdapter({
      script: () => ({
        act: () => new Promise<void>(() => undefined),
      }),
    });
    const adapter: AgentSessionAdapter = {
      ...base,
      activate: async (request) => {
        if (request.key === "activating") {
          return await new Promise<HarnessSession>(() => undefined);
        }
        const session = await base.activate(request);
        session.close = async () => {
          closeStarted += 1;
          return await new Promise<void>(() => undefined);
        };
        return session;
      },
    };
    const workflow = workflowOf("bounded-cleanup", async (context) => {
      void context.agents
        .open({ key: "activating", deadline: future(), runtime: "review" })
        .catch(() => undefined);
      const active = await openReviewer(context, "active");
      await active.run({ id: "wait", prompt: "Wait.", deadline: future() });
      return null;
    });
    const startedAt = Date.now();
    const result = runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: { unixMilliseconds: Date.now() + 30 },
    });
    const error = await Promise.race([
      result.then(
        () => undefined,
        (reason: unknown) => reason,
      ),
      Bun.sleep(6_000).then(() => new Error("cleanup did not respect its shutdown grace")),
    ]);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[0]).toBeInstanceOf(DeadlineExceededError);
    expect(
      (error as AggregateError).errors.some(
        (item) => item instanceof Error && item.message.includes("agent cleanup exceeded 5000ms"),
      ),
    ).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(closeStarted).toBe(1);
  }, 6_500);

  test("runs a structured turn through a fake adapter and the real result endpoint", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "fake-native",
        nativeUsage: [{ inputTokens: 3, outputTokens: 2, costUsd: 0.01 }],
        act: async () => {
          expect(context.binding).toBeDefined();
          expect(context.prompt).toContain(
            `result ${context.binding!.operationId} '<json>'`,
          );
          await expect(submit(context.binding!, { answer: "ready" })).resolves.toMatchObject({
            kind: "accepted",
          });
        },
      }),
    });
    const workflow = workflowOf("one-turn", async (context) => {
      const agent = await openReviewer(context);
      const result = await agent.run({
        id: "review",
        prompt: "Review the fixture.",
        schema: ANSWER_SCHEMA,
        deadline: future(),
      });
      if (result.outcome.kind !== "answered") throw new Error(result.outcome.reason);
      return result.outcome.value;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
      cwd: "/repo",
    });

    expect(result.value).toEqual({ answer: "ready" });
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({
      agent: "reviewer",
      execution: { alias: "review", harness: "fake" },
      tokens: { input: 3, output: 2 },
      cost: { amount: 0.01, currency: "USD", basis: "charged" },
    });
    expect(adapter.closed).toEqual(["reviewer"]);
  });

  test("parallel preserves input order and cross-operation authority cannot settle", async () => {
    const bindings = new Map<string, HarnessOperationBinding>();
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const crossResponses: ResultSubmitResponse[] = [];
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const binding = context.binding!;
          bindings.set(context.activation.key, binding);
          if (bindings.size === 2) release();
          await bothStarted;
          const otherKey = context.activation.key === "slow" ? "fast" : "slow";
          const other = bindings.get(otherKey)!;
          crossResponses.push(
            await submit({ ...binding, operationId: other.operationId }, { answer: "wrong" }),
          );
          await submit(binding, { answer: context.activation.key });
          if (context.activation.key === "slow") await Bun.sleep(10);
        },
      }),
    });
    const workflow = workflowOf("parallel", async (context) => {
      return context.parallel(
        ["slow", "fast"],
        async (key) => {
          const agent = await openReviewer(context, key);
          const result = await agent.run({
            id: "answer",
            prompt: `Answer as ${key}.`,
            schema: ANSWER_SCHEMA,
            deadline: future(),
          });
          if (result.outcome.kind !== "answered") throw new Error(result.outcome.reason);
          return result.outcome.value.answer;
        },
        { deadline: future(), concurrency: 2 },
      );
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["slow", "fast"]);
    expect(crossResponses).toHaveLength(2);
    expect(crossResponses.every((response) => response.kind === "rejected")).toBe(true);
    expect(
      crossResponses.every(
        (response) => response.kind === "rejected" && response.code === "wrong-agent",
      ),
    ).toBe(true);
    expect(new Set(result.usage.map((usage) => usage.operationId)).size).toBe(2);
  });

  test("an operation timeout closes its session and endpoint", async () => {
    let endpoint = "";
    const adapter = createFakeAdapter({
      script: async (context) => {
        endpoint = context.binding!.endpoint;
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const workflow = workflowOf("timeout", async (context) => {
      const agent = await context.agents.open({
        key: "slow",
        runtime: "review",
      });
      const result = await agent.run({
        id: "slow",
        prompt: "Wait.",
        timeoutMs: 20,
      });
      return result.outcome.kind;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(adapter.closed).toEqual(["slow"]);
    await expect(connect(endpoint)).rejects.toBeDefined();
  });

  test("an accepted result cannot disable the native turn deadline", async () => {
    let operationSignal: AbortSignal | undefined;
    const adapter = createFakeAdapter({
      script: async (context) => {
        operationSignal = context.signal;
        await submit(context.binding!, "accepted-before-hang");
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {};
      },
    });
    const workflow = workflowOf("accepted-hang", async (context) => {
      const agent = await openReviewer(context, "hanging");
      const result = await agent.run({
        id: "hang",
        prompt: "Submit, then hang.",
        deadline: { unixMilliseconds: Date.now() + 20 },
      });
      return result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind;
    });

    const started = performance.now();
    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("accepted-before-hang");
    expect(performance.now() - started).toBeLessThan(200);
    expect(operationSignal?.aborted).toBe(true);
    expect(adapter.closed).toEqual(["hanging"]);
  });

  test("accepted-result quarantine prevents the logical queue from continuing", async () => {
    const fake = createFakeAdapter({
      script: async (context) => {
        await submit(context.binding!, "accepted");
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {};
      },
    });
    const adapter = adapterWith(fake, (session) => {
      let quarantined = false;
      return {
        start: starting(async (turn, binding) => {
          if (quarantined) throw new Error("harness session is quarantined");
          const native = await dispatch(session, turn, binding);
          return {
            ...native,
            async release() {
              quarantined = true;
              return { kind: "quarantined" as const, reason: "release unresolved" };
            },
          };
        }),
      };
    });
    const workflow = workflowOf("accepted-quarantine", async (context) => {
      const agent = await openReviewer(context);
      const first = await agent.run({ id: "one", prompt: "one", deadline: future() });
      const second = await agent.run({ id: "two", prompt: "two", deadline: future() }).then(
        (value) => value.outcome.kind,
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      return [first.outcome.kind, second];
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["answered", "logical agent is closed"]);
    expect(fake.turns).toHaveLength(1);
  });

  test("one agent serializes runs and the default nudge reuses its authority", async () => {
    let active = 0;
    let maximumActive = 0;
    const operationIds: string[] = [];
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          operationIds.push(context.binding!.operationId);
          await Bun.sleep(5);
          if (context.turn !== 1) {
            await submit(context.binding!, `answer-${context.turn}`);
          }
          active -= 1;
        },
      }),
    });
    const workflow = workflowOf("queue-and-nudge", async (context) => {
      const agent = await openReviewer(context);
      const first = agent.run({
        id: "first",
        prompt: "First.",
        deadline: future(),
      });
      const second = agent.run({ id: "second", prompt: "Second.", deadline: future() });
      const results = await Promise.all([first, second]);
      return results.map((result) =>
        result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind,
      );
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["answer-2", "answer-3"]);
    expect(maximumActive).toBe(1);
    expect(new Set(operationIds).size).toBe(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(operationIds[2]).not.toBe(operationIds[0]);
    expect(result.usage).toHaveLength(2);
    expect(adapter.turns.map((turn) => turn.kind)).toEqual(["turn", "nudge", "turn"]);
  });

  test("a run can disable the default nudge", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const workflow = workflowOf("no-nudge", async (context) => {
      const agent = await context.agents.open({ key: "reviewer", runtime: "review" });
      const result = await agent.run({ prompt: "Review.", nudge: false });
      return result.outcome.kind;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("unanswered");
    expect(adapter.turns.map((turn) => turn.kind)).toEqual(["turn"]);
  });

  test("an accepted result wins while native nudge acquisition is still pending", async () => {
    let closeNudge!: () => void;
    const nudgeClosed = new Promise<void>((resolve) => {
      closeNudge = resolve;
    });
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          async nudge() {
            await submit(binding, "accepted-during-nudge-start");
            await nudgeClosed;
            return native;
          },
        };
      }),
      async close(reason?: string) {
        closeNudge();
        await session.close(reason);
      },
    }));
    const workflow = workflowOf("pending-nudge", async (context) => {
      const agent = await openReviewer(context);
      const result = await agent.run({
        id: "review",
        prompt: "Review.",
        deadline: future(),
        nudge: { deadline: future() },
      });
      return result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("accepted-during-nudge-start");
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("an accepted result survives rejection of native turn acquisition", async () => {
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter = adapterWith(fake, () => ({
      start: starting(async (_turn, binding) => {
        await submit(binding, "accepted-before-start-rejection");
        throw new Error("native start rejected after dispatch");
      }),
    }));
    const workflow = workflowOf("accepted-start-rejection", async (context) => {
      const agent = await openReviewer(context);
      const result = await agent.run({ id: "review", prompt: "Review.", deadline: future() });
      return result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("accepted-before-start-rejection");
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("an unresolved accepted-result release closes the logical queue", async () => {
    const fake = createFakeAdapter({
      script: async (context) => {
        await submit(context.binding!, "accepted-before-stuck-release");
        return {};
      },
    });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return { ...native, release: () => new Promise(() => undefined) };
      }),
    }));
    const workflow = workflowOf("stuck-accepted-release", async (context) => {
      const agent = await openReviewer(context);
      const first = agent.run({ id: "first", prompt: "First.", deadline: future() });
      const second = agent.run({ id: "second", prompt: "Do not dispatch.", deadline: future() });
      return outcomesOf([first, second]);
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["answered", "logical agent is closed"]);
    expect(fake.turns).toHaveLength(1);
    expect(fake.closed).toEqual(["reviewer"]);
  }, 6_500);

  test("an agent keeps its first alias resolution and turn ids are idempotent", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          await submit(context.binding!, "stable");
        },
      }),
    });
    const configured = runtime(adapter);
    const workflow = workflowOf("identity", async (context) => {
      const agent = await openReviewer(context);
      (configured.aliases as Record<string, { model: string }>).review!.model = "changed";
      const reopened = await openReviewer(context);
      const deadline = future();
      const spec = { id: "stable", prompt: "Answer.", deadline };
      const first = agent.run(spec);
      const duplicate = agent.run(spec);
      let conflict = false;
      try {
        await agent.run({ ...spec, prompt: "Different." });
      } catch {
        conflict = true;
      }
      await first;
      return { sameAgent: agent === reopened, sameTurn: first === duplicate, conflict };
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: configured,
    });

    expect(result.value).toEqual({ sameAgent: true, sameTurn: true, conflict: true });
    expect(adapter.turns).toHaveLength(1);
    expect(result.usage).toHaveLength(1);
  });

  test("reattaching to a pending agent honors the new caller's shorter deadline", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        await gate;
        return fake.activate(request);
      },
    };
    const workflow = workflowOf("reattach-deadline", async (context) => {
      const first = openReviewer(context);
      try {
        await context.agents.open({
          key: "reviewer",
          deadline: { unixMilliseconds: Date.now() + 20 },
          runtime: "review",
        });
        return "unexpected";
      } catch (error) {
        release();
        await first;
        return error instanceof Error && "code" in error ? String(error.code) : "wrong-error";
      }
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("deadline-exceeded");
    expect(fake.activations).toHaveLength(1);
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("a pending reattachment is bounded by its enclosing parallel deadline", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        await gate;
        return fake.activate(request);
      },
    };
    const workflow = workflowOf("scoped-reattach", async (context) => {
      const first = openReviewer(context);
      try {
        await context.parallel(
          [null],
          async () => {
            await openReviewer(context);
          },
          { deadline: { unixMilliseconds: Date.now() + 20 } },
        );
        return "unexpected";
      } catch (error) {
        release();
        await first;
        return error instanceof Error && "code" in error ? String(error.code) : "wrong-error";
      }
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("deadline-exceeded");
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("a parallel deadline owns pending native turn acquisition", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquiredAfterScope = 0;
    let observedTurnDeadline = 0;
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        observedTurnDeadline = turn.deadline.unixMilliseconds;
        await gate;
        const native = await dispatch(session, turn, binding);
        acquiredAfterScope += 1;
        return native;
      }),
    }));
    const workflow = workflowOf("scoped-start", async (context) => {
      const agent = await openReviewer(context);
      const scopeDeadline = { unixMilliseconds: Date.now() + 20 };
      const outcome = await context.parallel(
        [null],
        async () => {
          const result = await agent.run({
            id: "pending",
            prompt: "Wait.",
            deadline: future(),
          });
          return result.outcome.kind;
        },
        { deadline: scopeDeadline },
      ).then(
        (values) => values[0]!,
        (error: unknown) => error instanceof Error && "code" in error
          ? String(error.code)
          : "wrong-error",
      );
      expect(observedTurnDeadline).toBe(scopeDeadline.unixMilliseconds);
      release();
      await Bun.sleep(0);
      return outcome;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(["timed-out", "deadline-exceeded"]).toContain(result.value);
    expect(acquiredAfterScope).toBe(0);
    expect(fake.turns).toHaveLength(0);
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("a nudge acquired after its parallel deadline is released exactly once", async () => {
    let releaseNudge!: () => void;
    const nudgeGate = new Promise<void>((resolve) => {
      releaseNudge = resolve;
    });
    let lateReleases = 0;
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          async nudge() {
            await nudgeGate;
            return {
              ...native,
              async release() {
                lateReleases += 1;
                return { kind: "quarantined" as const, reason: "late nudge" };
              },
            };
          },
        };
      }),
    }));
    const workflow = workflowOf("late-nudge", async (context) => {
      const agent = await openReviewer(context);
      const outcome = await context.parallel(
        [null],
        async () => {
          const result = await agent.run({
            id: "review",
            prompt: "Review.",
            deadline: future(),
            nudge: { deadline: future() },
          });
          return result.outcome.kind;
        },
        { deadline: { unixMilliseconds: Date.now() + 20 } },
      ).then(
        (values) => values[0]!,
        (error: unknown) => error instanceof Error && "code" in error
          ? String(error.code)
          : "wrong-error",
      );
      releaseNudge();
      return outcome;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(["timed-out", "deadline-exceeded"]).toContain(result.value);
    expect(lateReleases).toBe(1);
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("a parallel deadline cancels owned turns before rejecting and cleanup closes them", async () => {
    const adapter = createFakeAdapter({
      script: async (context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const workflow = workflowOf("parallel-timeout", async (context) => {
      await context.parallel(
        ["one", "two"],
        async (key) => {
          const agent = await openReviewer(context, key);
          await agent.run({ id: "wait", prompt: "Wait.", deadline: future() });
        },
        { deadline: { unixMilliseconds: Date.now() + 20 }, concurrency: 2 },
      );
      return null;
    });

    await expect(
      runWorkflow(workflow, null, { runRoot: tempRunDir(), runtime: runtime(adapter), deadline: future() }),
    ).rejects.toMatchObject({ code: "deadline-exceeded" });
    expect(adapter.closed.sort()).toEqual(["one", "two"]);
    expect(adapter.turns.every((turn) => turn.signal.aborted)).toBe(true);
  });

  test("a parallel deadline rejects even when a callback cannot cooperate", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const workflow = workflowOf("non-cooperative", async (context) => {
      await context.parallel(
        [null],
        () => new Promise<never>(() => undefined),
        { deadline: { unixMilliseconds: Date.now() + 20 } },
      );
      return null;
    });

    await expect(
      runWorkflow(workflow, null, { runRoot: tempRunDir(), runtime: runtime(adapter), deadline: future() }),
    ).rejects.toMatchObject({ code: "deadline-exceeded" });
  });

  test("parallel waits for fire-and-forget agent work and bounds it with the same scope", async () => {
    let signal: AbortSignal | undefined;
    const adapter = createFakeAdapter({
      script: async (context) => {
        signal = context.signal;
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const workflow = workflowOf("owned-work", async (context) => {
      await context.parallel(
        [null],
        async () => {
          const agent = await openReviewer(context, "owned");
          void agent.run({ id: "owned", prompt: "Wait.", deadline: future() });
        },
        { deadline: { unixMilliseconds: Date.now() + 20 } },
      );
      return null;
    });

    await expect(
      runWorkflow(workflow, null, { runRoot: tempRunDir(), runtime: runtime(adapter), deadline: future() }),
    ).rejects.toMatchObject({ code: "deadline-exceeded" });
    expect(signal?.aborted).toBe(true);
    expect(adapter.closed).toEqual(["owned"]);
  });

  test("parallel retains an early rejected owned run until the scope settles", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          await submit(context.binding!, "first");
        },
      }),
    });
    const workflow = workflowOf("owned-rejection", async (context) => {
      await context.parallel(
        [null],
        async () => {
          const agent = await openReviewer(context, "owned-rejection");
          const first = agent.run({
            id: "same-id",
            prompt: "First specification.",
            deadline: future(),
          });
          void agent.run({
            id: "same-id",
            prompt: "Different specification.",
            deadline: future(),
          });
          await first;
        },
        { deadline: future() },
      );
      return null;
    });

    await expect(
      runWorkflow(workflow, null, { runRoot: tempRunDir(), runtime: runtime(adapter), deadline: future() }),
    ).rejects.toThrow("turn id same-id was reused with a different specification");
    expect(adapter.turns).toHaveLength(1);
  });

  test("parallel owns fire-and-forget agent activation", async () => {
    let activated = false;
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        await Bun.sleep(20);
        const session = await fake.activate(request);
        activated = true;
        return session;
      },
    };
    const workflow = workflowOf("owned-activation", async (context) => {
      await context.parallel(
        [null],
        async () => {
          void openReviewer(context, "activating");
        },
        { deadline: future() },
      );
      return activated;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe(true);
    expect(fake.closed).toEqual(["activating"]);
  });

  test("a detached descendant cannot dispatch after its parallel scope succeeds", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late!: Promise<string>;
    const adapter = createFakeAdapter({ script: () => ({}) });
    const workflow = workflowOf("sealed-scope", async (context) => {
      await context.parallel(
        [null],
        async () => {
          const agent = await openReviewer(context, "sealed");
          late = (async () => {
            await gate;
            try {
              await agent.run({ id: "late", prompt: "Too late.", deadline: future() });
              return "dispatched";
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          })();
        },
        { deadline: future() },
      );
      release();
      return late;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("parallel execution scope is closed");
    expect(adapter.turns).toHaveLength(0);
  });

  test("parallel owns a fire-and-forget nested parallel", async () => {
    let nestedFinished = false;
    const workflow = workflowOf("owned-nested", async (context) => {
      await context.parallel(
        [null],
        async () => {
          void context.parallel(
            [null],
            async () => {
              await Bun.sleep(20);
              nestedFinished = true;
            },
            { deadline: future() },
          );
        },
        { deadline: future() },
      );
      return nestedFinished;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(createFakeAdapter({ script: () => ({}) })),
    });

    expect(result.value).toBe(true);
  });

  test("a detached descendant cannot start nested parallel after its parent succeeds", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let nestedRan = false;
    let late!: Promise<string>;
    const workflow = workflowOf("sealed-nested", async (context) => {
      await context.parallel(
        [null],
        async () => {
          late = (async () => {
            await gate;
            try {
              await context.parallel(
                [null],
                async () => {
                  nestedRan = true;
                },
                { deadline: future() },
              );
              return "dispatched";
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          })();
        },
        { deadline: future() },
      );
      release();
      return late;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(createFakeAdapter({ script: () => ({}) })),
    });

    expect(result.value).toBe("parallel execution scope is closed");
    expect(nestedRan).toBe(false);
  });

  test("deadline expiry while native start is pending resolves as timed-out", async () => {
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        await Bun.sleep(20);
        return dispatch(session, turn, binding);
      }),
    }));
    const workflow = workflowOf("start-deadline", async (context) => {
      const agent = await openReviewer(context, "starting");
      const result = await agent.run({
        id: "starting",
        prompt: "Start slowly.",
        deadline: { unixMilliseconds: Date.now() + 10 },
      });
      return result.outcome.kind;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(fake.closed).toEqual(["starting"]);
  });

  test("a rejecting native cancel cannot replace a timed-out outcome", async () => {
    const fake = createFakeAdapter({
      script: async (context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          async release() {
            throw new Error(`cancel failed ${binding.operationId}`);
          },
        };
      }),
    }));
    const workflow = workflowOf("cancel-rejection", async (context) => {
      const agent = await openReviewer(context, "rejecting-cancel");
      const result = await agent.run({
        id: "wait",
        prompt: "Wait.",
        deadline: { unixMilliseconds: Date.now() + 20 },
      });
      return result.outcome.kind;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(JSON.stringify(result)).not.toContain("cancel failed");
    expect(fake.closed).toEqual(["rejecting-cancel"]);
  });

  test("a never-settling native release cannot block beyond cleanup grace", async () => {
    const fake = createFakeAdapter({
      script: async (context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          release: () => new Promise(() => undefined),
        };
      }),
    }));
    const workflow = workflowOf("stuck-cancel", async (context) => {
      const agent = await openReviewer(context, "stuck-cancel");
      const result = await agent.run({
        id: "wait",
        prompt: "Wait.",
        deadline: { unixMilliseconds: Date.now() + 20 },
      });
      return result.outcome.kind;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(fake.closed).toEqual(["stuck-cancel"]);
  }, 8_000);

  test("an indeterminate timed-out session is terminalized before its queue advances", async () => {
    const fake = createFakeAdapter({
      script: async (context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          release: async () => ({ kind: "quarantined", reason: "release unresolved" }),
        };
      }),
    }));
    const workflow = workflowOf("terminal-timeout", async (context) => {
      const agent = await openReviewer(context, "terminal");
      const first = agent.run({
        id: "first",
        prompt: "Wait.",
        deadline: { unixMilliseconds: Date.now() + 20 },
      });
      const second = agent.run({ id: "second", prompt: "Do not dispatch.", deadline: future() });
      return outcomesOf([first, second]);
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["timed-out", "logical agent is closed"]);
    expect(fake.turns).toHaveLength(1);
    expect(fake.closed).toEqual(["terminal"]);
  });

  test("a native timed-out outcome terminalizes the session before its queue advances", async () => {
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          settled: Promise.resolve({
            state: "timed-out" as const,
            detail: "native deadline",
            resultEvidence: { kind: "unavailable" as const },
            nativeUsage: [],
          }),
        };
      }),
    }));
    const workflow = workflowOf("native-timeout", async (context) => {
      const agent = await openReviewer(context, "terminal");
      const first = agent.run({ id: "first", prompt: "First.", deadline: future() });
      const second = agent.run({ id: "second", prompt: "Do not dispatch.", deadline: future() });
      return outcomesOf([first, second]);
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["timed-out", "logical agent is closed"]);
    expect(fake.turns).toHaveLength(1);
    expect(fake.closed).toEqual(["terminal"]);
  });

  test("an accepted result does not make an indeterminate native timeout reusable", async () => {
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        await submit(binding, "accepted-at-native-timeout");
        return {
          ...native,
          settled: Promise.resolve({
            state: "timed-out" as const,
            detail: "native deadline",
            resultEvidence: { kind: "unavailable" as const },
            nativeUsage: [],
          }),
          release: async () => ({
            kind: "quarantined" as const,
            reason: "native completion is indeterminate",
          }),
        };
      }),
    }));
    const workflow = workflowOf("accepted-native-timeout", async (context) => {
      const agent = await openReviewer(context, "terminal");
      const first = agent.run({ id: "first", prompt: "First.", deadline: future() });
      const second = agent.run({ id: "second", prompt: "Do not dispatch.", deadline: future() });
      return outcomesOf([first, second]);
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["answered", "logical agent is closed"]);
    expect(fake.turns).toHaveLength(1);
    expect(fake.closed).toEqual(["terminal"]);
  });

  test("owner cleanup retries a failed timeout-terminalization close", async () => {
    let closeAttempts = 0;
    const fake = createFakeAdapter({
      script: async (context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          release: async () => ({ kind: "quarantined", reason: "release unresolved" }),
        };
      }),
      async close(reason?: string) {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          await Bun.sleep(10);
          throw new Error("transient close failure");
        }
        await session.close(reason);
      },
    }));
    const workflow = workflowOf("retry-close", async (context) => {
      const agent = await openReviewer(context, "retry-close");
      const result = await agent.run({
        id: "wait",
        prompt: "Wait.",
        deadline: { unixMilliseconds: Date.now() + 20 },
      });
      return result.outcome.kind;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(closeAttempts).toBe(2);
    expect(fake.closed).toEqual(["retry-close"]);
  });

  test("parallel cancellation is requested before the deadline is observed", async () => {
    let cancellationObserved = false;
    const fake = createFakeAdapter({
      script: async (context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          release(reason: string, deadline: { unixMilliseconds: number }) {
            cancellationObserved = true;
            return native.release(reason, deadline);
          },
        };
      }),
      async close(reason?: string) {
        cancellationObserved = true;
        await session.close(reason);
      },
    }));
    const workflow = workflowOf("cancel-order", async (context) => {
      try {
        await context.parallel(
          [null],
          async () => {
            const agent = await openReviewer(context, "cancel-order");
            await agent.run({ id: "wait", prompt: "Wait.", deadline: future() });
          },
          { deadline: { unixMilliseconds: Date.now() + 20 } },
        );
      } catch {
        return cancellationObserved;
      }
      return false;
    });

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe(true);
  });

  test("shutdown does not dispatch an already queued fire-and-forget run", async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const adapter = createFakeAdapter({
      script: async (context) => {
        began();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const workflow = workflowOf("queued-shutdown", async (context) => {
      const agent = await openReviewer(context, "queued");
      void agent.run({ id: "first", prompt: "Wait.", deadline: future() });
      void agent.run({ id: "second", prompt: "Never dispatch.", deadline: future() });
      await started;
      return null;
    });
    const runRoot = tempRunDir();

    const result = await runWorkflow(workflow, null, {
      runRoot,
      runtime: runtime(adapter),
      deadline: future(),
    });

    expect(adapter.turns).toHaveLength(1);
    expect(await readdir(join(runRoot, result.runId, "calls"))).toHaveLength(1);
  });

  test("adapter activation failure still closes earlier sessions and the endpoint", async () => {
    let endpoint = "";
    const fake = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          endpoint = context.binding!.endpoint;
          await submit(context.binding!, "done");
        },
      }),
    });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        if (request.key === "broken") throw new Error("activation failed");
        return fake.activate(request);
      },
    };
    const workflow = workflowOf("activation-failure", async (context) => {
      const good = await openReviewer(context, "good");
      await good.run({ id: "good", prompt: "Finish.", deadline: future() });
      await openReviewer(context, "broken");
      return null;
    });

    await expect(
      runWorkflow(workflow, null, { runRoot: tempRunDir(), runtime: runtime(adapter), deadline: future() }),
    ).rejects.toThrow("activation failed");
    expect(fake.closed).toEqual(["good"]);
    await expect(connect(endpoint)).rejects.toBeDefined();
  });

  test("owner cleanup drains a rejected fire-and-forget activation", async () => {
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        await Bun.sleep(10);
        throw new Error(`activation failed for ${request.key}`);
      },
    };
    const workflow = workflowOf("detached-activation", async (context) => {
      void openReviewer(context, "detached");
      return null;
    });
    const started = performance.now();

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(8);
  });
});

function runtime(adapter: AgentSessionAdapter): AgentRuntimeConfig {
  return {
    aliases: {
      review: { harness: "fake", model: "fake" },
    },
    host: createSingleSessionHostFactory(adapter),
  };
}

function emptyRuntime(): AgentRuntimeConfig {
  return {
    aliases: {},
    host: createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) })),
  };
}

function connect(endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function dispatch(
  session: HarnessSession,
  turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
  binding: HarnessOperationBinding,
) {
  return turn.schema
    ? session.start(turn as AgentStructuredTurnSpec<JsonValue>, binding)
    : session.start(turn as AgentTextTurnSpec, binding);
}

/** A fake with some of each session's surface replaced; `session` is the one being wrapped. */
function adapterWith(
  fake: AgentSessionAdapter,
  extend: (session: HarnessSession) => Partial<HarnessSession>,
): AgentSessionAdapter {
  return {
    ...fake,
    async activate(request) {
      const session = await fake.activate(request);
      return { ...session, ...extend(session) };
    },
  };
}

/** `start` is overloaded on the turn's schema, and a single implementation cannot say so. */
function starting(
  begin: (
    turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
    binding: HarnessOperationBinding,
  ) => Promise<HarnessTurn>,
): HarnessSession["start"] {
  return begin as HarnessSession["start"];
}

function workflowOf<Result extends JsonValue>(
  name: string,
  run: (context: WorkflowContext) => Promise<Result>,
): WorkflowDefinition<null, Result> {
  return { meta: { name, description: name }, run };
}

function openReviewer(context: WorkflowContext, key = "reviewer") {
  return context.agents.open({ key, deadline: future(), runtime: "review" });
}

/** What each run said, with a rejection standing in for its outcome kind. */
async function outcomesOf(runs: readonly Promise<RunResult<JsonValue>>[]): Promise<string[]> {
  const settled = await Promise.allSettled(runs);
  return settled.map((item) =>
    item.status === "fulfilled"
      ? item.value.outcome.kind
      : item.reason instanceof Error
        ? item.reason.message
        : String(item.reason),
  );
}
