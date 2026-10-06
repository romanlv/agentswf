import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { ResultSubmitResponse } from "@agentswf/contract/wire";
import type {
  AgentPlacement,
  AgentStructuredTurnSpec,
  AgentTextTurnSpec,
  JsonValue,
  OutputSchema,
  RunResult,
  RuntimeSelection,
  RuntimeTarget,
  WorkflowContext,
  WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { DeadlineExceededError } from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type {
  AgentRunHostFactory,
  AgentRuntimeConfig,
  AgentSessionAdapter,
  HarnessOperationBinding,
  HarnessSession,
  HarnessTurn,
} from "@agentswf/harness/adapter";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { CONTROL_PLANE_ROOT } from "./control-plane";
import { type DecisionScope, RunDecisions } from "./decisions/directory";
import { openRun, readAccepted, readTurns } from "./runs";
import { createTempRunDirs, future, runNew, startNew, submit } from "./testing";
import { WorkflowCancelledError, WorkflowRunError } from "./workflow-runner";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
const shortReleasePolicy = {
  quietMs: 30_000,
  responseMs: 120_000,
  deliveryMs: 30_000,
  releaseMs: 40,
};
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
    const handle = await startNew(workflow, null, {
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
    expect(await causeOf(handle.result)).toBeInstanceOf(WorkflowCancelledError);
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
      runNew(workflow, null, {
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

    expect(
      await causeOf(
        runNew(workflow, null, {
          runRoot: tempRunDir(),
          runtime: emptyRuntime(),
          deadline,
          cwd: "/repo",
          signal: controller.signal,
        }),
      ),
    ).toBeInstanceOf(DeadlineExceededError);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort("too late");
  });

  test("signal cancellation removes its listener and cancels the deadline timer", async () => {
    const controller = new AbortController();
    const deadline = { unixMilliseconds: Date.now() + 40 };
    const workflow = workflowOf("run-signal", async () => {
      return await new Promise<never>(() => undefined);
    });
    const running = runNew(workflow, null, {
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
    const running = runNew(workflow, null, {
      runRoot: tempRunDir(),
      runtime,
      deadline: { unixMilliseconds: Date.now() + 20 },
    });

    await expect(running).rejects.toBeInstanceOf(DeadlineExceededError);
    release();
    await Bun.sleep(0);
    expect(closed).toBe(true);
  });

  test("an agent that cannot be opened rejects rather than throwing out of the caller", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const workflow = workflowOf("open-rejects", async (context) => {
      const [good, bad] = await Promise.allSettled([
        openReviewer(context),
        context.agents.open({ key: "stray", runtime: "no-such-alias" }),
      ]);
      return [good.status, bad.status === "rejected" ? String(bad.reason) : "fulfilled"];
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual(["fulfilled", "Error: unknown runtime alias: no-such-alias"]);
  });

  for (const nudgePrompt of ["Report the verdict now.", undefined]) {
    test(`an adapter sees the turn as the workflow wrote it beside the wrapped prompt, and the nudge's ${nudgePrompt ? "own" : "default"} prompt`, async () => {
      const adapter = createFakeAdapter({
        script: (context) => ({
          act: async () => {
            if (context.kind === "nudge") await submit(context.binding!, { answer: "ready" });
          },
        }),
      });
      const workflow = workflowOf("authored", async (context) => {
        const agent = await openReviewer(context);
        const { outcome } = await agent.run({
          prompt: "Review the change.",
          label: "review",
          schema: ANSWER_SCHEMA,
          deadline: future(),
          ...(nudgePrompt ? { nudge: { prompt: nudgePrompt } } : {}),
        });
        return outcome.kind;
      });

      const result = await runNew(workflow, null, {
        runRoot: tempRunDir(),
        deadline: future(),
        runtime: {
          aliases: { review: { harness: "fake", model: "fake" } },
          host: createSingleSessionHostFactory(adapter),
        },
      });

      expect(result.value).toBe("answered");
      const nudge =
        nudgePrompt ?? "You finished without reporting the requested result. Report it now.";
      expect(adapter.turns.map(({ kind, authored }) => ({ kind, authored }))).toEqual([
        {
          kind: "turn",
          authored: { prompt: "Review the change.", label: "review", schema: ANSWER_SCHEMA },
        },
        { kind: "nudge", authored: { prompt: nudge, label: "review", schema: ANSWER_SCHEMA } },
      ]);
      // What the agent is sent is unchanged: the authored prompt, wrapped with how to answer.
      for (const turn of adapter.turns) {
        expect(turn.prompt.startsWith(`${turn.authored!.prompt}\n\nWhen the answer is ready`)).toBe(
          true,
        );
        expect(turn.prompt).toContain(JSON.stringify(ANSWER_SCHEMA));
        expect(turn.prompt).toContain(turn.binding!.operationId);
      }
    });
  }

  test("the first prompt offers only wf result; a check-in adds wf waiting and the deadline", async () => {
    const adapter = createFakeAdapter({
      supportsWaiting: true,
      script: (context) => ({
        act: async () => {
          if (context.kind === "nudge") await submit(context.binding!, { answer: "ready" });
        },
      }),
    });
    const workflow = workflowOf("check-in-prompt", async (context) => {
      const agent = await openReviewer(context);
      const { outcome } = await agent.run({
        prompt: "Review the change.",
        schema: ANSWER_SCHEMA,
        deadline: future(),
      });
      return outcome.kind;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      livenessPolicy: { quietMs: 1, responseMs: 5_000, deliveryMs: 5_000, releaseMs: 1_000 },
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("answered");
    const [first, checkIn] = adapter.turns;
    expect(first?.kind).toBe("turn");
    expect(first?.prompt).toContain(" result ");
    expect(first?.prompt).not.toContain(" waiting ");
    expect(first?.prompt).not.toContain("deadline");
    expect(checkIn?.kind).toBe("nudge");
    expect(checkIn?.prompt).toContain(` waiting ${checkIn?.binding?.operationId} --reason`);
    expect(checkIn?.prompt).toContain("The fixed answer deadline is");
  });

  test("an adapter sees a text turn as the workflow wrote it, with no schema", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          await submit(context.binding!, "done");
        },
      }),
    });
    const workflow = workflowOf("authored-text", async (context) => {
      const agent = await openReviewer(context);
      const { outcome } = await agent.run({ prompt: "Summarize.", label: "summary" });
      return outcome.kind;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: {
        aliases: { review: { harness: "fake", model: "fake" } },
        host: createSingleSessionHostFactory(adapter),
      },
    });

    expect(result.value).toBe("answered");
    expect(adapter.turns.map(({ kind, authored }) => ({ kind, authored }))).toEqual([
      { kind: "turn", authored: { prompt: "Summarize.", label: "summary" } },
    ]);
  });

  test("a turn is released as answered only once its result is taken", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          if (context.id === "answers") await submit(context.binding!, { answer: "ready" });
        },
      }),
    });
    const releases: Array<boolean | undefined> = [];
    const inner = createSingleSessionHostFactory(adapter);
    const host: AgentRunHostFactory = {
      async openRun(spec) {
        const run = await inner.openRun(spec);
        return {
          ...run,
          async openAgent(request) {
            const session = await run.openAgent(request);
            const start = session.start.bind(session) as (
              ...args: Parameters<HarnessSession["start"]>
            ) => Promise<HarnessTurn>;
            return {
              ...session,
              start: (async (...args: Parameters<HarnessSession["start"]>) => {
                const turn = await start(...args);
                const released: HarnessTurn = {
                  ...turn,
                  release: (reason, deadline, options) => {
                    releases.push(options?.answered);
                    return turn.release(reason, deadline, options);
                  },
                };
                return released;
              }) as HarnessSession["start"],
            };
          },
        };
      },
    };
    const workflow = workflowOf("answered", async (context) => {
      const agent = await openReviewer(context);
      const kinds: string[] = [];
      for (const id of ["answers", "stays-silent"]) {
        const { outcome } = await agent.run({
          id,
          prompt: id,
          schema: ANSWER_SCHEMA,
          deadline: future(),
          nudge: false,
        });
        kinds.push(outcome.kind);
      }
      return kinds;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: { aliases: { review: { harness: "fake", model: "fake" } }, host },
    });

    // The same agent takes a second operation; only the answered one is released as answered.
    expect(result.value).toEqual(["answered", "unanswered"]);
    expect(releases).toEqual([true]);
  });

  test("an answer waits for natural release before workflow continuation and records its charge", async () => {
    const events: string[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let releasing!: () => void;
    const releaseStarted = new Promise<void>((resolve) => {
      releasing = resolve;
    });
    const fake = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          await submit(context.binding!, "ready");
        },
      }),
    });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        const settled = native.settled.then(async (outcome) => {
          await finished;
          return { ...outcome, chargesUsd: [0.25] };
        });
        return {
          ...native,
          settled,
          async release(reason, deadline, options) {
            expect(options).toMatchObject({ answered: true, awaitCompletion: true });
            events.push("release started");
            releasing();
            await finished;
            const outcome = await settled;
            events.push("released");
            await native.release(reason, deadline, options);
            return { kind: "released" as const, outcome };
          },
        };
      }),
    }));
    const workflow = workflowOf("finishing", async (context) => {
      const agent = await openReviewer(context);
      const result = await agent.run({ prompt: "Answer.", deadline: future(), nudge: false });
      events.push("workflow continued");
      return result.outcome.kind;
    });
    const configured = runtime(adapter);
    configured.host = {
      ...configured.host,
      accounting: {
        pollMs: 5,
        stalledMs: 50,
        statusMs: 50,
        read: async () => ({ records: [], open: false }),
        billing: async () => "metered",
      },
    };
    const running = runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: configured,
    });
    await releaseStarted;
    await Bun.sleep(0);
    expect(events).toEqual(["release started"]);
    finish();
    const result = await running;
    expect(result.value).toBe("answered");
    expect(events).toEqual(["release started", "released", "workflow continued"]);
    expect(result.usage[0]?.charged).toEqual({ amount: 0.25, currency: "USD" });
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("placement is the agent's: added to an alias, a pane left unsaid, and kept on reopening", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const workflow = workflowOf("placement", async (context) => {
      const open = (key: string, runtime: RuntimeSelection) =>
        context.agents.open({ key, deadline: future(), runtime }).then(
          () => "opened",
          (error: unknown) => String(error),
        );
      return [
        await open("a", { alias: "review", placement: "headless" }),
        await open("b", { harness: "fake", model: "fake", placement: "pane", metered: true }),
        await open("c", { harness: "fake", model: "fake", placement: "headless", metered: true }),
        await open("a", { alias: "review", placement: "headless" }),
        await open("a", "review"),
        await open("a", { alias: "review", placement: "pane" }),
        await open("a", { alias: "review", metered: true }),
        await open("c", { harness: "fake", model: "fake", placement: "headless" }),
        await open("c", { harness: "fake", model: "fake" }),
        await open("c", { harness: "fake", model: "fake", placement: "pane" }),
        await open("d", { alias: "headlessAlias" }),
        await open("e", {
          harness: "fake",
          model: "fake",
          placement: "Headless" as AgentPlacement,
        }),
      ];
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: {
        ...runtime(adapter),
        aliases: {
          ...runtime(adapter).aliases,
          headlessAlias: { harness: "fake", model: "fake", placement: "headless" } as RuntimeTarget,
        },
      },
    });

    expect(result.value).toEqual([
      "opened",
      "opened",
      "opened",
      "opened",
      "opened",
      "Error: existing agent uses a different placement",
      "Error: existing agent uses a different placement",
      "opened",
      "opened",
      "Error: existing agent uses a different placement",
      "opened",
      'Error: unknown placement "Headless"; expected pane or headless',
    ]);
    expect(adapter.activations.map((activation) => activation.execution)).toEqual([
      { harness: "fake", model: "fake", alias: "review", placement: "headless" },
      { harness: "fake", model: "fake" },
      { harness: "fake", model: "fake", placement: "headless", metered: true },
      // An alias that tries to carry a placement is read for its target only.
      { harness: "fake", model: "fake", alias: "headlessAlias" },
    ]);
  });

  test("a synchronous host acquisition failure still closes the result endpoint", async () => {
    const runRoot = tempRunDir();
    const before = await controlDirectories();
    const runtime: AgentRuntimeConfig = {
      aliases: {},
      host: {
        openRun() {
          throw new Error("host construction failed");
        },
      },
    };

    const running = runNew(
      workflowOf("sync-host-failure", async () => null),
      null,
      { runRoot, runtime, deadline: future() },
    );
    await expect(running).rejects.toThrow("host construction failed");
    // No agent ran, so there is no spend to carry.
    await expect(running).rejects.not.toBeInstanceOf(WorkflowRunError);

    expect(await controlDirectoriesSince(before)).toEqual([]);
  });

  test("a run whose deadline passes fails, and closes a turn held to that deadline", async () => {
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
      // The turn is held to the run's deadline, so it may time out first; only the run's ends this.
      return await new Promise<null>(() => undefined);
    });
    const runRoot = tempRunDir();
    const before = await controlDirectories();

    expect(
      await causeOf(
        runNew(workflow, null, {
          runRoot,
          runtime: runtime(adapter),
          deadline: { unixMilliseconds: Date.now() + 30 },
        }),
      ),
    ).toBeInstanceOf(DeadlineExceededError);
    expect(nativeCancelled).toBe(1);
    expect(adapter.closed).toEqual(["reviewer"]);
    expect(await controlDirectoriesSince(before)).toEqual([]);
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
    const result = runNew(workflow, null, {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: { unixMilliseconds: Date.now() + 30 },
    });
    const error = await Promise.race([
      causeOf(result),
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
    // The turn, held to the run's deadline, may time out and close its session before cleanup does.
    expect(closeStarted).toBeGreaterThan(0);
  }, 6_500);

  test("the command the prompt shows, copied as it stands with the value filled in, answers", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const shown = context.prompt.split("return it by running:\n\n")[1]!.split("\n\n")[0]!;
          const command = shown.replace("<json>", JSON.stringify({ answer: "ready" }));
          const child = Bun.spawn(["sh", "-c", command], {
            env: {},
            stdout: "pipe",
            stderr: "pipe",
          });
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect({ exitCode, stdout, stderr }).toEqual({
            exitCode: 0,
            stdout: "wf: result accepted\n",
            stderr: "",
          });
        },
      }),
    });
    const workflow = workflowOf("shown-command", async (context) => {
      const agent = await openReviewer(context);
      const result = await agent.run({
        prompt: "answer",
        schema: ANSWER_SCHEMA,
        deadline: future(),
        nudge: false,
      });
      return result.outcome.kind;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("answered");
  });

  test("runs a structured turn through a fake adapter and the real result endpoint", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "fake-native",
        chargesUsd: [0.01],
        act: async () => {
          expect(context.binding).toBeDefined();
          // The schema itself, bounds and all, not a rendering that drops them (E5).
          expect(context.prompt).toContain(JSON.stringify(ANSWER_SCHEMA));
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

    const result = await runNew(workflow, null, {
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
      sessions: [{ harness: "fake", id: "fake-native" }],
      billing: "unknown",
    });
    expect(result.usage[0]).not.toHaveProperty("spend");
    expect(adapter.closed).toEqual(["reviewer"]);
  });

  test("a nudged operation is timed from first delivery through natural answer release", async () => {
    const attempts: Array<{ began: number; answered: number; ended: number }> = [];
    let continuedAt = 0;
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const began = Date.now();
          await Bun.sleep(15);
          if (context.kind === "nudge") await submit(context.binding!, { answer: "late" });
          const answered = Date.now();
          await Bun.sleep(20);
          attempts.push({ began, answered, ended: Date.now() });
        },
      }),
    });
    const workflow = workflowOf("nudged-times", async (context) => {
      const agent = await openReviewer(context);
      const result = await agent.run({ prompt: "Review.", schema: ANSWER_SCHEMA });
      continuedAt = Date.now();
      return result.outcome.kind;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("answered");
    const [first, nudge] = attempts;
    const { deliveredAt, settledAt } = result.usage[0]!;
    expect(Date.parse(deliveredAt!)).toBeLessThanOrEqual(first!.began);
    expect(attempts).toHaveLength(2);
    expect(nudge!.ended).toBeGreaterThan(nudge!.answered);
    expect(Date.parse(settledAt!)).toBeGreaterThanOrEqual(nudge!.ended);
    expect(Date.parse(settledAt!)).toBeLessThanOrEqual(continuedAt);
  });

  test("a timed-out operation settles at its deadline, not when the engine noticed", async () => {
    let deadline = future();
    const adapter = createFakeAdapter({
      script: async (context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return {};
      },
    });
    const workflow = workflowOf("timed-out-times", async (context) => {
      const agent = await openReviewer(context);
      deadline = future(50);
      const result = await agent.run({ prompt: "Wait.", deadline, nudge: false });
      return result.outcome.kind;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(result.usage[0]!.settledAt).toBe(new Date(deadline.unixMilliseconds).toISOString());
    expect(Date.parse(result.usage[0]!.deliveredAt!)).toBeLessThan(deadline.unixMilliseconds);
  });

  test("an operation queued behind another is timed from its own delivery", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          await Bun.sleep(20);
          await submit(context.binding!, { answer: context.id });
        },
      }),
    });
    let asked = 0;
    const workflow = workflowOf("queued-times", async (context) => {
      const agent = await openReviewer(context);
      asked = Date.now();
      await Promise.all([
        agent.run({ prompt: "First.", schema: ANSWER_SCHEMA }),
        agent.run({ prompt: "Second.", schema: ANSWER_SCHEMA }),
      ]);
      return null;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    const [first, second] = result.usage;
    expect(Date.parse(first!.deliveredAt!)).toBeGreaterThanOrEqual(asked);
    expect(Date.parse(second!.deliveredAt!)).toBeGreaterThanOrEqual(Date.parse(first!.settledAt!));
  });

  test("an earlier legacy nudge deadline caps the initial attempt", async () => {
    const nudgeDeadline = future(10);
    const adapter = createFakeAdapter({
      script: () => ({
        act: async () => {
          await Bun.sleep(40);
        },
      }),
    });
    const workflow = workflowOf("late-first-attempt", async (context) => {
      const agent = await openReviewer(context);
      const result = await agent.run({ prompt: "Review.", nudge: { deadline: nudgeDeadline } });
      return result.outcome.kind;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    const { deliveredAt, settledAt } = result.usage[0]!;
    expect(result.value).toBe("timed-out");
    expect(Date.parse(settledAt!)).toBe(nudgeDeadline.unixMilliseconds);
    expect(adapter.turns).toHaveLength(1);
    expect(adapter.closed).toEqual(["reviewer"]);
    expect(Date.parse(settledAt!)).toBeGreaterThan(Date.parse(deliveredAt!));
  });

  test("a nudge that runs out of time settles at the nudge's deadline", async () => {
    let nudgeDeadline = future();
    const adapter = createFakeAdapter({
      script: async (context) => {
        if (context.kind === "nudge") {
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return {};
      },
    });
    const workflow = workflowOf("nudge-times-out", async (context) => {
      const agent = await openReviewer(context);
      nudgeDeadline = future(50);
      const result = await agent.run({ prompt: "Review.", nudge: { deadline: nudgeDeadline } });
      return result.outcome.kind;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(result.usage[0]!.settledAt).toBe(new Date(nudgeDeadline.unixMilliseconds).toISOString());
  });

  test("an operation's own deadlines never outlast the run's", async () => {
    const seen: { start?: number; nudge?: number } = {};
    const inner = createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) }));
    const host: AgentRunHostFactory = {
      async openRun(spec) {
        const run = await inner.openRun(spec);
        return {
          ...run,
          async openAgent(request) {
            const session = await run.openAgent(request);
            const start = session.start.bind(session) as (
              ...args: Parameters<HarnessSession["start"]>
            ) => Promise<HarnessTurn>;
            return {
              ...session,
              start: (async (...args: Parameters<HarnessSession["start"]>) => {
                seen.start = args[0].deadline.unixMilliseconds;
                const turn = await start(...args);
                return {
                  ...turn,
                  nudge: (spec) => {
                    seen.nudge = spec.deadline.unixMilliseconds;
                    return turn.nudge(spec);
                  },
                } satisfies HarnessTurn;
              }) as HarnessSession["start"],
            };
          },
        };
      },
    };
    const deadline = future(5_000);
    const workflow = workflowOf("clamped-deadlines", async (context) => {
      const agent = await openReviewer(context);
      const late = future(60_000);
      await agent.run({ prompt: "Review.", deadline: late, nudge: { deadline: late } });
      return null;
    });

    await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline,
      runtime: { aliases: { review: { harness: "fake", model: "fake" } }, host },
    });

    expect(seen).toEqual({ start: deadline.unixMilliseconds, nudge: deadline.unixMilliseconds });
  });

  test("a turn with an invalid deadline is refused before it is queued", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const workflow = workflowOf("invalid-deadline", async (context) => {
      const agent = await openReviewer(context);
      const refused = agent.run({ prompt: "Review.", deadline: { unixMilliseconds: -1 } });
      const both = agent.run({ prompt: "Review.", deadline: future(), timeoutMs: 1_000 });
      return await outcomesOf([refused, both]);
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toEqual([
      "deadline.unixMilliseconds must be a non-negative safe integer",
      "an operation cannot specify both deadline and timeoutMs",
    ]);
    expect(adapter.turns).toEqual([]);
  });

  test("an operation that expires before dispatch settles at its deadline, undelivered", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const deadline = { unixMilliseconds: Date.now() - 1 };
    const workflow = workflowOf("expired-before-dispatch", async (context) => {
      const agent = await openReviewer(context);
      return (await agent.run({ prompt: "Review.", deadline })).outcome.kind;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(result.usage[0]).not.toHaveProperty("deliveredAt");
    expect(result.usage[0]!.settledAt).toBe(new Date(deadline.unixMilliseconds).toISOString());
  });

  test("an agent's sessions join what its wf calls report with what its adapter saw", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        sessionRef: "from-adapter",
        act: async () => {
          await submit(context.binding!, { wrong: true }, "from-launcher-1");
          await submit(context.binding!, { answer: "ready" }, "from-launcher-2");
          await submit(context.binding!, { answer: "ready" }, "from-launcher-2");
        },
      }),
    });
    const workflow = workflowOf("sessions", async (context) => {
      const agent = await openReviewer(context);
      await agent.run({ prompt: "Review.", schema: ANSWER_SCHEMA });
      return null;
    });

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.usage[0]!.sessions).toEqual([
      { harness: "fake", id: "from-launcher-1" },
      { harness: "fake", id: "from-launcher-2" },
      { harness: "fake", id: "from-adapter" },
    ]);
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

    const result = await runNew(workflow, null, {
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

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("timed-out");
    expect(adapter.closed).toEqual(["slow"]);
    await expect(connect(endpoint)).rejects.toBeDefined();
  });

  test("an accepted result with no natural release fails within the release bound", async () => {
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "failed",
    );
    expect(
      await readAccepted(
        join(runRoot, workflow.meta.name, result.runId),
        result.usage[0]!.operationId,
      ),
    ).toEqual({ value: "accepted-before-hang" });
    // The run's deadline is a minute off and the test's timeout five seconds: only the release
    // bound ends the hang in time, and leaves its operation unresolved.
    expect(String((result.cause as AggregateError).errors)).toContain(
      "cleanup-unresolved: hanging",
    );
    expect(operationSignal?.aborted).toBe(true);
    expect(adapter.closed).toEqual(["hanging"]);
  }, 5_000);

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
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      return [first.outcome.kind, second];
    });

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "failed",
    );
    expect(
      await readAccepted(
        join(runRoot, workflow.meta.name, result.runId),
        result.usage[0]!.operationId,
      ),
    ).toEqual({ value: "accepted" });
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

    const result = await runNew(workflow, null, {
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

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBe("unanswered");
    expect(adapter.turns.map((turn) => turn.kind)).toEqual(["turn"]);
  });

  test("an accepted result waits for pending native acquisition and release", async () => {
    let closeNudge!: () => void;
    const nudgeClosed = new Promise<void>((resolve) => {
      closeNudge = resolve;
    });
    let submitted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    let returned = false;
    const fake = createFakeAdapter({ script: () => ({}) });
    const adapter = adapterWith(fake, (session) => ({
      start: starting(async (turn, binding) => {
        const native = await dispatch(session, turn, binding);
        return {
          ...native,
          async nudge() {
            await submit(binding, "accepted-during-nudge-start");
            submitted();
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
      returned = true;
      return result.outcome.kind === "answered" ? result.outcome.value : result.outcome.kind;
    });

    const running = runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    await accepted;
    await Bun.sleep(0);
    expect(returned).toBe(false);
    closeNudge();
    const result = await running;
    expect(returned).toBe(true);
    expect(result.value).toBe("accepted-during-nudge-start");
    expect(fake.closed).toEqual(["reviewer"]);
  });

  test("an accepted artifact survives acquisition rejection without workflow success", async () => {
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "failed",
    );
    expect(
      await readAccepted(
        join(runRoot, workflow.meta.name, result.runId),
        result.usage[0]!.operationId,
      ),
    ).toEqual({ value: "accepted-before-start-rejection" });
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "failed",
    );
    expect(
      await readAccepted(
        join(runRoot, workflow.meta.name, result.runId),
        result.usage[0]!.operationId,
      ),
    ).toEqual({ value: "accepted-before-stuck-release" });
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

    const result = await runNew(workflow, null, {
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

    const result = await runNew(workflow, null, {
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

    const result = await runNew(workflow, null, {
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
      const outcome = await context
        .parallel(
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
        )
        .then(
          (values) => values[0]!,
          (error: unknown) =>
            error instanceof Error && "code" in error ? String(error.code) : "wrong-error",
        );
      expect(observedTurnDeadline).toBe(scopeDeadline.unixMilliseconds);
      release();
      await Bun.sleep(0);
      return outcome;
    });

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "timed-out",
    );
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
      const outcome = await context
        .parallel(
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
        )
        .then(
          (values) => values[0]!,
          (error: unknown) =>
            error instanceof Error && "code" in error ? String(error.code) : "wrong-error",
        );
      releaseNudge();
      return outcome;
    });

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    const turns = await readTurns(join(runRoot, workflow.meta.name, result.runId));
    expect(turns).toHaveLength(1);
    expect(["timed-out", "cancelled"]).toContain(turns[0]!.outcome);
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

    expect(
      await causeOf(
        runNew(workflow, null, {
          runRoot: tempRunDir(),
          runtime: runtime(adapter),
          deadline: future(),
        }),
      ),
    ).toMatchObject({ code: "deadline-exceeded" });
    expect(adapter.closed.sort()).toEqual(["one", "two"]);
    expect(adapter.turns.every((turn) => turn.signal.aborted)).toBe(true);
  });

  test("a parallel deadline rejects even when a callback cannot cooperate", async () => {
    const adapter = createFakeAdapter({ script: () => ({}) });
    const workflow = workflowOf("non-cooperative", async (context) => {
      await context.parallel([null], () => new Promise<never>(() => undefined), {
        deadline: { unixMilliseconds: Date.now() + 20 },
      });
      return null;
    });

    expect(
      await causeOf(
        runNew(workflow, null, {
          runRoot: tempRunDir(),
          runtime: runtime(adapter),
          deadline: future(),
        }),
      ),
    ).toMatchObject({ code: "deadline-exceeded" });
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

    expect(
      await causeOf(
        runNew(workflow, null, {
          runRoot: tempRunDir(),
          runtime: runtime(adapter),
          deadline: future(),
        }),
      ),
    ).toMatchObject({ code: "deadline-exceeded" });
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
      runNew(workflow, null, {
        runRoot: tempRunDir(),
        runtime: runtime(adapter),
        deadline: future(),
      }),
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

    const result = await runNew(workflow, null, {
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

    const result = await runNew(workflow, null, {
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

    const result = await runNew(workflow, null, {
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

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(createFakeAdapter({ script: () => ({}) })),
    });

    expect(result.value).toBe("parallel execution scope is closed");
    expect(nestedRan).toBe(false);
  });

  test("deadline expiry during unresolved native start records timeout and fails the run", async () => {
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "timed-out",
    );
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "timed-out",
    );
    expect(String(result.cause)).toContain("cleanup failed");
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "timed-out",
    );
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "timed-out",
    );
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
            chargesUsd: [],
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

    const result = await runNew(workflow, null, {
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
            chargesUsd: [],
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "failed",
    );
    expect(
      await readAccepted(
        join(runRoot, workflow.meta.name, result.runId),
        result.usage[0]!.operationId,
      ),
    ).toEqual({ value: "accepted-at-native-timeout" });
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

    const runRoot = tempRunDir();
    const result = await failedRun(
      runNew(workflow, null, {
        runRoot,
        livenessPolicy: shortReleasePolicy,
        deadline: future(),
        runtime: runtime(adapter),
      }),
    );

    expect((await readTurns(join(runRoot, workflow.meta.name, result.runId)))[0]?.outcome).toBe(
      "timed-out",
    );
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

    const result = await runNew(workflow, null, {
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

    const result = await runNew(workflow, null, {
      runRoot,
      runtime: runtime(adapter),
      deadline: future(),
    });

    expect(adapter.turns).toHaveLength(1);
    const { dir } = await openRun(runRoot, workflow.meta.name, result.runId);
    expect(await readdir(join(dir, "calls"))).toHaveLength(1);
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
      runNew(workflow, null, {
        runRoot: tempRunDir(),
        runtime: runtime(adapter),
        deadline: future(),
      }),
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

    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(adapter),
    });

    expect(result.value).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(8);
  });
});

describe("pane records", () => {
  test("a run that fails still records where its panes went", async () => {
    const adapter = adapterWith(createFakeAdapter({ script: () => ({}) }), () => ({
      pane: () => ({ session: "awf", workspace: "run" as const, tab: "lens", kept: true as const }),
    }));
    const workflow = workflowOf("panes-failed", async (context) => {
      await context.agents.open({ key: "lens", runtime: "review", keepPane: "always" });
      throw new Error("the workflow gave up");
    });
    const failed = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: future(),
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(WorkflowRunError);
    expect((failed as WorkflowRunError).panes).toEqual([
      {
        callPath: [],
        agent: "lens",
        keepPane: "always",
        placed: { session: "awf", workspace: "run", tab: "lens", kept: true },
      },
    ]);
  });

  test("the run records where each pane agent's pane went, with its layout as written", async () => {
    const adapter = adapterWith(createFakeAdapter({ script: () => ({}) }), () => ({
      pane: () => ({
        session: "awf",
        workspace: "run" as const,
        tab: "lens",
        fallback: "lead is not open",
      }),
    }));
    const workflow = workflowOf("panes", async (context) => {
      await context.agents.open({
        key: "lens",
        runtime: "review",
        layout: { beside: "lead", side: "right" },
        keepPane: "on-failure",
      });
      return null;
    });
    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      runtime: runtime(adapter),
      deadline: future(),
    });
    expect(result.panes).toEqual([
      {
        callPath: [],
        agent: "lens",
        layout: { beside: "lead", side: "right" },
        keepPane: "on-failure",
        placed: { session: "awf", workspace: "run", tab: "lens", fallback: "lead is not open" },
      },
    ]);
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

/** The control plane's directories live under `CONTROL_PLANE_ROOT`, not the run directory. */
async function controlDirectories(): Promise<Set<string>> {
  return new Set((await readdir(CONTROL_PLANE_ROOT)).filter((name) => name.startsWith("awf-")));
}

async function controlDirectoriesSince(before: Set<string>): Promise<string[]> {
  return [...(await controlDirectories())].filter((name) => !before.has(name));
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

/** The run's own error, from the `WorkflowRunError` a run that opened its host rejects with. */
async function causeOf(result: Promise<unknown>): Promise<unknown> {
  const error = await result.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WorkflowRunError);
  return (error as WorkflowRunError).cause;
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

async function failedRun(result: Promise<unknown>): Promise<WorkflowRunError> {
  const error = await result.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(WorkflowRunError);
  expect(String((error as WorkflowRunError).cause)).toContain("cleanup failed");
  return error as WorkflowRunError;
}

test("parallel rejection waits for native stop completion before workflow continuation", async () => {
  const events: string[] = [];
  const aborted = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const adapter = createFakeAdapter({
    script: async (context) => {
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      events.push("native aborted");
      aborted.resolve();
      await finish.promise;
      events.push("native ended");
      return {};
    },
  });
  const workflow = workflowOf("scope-stop-proof", async (context) => {
    const agent = await openReviewer(context);
    await context
      .parallel([null], () => agent.run({ prompt: "wait", deadline: future(), nudge: false }), {
        deadline: future(30),
      })
      .catch(() => {
        events.push("parallel rejected");
      });
    return null;
  });
  const running = runNew(workflow, null, {
    runRoot: tempRunDir(),
    deadline: future(),
    runtime: runtime(adapter),
  });
  await aborted.promise;
  await Bun.sleep(0);
  try {
    expect(events).toEqual(["native aborted"]);
  } finally {
    finish.resolve();
    await running;
  }
  expect(events).toEqual(["native aborted", "native ended", "parallel rejected"]);
});

test("sibling failure cancels a turn even when its reason mentions a deadline", async () => {
  const started = Promise.withResolvers<void>();
  const adapter = createFakeAdapter({
    script: async (context) => {
      started.resolve();
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {};
    },
  });
  const workflow = workflowOf("scope-stop-kind", async (context) => {
    const agent = await openReviewer(context);
    let pending!: Promise<RunResult<string>>;
    await context
      .parallel([0, 1], async (index) => {
        if (index === 0) {
          pending = agent.run({ prompt: "wait", nudge: false });
          await pending;
        } else {
          await started.promise;
          throw new Error("deadline report malformed");
        }
      })
      .catch(() => undefined);
    return (await pending).outcome.kind;
  });
  const result = await runNew(workflow, null, {
    runRoot: tempRunDir(),
    deadline: future(),
    runtime: runtime(adapter),
  });
  expect(result.value).toBe("cancelled");
});

test("slot opening failure records the reserved operation and closes its logical agent", async () => {
  const runRoot = tempRunDir();
  const adapter = createFakeAdapter({ script: () => ({}) });
  const workflow = workflowOf("slot-open-failure", async (context) => {
    const agent = await openReviewer(context);
    const [id] = await readdir(join(runRoot, "slot-open-failure"));
    await writeFile(join(runRoot, "slot-open-failure", id!, "calls"), "blocks call persistence");
    const first = await agent.run({ prompt: "never dispatched", nudge: false }).then(
      (run) => run.outcome.kind,
      () => "rejected",
    );
    const second = await agent.run({ prompt: "closed", nudge: false }).then(
      () => "continued",
      (error: unknown) => String(error),
    );
    return { first, second };
  });
  const result = await runNew(workflow, null, {
    runRoot,
    deadline: future(),
    runtime: runtime(adapter),
  });
  expect(result.usage).toHaveLength(1);
  expect(result.usage[0]!.settledAt).toBeDefined();
  expect(result.usage[0]!.deliveredAt).toBeUndefined();
  expect(result.value).toEqual({ first: "failed", second: "Error: logical agent is closed" });
  expect(adapter.turns).toHaveLength(0);
  expect(adapter.closed).toEqual(["reviewer"]);
});

test("an unexpected supervisor release throw fails the run instead of claiming cleanup", async () => {
  const fake = createFakeAdapter({
    script: (context) => ({
      chargesUsd: [0.75],
      act: async () => {
        await submit(context.binding!, "saved");
      },
    }),
  });
  const adapter = adapterWith(fake, (session) => ({
    start: starting(async (turn, binding) => {
      const native = await dispatch(session, turn, binding);
      return {
        ...native,
        release: async () => {
          await native.settled;
          return {
            kind: "released" as const,
            get outcome(): never {
              throw new Error("unexpected native release evidence throw");
            },
          };
        },
      };
    }),
  }));
  const workflow = workflowOf("unexpected-release-throw", async (context) => {
    const agent = await openReviewer(context);
    return (await agent.run({ prompt: "answer", nudge: false })).outcome.kind;
  });
  const configured = runtime(adapter);
  configured.host = {
    ...configured.host,
    accounting: {
      pollMs: 5,
      stalledMs: 50,
      statusMs: 50,
      read: async () => ({ records: [], open: false }),
      billing: async () => "metered",
    },
  };
  const runRoot = tempRunDir();
  const error = await failedRun(
    runNew(workflow, null, { runRoot, deadline: future(), runtime: configured }),
  );
  expect(error.usage).toHaveLength(1);
  expect(error.usage[0]?.charged).toEqual({ amount: 0.75, currency: "USD" });
  expect(error.usage[0]?.deliveredAt).toBeDefined();
  expect((await readTurns(join(runRoot, workflow.meta.name, error.runId)))[0]?.outcome).toBe(
    "failed",
  );
  expect(fake.closed).toEqual(["reviewer"]);
});

test("a late scope canceller is invoked synchronously and its throw is contained", async () => {
  let add: DecisionScope["add"];
  const decide = spyOn(RunDecisions.prototype, "decide").mockImplementation((_spec, scope) => {
    add = scope.add;
    return Promise.reject(new Error("decision failed"));
  });
  let invoked = false;
  try {
    const workflow = workflowOf("late-canceller", async (context) => {
      await context
        .parallel(
          [null],
          async () => {
            await context.decisions.decide({
              key: "q",
              model: "test",
              state: "test",
              questions: {},
            });
          },
          { deadline: future() },
        )
        .catch(() => undefined);
      const remove = add!(() => {
        invoked = true;
        throw new Error("stop callback failed");
      });
      expect(invoked).toBe(true);
      remove();
      return "continued";
    });
    const result = await runNew(workflow, null, {
      runRoot: tempRunDir(),
      deadline: future(),
      runtime: runtime(createFakeAdapter({ script: () => ({}) })),
    });
    expect(result.value).toBe("continued");
  } finally {
    decide.mockRestore();
  }
});
