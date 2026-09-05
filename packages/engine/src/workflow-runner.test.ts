import { afterAll, describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type {
  AgentSessionAdapter,
  HarnessOperationBinding,
  HarnessSession,
} from "@wf/harness/adapter";
import { createFakeAdapter } from "@wf/harness/testing";
import { createSingleSessionHostFactory } from "@wf/harness";
import type {
  AgentRuntimeConfig,
} from "@wf/harness/adapter";
import type {
  JsonObject,
  JsonValue,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  OutputSchema,
  WorkflowDefinition,
} from "@wf/contract/workflow";
import { DeadlineExceededError } from "@wf/contract/workflow";
import { WIRE_VERSION, type ResultSubmitResponse } from "@wf/contract/wire";
import { runWorkflow, startWorkflow, WorkflowCancelledError } from "./workflow-runner";
import { createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

type Answer = { answer: string };

const ANSWER_SCHEMA: OutputSchema<Answer> = {
  jsonSchema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "inspectable-run", description: "live handle state" },
      async run(context) {
        const agents = await Promise.all(
          ["first", "second"].map((key) =>
            context.agents.open({ key, deadline: future(), runtime: "review" }),
          ),
        );
        await Promise.all(
          agents.map((agent, index) =>
            agent.run({ id: `turn-${index}`, prompt: "wait", deadline: future() }),
          ),
        );
        return null;
      },
    };
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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "pre-aborted", description: "cancel before workflow entry" },
      async run() {
        entered += 1;
        return null;
      },
    };

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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "run-deadline", description: "top-level deadline" },
      async run(context) {
        expect(context.deadline).toEqual(deadline);
        expect(context.cwd).toBe("/repo");
        return await new Promise<never>(() => undefined);
      },
    };

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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "run-signal", description: "top-level signal" },
      async run() {
        return await new Promise<never>(() => undefined);
      },
    };
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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "late-host", description: "late host cleanup" },
      async run() {
        return null;
      },
    };
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
        {
          meta: { name: "sync-host-failure", description: "owned acquisition failure" },
          async run() {
            return null;
          },
        },
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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "active-run-deadline", description: "deadline cleanup" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(1_000),
          runtime: "review",
        });
        await agent.run({ id: "wait", prompt: "Wait.", deadline: future(1_000) });
        return null;
      },
    };
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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "bounded-cleanup", description: "bounded broken adapter cleanup" },
      async run(context) {
        void context.agents
          .open({ key: "activating", deadline: future(), runtime: "review" })
          .catch(() => undefined);
        const active = await context.agents.open({
          key: "active",
          deadline: future(),
          runtime: "review",
        });
        await active.run({ id: "wait", prompt: "Wait.", deadline: future() });
        return null;
      },
    };
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
          expect(context.prompt).toContain("wf result '<json>'");
          expect(context.prompt).not.toContain(context.binding!.operationId);
          expect(context.prompt).not.toContain(context.binding!.capability);
          await expect(submit(context.binding!, { answer: "ready" })).resolves.toMatchObject({
            kind: "accepted",
          });
        },
      }),
    });
    const workflow: WorkflowDefinition<null, Answer> = {
      meta: { name: "one-turn", description: "one structured fake turn" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({
          id: "review",
          prompt: "Review the fixture.",
          schema: ANSWER_SCHEMA,
          deadline: future(),
        });
        if (result.outcome.kind !== "answered") throw new Error(result.outcome.reason);
        return result.outcome.value;
      },
    };

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
            await submit({ ...binding, capability: other.capability }, { answer: "wrong" }),
          );
          await submit(binding, { answer: context.activation.key });
          if (context.activation.key === "slow") await Bun.sleep(10);
        },
      }),
    });
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "parallel", description: "parallel ordering" },
      async run(context) {
        return context.parallel(
          ["slow", "fast"],
          async (key) => {
            const agent = await context.agents.open({ key, deadline: future(), runtime: "review" });
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
      },
    };

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
        (response) => response.kind === "rejected" && response.code === "wrong-operation",
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
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "timeout", description: "bounded fake turn" },
      async run(context) {
        const agent = await context.agents.open({
          key: "slow",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({
          id: "slow",
          prompt: "Wait.",
          deadline: { unixMilliseconds: Date.now() + 20 },
        });
        return result.outcome.kind;
      },
    };

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
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "accepted-hang", description: "accepted result with hanging native turn" },
      async run(context) {
        const agent = await context.agents.open({
          key: "hanging",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({
          id: "hang",
          prompt: "Submit, then hang.",
          deadline: { unixMilliseconds: Date.now() + 20 },
        });
        return result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind;
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        let quarantined = false;
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            if (quarantined) throw new Error("harness session is quarantined");
            const native = await dispatch(session, turn, binding);
            return {
              ...native,
              async release() {
                quarantined = true;
                return { kind: "quarantined" as const, reason: "release unresolved" };
              },
            };
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "accepted-quarantine", description: "queue stops after quarantine" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
        const first = await agent.run({ id: "one", prompt: "one", deadline: future() });
        const second = await agent.run({ id: "two", prompt: "two", deadline: future() }).then(
          (value) => value.outcome.kind,
          (error: unknown) => error instanceof Error ? error.message : String(error),
        );
        return [first.outcome.kind, second];
      },
    };

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["answered", "logical agent is closed"]);
    expect(fake.turns).toHaveLength(1);
  });

  test("one agent serializes runs and a configured nudge reuses its authority", async () => {
    let active = 0;
    let maximumActive = 0;
    const capabilities: string[] = [];
    const operationIds: string[] = [];
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          capabilities.push(context.binding!.capability);
          operationIds.push(context.binding!.operationId);
          await Bun.sleep(5);
          if (context.turn !== 1) {
            await submit(context.binding!, `answer-${context.turn}`);
          }
          active -= 1;
        },
      }),
    });
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "queue-and-nudge", description: "serialized logical agent" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
        const first = agent.run({
          id: "first",
          prompt: "First.",
          deadline: future(),
          nudge: { deadline: future() },
        });
        const second = agent.run({ id: "second", prompt: "Second.", deadline: future() });
        const results = await Promise.all([first, second]);
        return results.map((result) =>
          result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind,
        );
      },
    };

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["answer-2", "answer-3"]);
    expect(maximumActive).toBe(1);
    expect(new Set(capabilities).size).toBe(2);
    expect(capabilities[1]).toBe(capabilities[0]);
    expect(capabilities[2]).not.toBe(capabilities[0]);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(operationIds[2]).not.toBe(operationIds[0]);
    expect(result.usage).toHaveLength(2);
    expect(adapter.turns.map((turn) => turn.kind)).toEqual(["turn", "nudge", "turn"]);
  });

  test("an accepted result wins while native nudge acquisition is still pending", async () => {
    let closeNudge!: () => void;
    const nudgeClosed = new Promise<void>((resolve) => {
      closeNudge = resolve;
    });
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            const native = await dispatch(session, turn, binding);
            return {
              ...native,
              async nudge() {
                await submit(binding, "accepted-during-nudge-start");
                await nudgeClosed;
                return native;
              },
            };
          }) as HarnessSession["start"],
          async close(reason?: string) {
            closeNudge();
            await session.close(reason);
          },
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "pending-nudge", description: "result races native nudge acquisition" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({
          id: "review",
          prompt: "Review.",
          deadline: future(),
          nudge: { deadline: future() },
        });
        return result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind;
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            _turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            await submit(binding, "accepted-before-start-rejection");
            throw new Error("native start rejected after dispatch");
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "accepted-start-rejection", description: "accepted data wins join" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({ id: "review", prompt: "Review.", deadline: future() });
        return result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind;
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            const native = await dispatch(session, turn, binding);
            return { ...native, release: () => new Promise(() => undefined) };
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "stuck-accepted-release", description: "unresolved release closes queue" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
        const first = agent.run({ id: "first", prompt: "First.", deadline: future() });
        const second = agent.run({ id: "second", prompt: "Do not dispatch.", deadline: future() });
        const settled = await Promise.allSettled([first, second]);
        return settled.map((item) =>
          item.status === "fulfilled"
            ? item.value.outcome.kind
            : item.reason instanceof Error
              ? item.reason.message
              : String(item.reason),
        );
      },
    };

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
    const workflow: WorkflowDefinition<null, { sameAgent: boolean; sameTurn: boolean; conflict: boolean }> = {
      meta: { name: "identity", description: "logical identity and idempotency" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
        (configured.aliases as Record<string, { model: string }>).review!.model = "changed";
        const reopened = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
          lifecycle: { retention: { kind: "workflow" } },
        });
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
      },
    };

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
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "reattach-deadline", description: "bounded reattachment" },
      async run(context) {
        const first = context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
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
      },
    };

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
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "scoped-reattach", description: "parallel bounds shared activation waits" },
      async run(context) {
        const first = context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
        try {
          await context.parallel(
            [null],
            async () => {
              await context.agents.open({
                key: "reviewer",
                deadline: future(),
                runtime: "review",
              });
            },
            { deadline: { unixMilliseconds: Date.now() + 20 } },
          );
          return "unexpected";
        } catch (error) {
          release();
          await first;
          return error instanceof Error && "code" in error ? String(error.code) : "wrong-error";
        }
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            observedTurnDeadline = turn.deadline.unixMilliseconds;
            await gate;
            const native = await dispatch(session, turn, binding);
            acquiredAfterScope += 1;
            return native;
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "scoped-start", description: "parallel owns turn acquisition" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
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
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
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
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "late-nudge", description: "one release for late nudge acquisition" },
      async run(context) {
        const agent = await context.agents.open({
          key: "reviewer",
          deadline: future(),
          runtime: "review",
        });
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
      },
    };

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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "parallel-timeout", description: "parallel cancellation" },
      async run(context) {
        await context.parallel(
          ["one", "two"],
          async (key) => {
            const agent = await context.agents.open({ key, deadline: future(), runtime: "review" });
            await agent.run({ id: "wait", prompt: "Wait.", deadline: future() });
          },
          { deadline: { unixMilliseconds: Date.now() + 20 }, concurrency: 2 },
        );
        return null;
      },
    };

    await expect(
      runWorkflow(workflow, null, { runRoot: tempRunDir(), runtime: runtime(adapter), deadline: future() }),
    ).rejects.toMatchObject({ code: "deadline-exceeded" });
    expect(adapter.closed.sort()).toEqual(["one", "two"]);
    expect(adapter.turns.every((turn) => turn.signal.aborted)).toBe(true);
  });

  test("a parallel deadline rejects even when a callback cannot cooperate", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "non-cooperative", description: "bounded collection" },
      async run(context) {
        await context.parallel(
          [null],
          () => new Promise<never>(() => undefined),
          { deadline: { unixMilliseconds: Date.now() + 20 } },
        );
        return null;
      },
    };

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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "owned-work", description: "parallel-owned unawaited agent work" },
      async run(context) {
        await context.parallel(
          [null],
          async () => {
            const agent = await context.agents.open({
              key: "owned",
              deadline: future(),
              runtime: "review",
            });
            void agent.run({ id: "owned", prompt: "Wait.", deadline: future() });
          },
          { deadline: { unixMilliseconds: Date.now() + 20 } },
        );
        return null;
      },
    };

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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "owned-rejection", description: "retained owned failures" },
      async run(context) {
        await context.parallel(
          [null],
          async () => {
            const agent = await context.agents.open({
              key: "owned-rejection",
              deadline: future(),
              runtime: "review",
            });
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
      },
    };

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
    const workflow: WorkflowDefinition<null, boolean> = {
      meta: { name: "owned-activation", description: "parallel-owned activation" },
      async run(context) {
        await context.parallel(
          [null],
          async () => {
            void context.agents.open({
              key: "activating",
              deadline: future(),
              runtime: "review",
            });
          },
          { deadline: future() },
        );
        return activated;
      },
    };

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
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "sealed-scope", description: "no late scoped operations" },
      async run(context) {
        await context.parallel(
          [null],
          async () => {
            const agent = await context.agents.open({
              key: "sealed",
              deadline: future(),
              runtime: "review",
            });
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
      },
    };

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
    const workflow: WorkflowDefinition<null, boolean> = {
      meta: { name: "owned-nested", description: "structured nested parallel" },
      async run(context) {
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
      },
    };

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
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "sealed-nested", description: "no late nested parallel" },
      async run(context) {
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
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            await Bun.sleep(20);
            return dispatch(session, turn, binding);
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "start-deadline", description: "deadline during native start" },
      async run(context) {
        const agent = await context.agents.open({
          key: "starting",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({
          id: "starting",
          prompt: "Start slowly.",
          deadline: { unixMilliseconds: Date.now() + 10 },
        });
        return result.outcome.kind;
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            const native = await dispatch(session, turn, binding);
            return {
              ...native,
              async release() {
                throw new Error(`cancel failed ${binding.capability}`);
              },
            };
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "cancel-rejection", description: "timeout dominates cancel failure" },
      async run(context) {
        const agent = await context.agents.open({
          key: "rejecting-cancel",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({
          id: "wait",
          prompt: "Wait.",
          deadline: { unixMilliseconds: Date.now() + 20 },
        });
        return result.outcome.kind;
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            const native = await dispatch(session, turn, binding);
            return {
              ...native,
              release: () => new Promise(() => undefined),
            };
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "stuck-cancel", description: "timeout does not await cancellation" },
      async run(context) {
        const agent = await context.agents.open({
          key: "stuck-cancel",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({
          id: "wait",
          prompt: "Wait.",
          deadline: { unixMilliseconds: Date.now() + 20 },
        });
        return result.outcome.kind;
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            const native = await dispatch(session, turn, binding);
            return {
              ...native,
              release: async () => ({ kind: "quarantined", reason: "release unresolved" }),
            };
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "terminal-timeout", description: "no reuse after indeterminate timeout" },
      async run(context) {
        const agent = await context.agents.open({
          key: "terminal",
          deadline: future(),
          runtime: "review",
        });
        const first = agent.run({
          id: "first",
          prompt: "Wait.",
          deadline: { unixMilliseconds: Date.now() + 20 },
        });
        const second = agent.run({ id: "second", prompt: "Do not dispatch.", deadline: future() });
        const settled = await Promise.allSettled([first, second]);
        return settled.map((item) =>
          item.status === "fulfilled"
            ? item.value.outcome.kind
            : item.reason instanceof Error
              ? item.reason.message
              : String(item.reason),
        );
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
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
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "native-timeout", description: "native terminal state closes queue" },
      async run(context) {
        const agent = await context.agents.open({
          key: "terminal",
          deadline: future(),
          runtime: "review",
        });
        const first = agent.run({ id: "first", prompt: "First.", deadline: future() });
        const second = agent.run({ id: "second", prompt: "Do not dispatch.", deadline: future() });
        const settled = await Promise.allSettled([first, second]);
        return settled.map((item) =>
          item.status === "fulfilled"
            ? item.value.outcome.kind
            : item.reason instanceof Error
              ? item.reason.message
              : String(item.reason),
        );
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
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
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string[]> = {
      meta: { name: "accepted-native-timeout", description: "data does not prove release" },
      async run(context) {
        const agent = await context.agents.open({
          key: "terminal",
          deadline: future(),
          runtime: "review",
        });
        const first = agent.run({ id: "first", prompt: "First.", deadline: future() });
        const second = agent.run({ id: "second", prompt: "Do not dispatch.", deadline: future() });
        const settled = await Promise.allSettled([first, second]);
        return settled.map((item) =>
          item.status === "fulfilled"
            ? item.value.outcome.kind
            : item.reason instanceof Error
              ? item.reason.message
              : String(item.reason),
        );
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            const native = await dispatch(session, turn, binding);
            return {
              ...native,
              release: async () => ({ kind: "quarantined", reason: "release unresolved" }),
            };
          }) as HarnessSession["start"],
          async close(reason?: string) {
            closeAttempts += 1;
            if (closeAttempts === 1) {
              await Bun.sleep(10);
              throw new Error("transient close failure");
            }
            await session.close(reason);
          },
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "retry-close", description: "owner retries terminal cleanup" },
      async run(context) {
        const agent = await context.agents.open({
          key: "retry-close",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({
          id: "wait",
          prompt: "Wait.",
          deadline: { unixMilliseconds: Date.now() + 20 },
        });
        return result.outcome.kind;
      },
    };

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
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            const native = await dispatch(session, turn, binding);
            return {
              ...native,
              release(reason: string, deadline: { unixMilliseconds: number }) {
                cancellationObserved = true;
                return native.release(reason, deadline);
              },
            };
          }) as HarnessSession["start"],
          async close(reason?: string) {
            cancellationObserved = true;
            await session.close(reason);
          },
        };
      },
    };
    const workflow: WorkflowDefinition<null, boolean> = {
      meta: { name: "cancel-order", description: "cancellation precedes scope rejection" },
      async run(context) {
        try {
          await context.parallel(
            [null],
            async () => {
              const agent = await context.agents.open({
                key: "cancel-order",
                deadline: future(),
                runtime: "review",
              });
              await agent.run({ id: "wait", prompt: "Wait.", deadline: future() });
            },
            { deadline: { unixMilliseconds: Date.now() + 20 } },
          );
        } catch {
          return cancellationObserved;
        }
        return false;
      },
    };

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe(true);
  });

  test("escaped capabilities are removed from native start diagnostics", async () => {
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        return {
          ...session,
          start: (async (
            _turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            binding: HarnessOperationBinding,
          ) => {
            const escaped = [...binding.capability]
              .map((character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
              .join("");
            throw new Error(`native start failed: ${escaped}`);
          }) as HarnessSession["start"],
        };
      },
    };
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "redacted-start", description: "authority-safe diagnostics" },
      async run(context) {
        const agent = await context.agents.open({
          key: "redacted",
          deadline: future(),
          runtime: "review",
        });
        const result = await agent.run({ id: "fail", prompt: "Fail.", deadline: future() });
        if (result.outcome.kind !== "failed") throw new Error("expected failed outcome");
        return result.outcome.reason;
      },
    };

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("harness operation failed without safe diagnostic detail");
    expect(JSON.stringify(result)).not.toContain("\\x");
  });

  test("a later agent cannot return authority issued earlier in the run", async () => {
    let earlierCapability = "";
    const adapter = createFakeAdapter({
      script: (context) => {
        if (context.activation.key === "first") {
          earlierCapability = context.binding!.capability;
          return {};
        }
        return {
          state: "failed",
          detail: `leaked ${earlierCapability}`,
          transcript: earlierCapability,
        };
      },
    });
    const workflow: WorkflowDefinition<null, string> = {
      meta: { name: "run-redaction", description: "full-run authority redaction" },
      async run(context) {
        const first = await context.agents.open({
          key: "first",
          deadline: future(),
          runtime: "review",
        });
        await first.run({ id: "first", prompt: "First.", deadline: future() });
        const second = await context.agents.open({
          key: "second",
          deadline: future(),
          runtime: "review",
        });
        const result = await second.run({ id: "second", prompt: "Second.", deadline: future() });
        return result.outcome.kind === "failed" ? result.outcome.reason : result.outcome.kind;
      },
    };

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: future(),
    });

    expect(result.value).toBe("harness operation produced no safe diagnostic detail");
    expect(JSON.stringify(result)).not.toContain(earlierCapability);
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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "queued-shutdown", description: "no post-close dispatch" },
      async run(context) {
        const agent = await context.agents.open({
          key: "queued",
          deadline: future(),
          runtime: "review",
        });
        void agent.run({ id: "first", prompt: "Wait.", deadline: future() });
        void agent.run({ id: "second", prompt: "Never dispatch.", deadline: future() });
        await started;
        return null;
      },
    };
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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "activation-failure", description: "cleanup after activation failure" },
      async run(context) {
        const good = await context.agents.open({
          key: "good",
          deadline: future(),
          runtime: "review",
        });
        await good.run({ id: "good", prompt: "Finish.", deadline: future() });
        await context.agents.open({ key: "broken", deadline: future(), runtime: "review" });
        return null;
      },
    };

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
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "detached-activation", description: "activation remains run-owned" },
      async run(context) {
        void context.agents.open({
          key: "detached",
          deadline: future(),
          runtime: "review",
        });
        return null;
      },
    };
    const started = performance.now();

    const result = await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(8);
  });

  test("agent cleanup can submit while the control plane is still available", async () => {
    let closeSubmission: ResultSubmitResponse | undefined;
    let turnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      turnStarted = resolve;
    });
    const fake = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          turnStarted();
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      }),
    });
    const adapter: AgentSessionAdapter = {
      ...fake,
      async activate(request) {
        const session = await fake.activate(request);
        let binding: HarnessOperationBinding | undefined;
        return {
          ...session,
          start: (async (
            turn: AgentTextTurnSpec | AgentStructuredTurnSpec<JsonValue>,
            nextBinding: HarnessOperationBinding,
          ) => {
            binding = nextBinding;
            return dispatch(session, turn, nextBinding);
          }) as HarnessSession["start"],
          async close(reason?: string) {
            if (binding) closeSubmission = await submit(binding, "submitted-during-close");
            await session.close(reason);
          },
        };
      },
    };
    const workflow: WorkflowDefinition<null, null> = {
      meta: { name: "cleanup-order", description: "agents close before result endpoint" },
      async run(context) {
        const agent = await context.agents.open({
          key: "closer",
          deadline: future(),
          runtime: "review",
        });
        void agent.run({ id: "pending", prompt: "Wait.", deadline: future() });
        await started;
        return null;
      },
    };

    await runWorkflow(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(closeSubmission).toMatchObject({ kind: "accepted" });
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

function future(milliseconds = 60_000) {
  return { unixMilliseconds: Date.now() + milliseconds };
}

async function submit(binding: HarnessOperationBinding, value: JsonObject | string) {
  const response = await exchange(
    binding.endpoint,
    `${JSON.stringify({
      version: WIRE_VERSION,
      operationId: binding.operationId,
      capability: binding.capability,
      raw: JSON.stringify(value),
    })}\n`,
  );
  return JSON.parse(response) as ResultSubmitResponse;
}

function exchange(endpoint: string, frame: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(frame));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
    socket.once("error", reject);
  });
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
