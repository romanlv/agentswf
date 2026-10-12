import { afterAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunLogLine, TurnRecord } from "@agentswf/contract/records";
import { type ControlRequest, WIRE_VERSION } from "@agentswf/contract/wire";
import type {
  AgentRef,
  JsonValue,
  OutputSchema,
  WorkflowContext,
  WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentRuntimeConfig } from "@agentswf/harness/adapter";
import {
  createFakeAdapter,
  type FakeAdapterTurn,
  type FakeAdapterTurnContext,
} from "@agentswf/harness/testing";
import { submitControl } from "@agentswf/wf/client";
import { createTempRunDirs, future, runNew } from "./testing";
import type { WorkflowRunError } from "./workflow-runner";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const VERDICT: OutputSchema<{ verdict: string }> = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false,
};
const PURPOSE = "Review and revise the implementation until both agree it is ready.";
const POLICY = { quietMs: 20, responseMs: 2_000, deliveryMs: 2_000, releaseMs: 50 };

type Turn = FakeAdapterTurnContext;
type Script = (turn: Turn) => Promise<FakeAdapterTurn | undefined> | FakeAdapterTurn | undefined;

/** Runs `workflow` with each agent's turns answered by its script, in turn order. */
async function run<T extends JsonValue>(
  scripts: Record<string, Script[]>,
  workflow: (context: WorkflowContext) => Promise<T>,
  options: { supportsWaiting?: boolean } = {},
) {
  const counts = new Map<string, number>();
  const adapter = createFakeAdapter({
    supportsWaiting: options.supportsWaiting ?? false,
    script: async (turn) => {
      const n = counts.get(turn.activation.key) ?? 0;
      counts.set(turn.activation.key, n + 1);
      const script = scripts[turn.activation.key]?.[n];
      if (!script) return {};
      return (await script(turn)) ?? {};
    },
  });
  const runtime: AgentRuntimeConfig = {
    aliases: { fake: { harness: "fake", model: "fake" } },
    host: createSingleSessionHostFactory(adapter),
  };
  const runRoot = runDirs.tempRunDir();
  const definition: WorkflowDefinition<null, T> = {
    meta: { name: "messaging", description: "messaging" },
    run: (context) => workflow(context),
  };
  const outcome = await runNew(definition, null, {
    runRoot,
    runtime,
    deadline: future(30_000),
    livenessPolicy: POLICY,
  }).then(
    (settled) => ({ ok: true as const, value: settled.value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { adapter, outcome, log: () => logOf(runRoot) };
}

async function logOf(runRoot: string): Promise<RunLogLine[]> {
  const dir = join(runRoot, "messaging");
  const [id] = await import("node:fs/promises").then((fs) => fs.readdir(dir));
  const text = await readFile(join(dir, id!, "turns.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunLogLine);
}

/** What an agent's `wf` sends, over its own socket. */
function wf(turn: Turn, request: Record<string, unknown>) {
  return submitControl(turn.binding!.endpoint, {
    version: WIRE_VERSION,
    ...request,
  } as ControlRequest);
}

const result = (turn: Turn, value: JsonValue) =>
  wf(turn, {
    command: "result",
    operationId: turn.binding!.operationId,
    raw: JSON.stringify(value),
  });

/** A turn that takes `ms`, or ends sooner when the agent is stopped, as a harness's would. */
function sleep(ms: number, signal: AbortSignal): Promise<FakeAdapterTurn> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({}), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve({});
    });
  });
}

const open = (context: WorkflowContext, key: string, instructions?: string) =>
  context.agents.open({
    key,
    runtime: "fake",
    ...(instructions ? { instructions } : {}),
    deadline: future(30_000),
  });

describe("messaging through the runner", () => {
  test("an asker waits across turns; its question wakes the peer; the answer continues the same call", async () => {
    let call: string | undefined;
    const { adapter, outcome, log } = await run(
      {
        reviewer: [
          async (turn) => {
            call = turn.binding!.operationId;
            expect(turn.prompt).toContain("You can message other agents on these routes:");
            const sent = await wf(turn, {
              command: "send",
              peer: "implementer",
              text: "Handle a cache miss.",
              awaitReply: true,
            });
            expect(sent).toMatchObject({ kind: "sent", message: 1 });
            return {};
          },
          async (turn) => {
            // The same call, continued: a turn of its own carrying the answer.
            expect(turn.kind).toBe("deliver");
            expect(turn.binding!.operationId).toBe(call!);
            expect(turn.authored?.messages).toEqual([
              {
                kind: "message",
                from: "implementer",
                text: "A miss falls through.",
                answers: true,
              },
            ]);
            await result(turn, { verdict: "ready" });
            return {};
          },
        ],
        implementer: [
          async (turn) => {
            // Never run: the question is its first turn, a message operation.
            expect(turn.kind).toBe("turn");
            expect(turn.authored?.cause).toEqual({ message: { from: "reviewer" } });
            expect(turn.authored?.messages).toEqual([
              { kind: "message", from: "reviewer", text: "Handle a cache miss.", asks: true },
            ]);
            expect(await result(turn, { verdict: "no" }).catch(() => undefined)).toMatchObject({
              code: "no-result",
            });
            expect(
              await wf(turn, { command: "reply", peer: "reviewer", text: "A miss falls through." }),
            ).toMatchObject({ kind: "sent" });
            return {};
          },
        ],
      },
      async (context) => {
        const reviewer = await open(context, "reviewer");
        const implementer = await open(context, "implementer");
        await context.messages.allow({ between: [reviewer, implementer], purpose: PURPOSE });
        const { outcome } = await reviewer.run({ prompt: "Review.", schema: VERDICT });
        return outcome.kind === "answered"
          ? outcome.value
          : `${outcome.kind}: ${"reason" in outcome ? outcome.reason : ""}`;
      },
    );
    expect(outcome).toEqual({ ok: true, value: { verdict: "ready" } });
    expect(adapter.turns.map((turn) => `${turn.activation.key}:${turn.kind}`)).toEqual([
      "reviewer:turn",
      "implementer:turn",
      "reviewer:deliver",
    ]);
    const lines = await log();
    const turns = lines.filter((line): line is TurnRecord => line.kind === "turn");
    expect(turns.map((line) => [line.agent, line.cause])).toEqual([
      ["implementer", { message: { from: "reviewer" } }],
      ["reviewer", undefined],
    ]);
    const messaging = lines.flatMap((line) =>
      line.kind === "message-delivery"
        ? [`${line.kind} ${line.message} ${line.state}`]
        : line.kind.startsWith("message") ||
            line.kind.startsWith("route") ||
            line.kind.startsWith("request")
          ? [line.kind]
          : [],
    );
    expect(messaging).toEqual([
      "route-opened",
      "message-sent",
      "message-delivery 1 offered",
      "message-sent",
      "request-ended",
      "message-delivery 2 offered",
      // The fake here gives no delivery evidence: each is unconfirmed once its turn has ended.
      "message-delivery 1 unconfirmed",
      "message-delivery 2 unconfirmed",
      "route-closed",
    ]);
  });

  test("held messages continue a workflow's turn that ended without a result, before its check-in", async () => {
    const reported = Promise.withResolvers<void>();
    const { adapter, outcome } = await run(
      {
        lens: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "fixer", text: "Off-by-one in page.ts" });
            await wf(turn, { command: "send", peer: "fixer", text: "done" });
            reported.resolve();
            await result(turn, { verdict: "sent" });
            return {};
          },
        ],
        fixer: [
          async () => {
            // Busy while the lens reports; its turn then ends without a result.
            await reported.promise;
            return {};
          },
          async (turn) => {
            expect(turn.kind).toBe("deliver");
            expect(turn.authored?.messages?.map((m) => m.kind === "message" && m.text)).toEqual([
              "Off-by-one in page.ts",
              "done",
            ]);
            await result(turn, { verdict: "fixed" });
            return {};
          },
        ],
      },
      async (context) => {
        const fixer = await open(context, "fixer");
        const lens = await open(context, "lens");
        await context.messages.allow({ from: lens, to: fixer, purpose: "Report findings." });
        const [fixed] = await Promise.all([
          fixer.run({ prompt: "Fix what the lens sends.", schema: VERDICT }),
          lens.run({ prompt: "Find.", schema: VERDICT }),
        ]);
        return fixed.outcome.kind === "answered" ? fixed.outcome.value : fixed.outcome.kind;
      },
    );
    expect(outcome).toEqual({ ok: true, value: { verdict: "fixed" } });
    expect(
      adapter.turns.filter((turn) => turn.activation.key === "fixer").map((t) => t.kind),
    ).toEqual(["turn", "deliver"]);
  });

  test("messages held while a run is queued join it, after its prompt", async () => {
    const reported = Promise.withResolvers<void>();
    const { adapter, outcome } = await run(
      {
        lens: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "fixer", text: "Finding." });
            reported.resolve();
            await result(turn, { verdict: "sent" });
            return {};
          },
        ],
        fixer: [
          async (turn) => {
            await reported.promise;
            await result(turn, { verdict: "first" });
            return {};
          },
          async (turn) => {
            expect(turn.kind).toBe("turn");
            expect(turn.prompt.indexOf("Second task.")).toBeLessThan(
              turn.prompt.indexOf("Finding."),
            );
            expect(turn.authored?.messages).toEqual([
              { kind: "message", from: "lens", text: "Finding." },
            ]);
            await result(turn, { verdict: "second" });
            return {};
          },
        ],
      },
      async (context) => {
        const fixer = await open(context, "fixer");
        const lens = await open(context, "lens");
        await context.messages.allow({ from: lens, to: fixer, purpose: "Report findings." });
        const first = fixer.run({ prompt: "First task.", schema: VERDICT });
        const second = fixer.run({ prompt: "Second task.", schema: VERDICT });
        await lens.run({ prompt: "Find.", schema: VERDICT });
        return [(await first).outcome.kind, (await second).outcome.kind];
      },
    );
    expect(outcome).toEqual({ ok: true, value: ["answered", "answered"] });
    expect(adapter.turns.filter((turn) => turn.activation.key === "fixer")).toHaveLength(2);
  });

  test("an owed answer blocks the result, gets one reminder, then fails and its asker is told", async () => {
    const asked = Promise.withResolvers<void>();
    const { outcome } = await run(
      {
        asker: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "owner", text: "Why?", awaitReply: true });
            asked.resolve();
            return {};
          },
          async (turn) => {
            expect(turn.authored?.messages).toEqual([
              { kind: "no-reply", from: "owner", reason: "it did not reply after a reminder" },
            ]);
            await result(turn, { verdict: "gave up" });
            return {};
          },
        ],
        owner: [
          async () => {
            // Busy while it is asked; its turn ends without a result.
            await asked.promise;
            return {};
          },
          async (turn) => {
            // The question continues its turn, and now it owes the answer.
            expect(turn.kind).toBe("deliver");
            // The refusal says what is owed itself, so no owed-answer line repeats it.
            expect(await result(turn, { verdict: "x" })).toEqual({
              version: WIRE_VERSION,
              kind: "rejected",
              code: "owes-reply",
              error: expect.stringContaining("you owe asker a reply"),
            });
            return {};
          },
          async (turn) => {
            expect(turn.prompt).toStartWith("You owe asker a reply");
            return {};
          },
          async (turn) => {
            // The check-in, once the answer it owed has failed: now it may finish.
            expect(turn.kind).toBe("nudge");
            await result(turn, { verdict: "done" });
            return {};
          },
        ],
      },
      async (context) => {
        const asker = await open(context, "asker");
        const owner = await open(context, "owner");
        await context.messages.allow({ from: asker, to: owner, purpose: "Ask." });
        const [o, a] = await Promise.all([
          owner.run({ prompt: "Work.", schema: VERDICT }),
          asker.run({ prompt: "Ask the owner.", schema: VERDICT }),
        ]);
        return [a.outcome.kind, o.outcome.kind];
      },
    );
    expect(outcome).toEqual({ ok: true, value: ["answered", "answered"] });
  });

  test("a stage waits for what its routes carry, then closes them", async () => {
    let afterStage: unknown;
    const { outcome } = await run(
      {
        planner: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "architect", text: "Queue or client?" });
            await result(turn, { verdict: "planned" });
            return {};
          },
          async (turn) => {
            afterStage = await wf(turn, { command: "send", peer: "architect", text: "Again?" });
            await result(turn, { verdict: "late" });
            return {};
          },
        ],
        architect: [async () => ({ durationMs: 0 })],
      },
      async (context) => {
        const planner = await open(context, "planner");
        const architect = await open(context, "architect");
        await context.stage("plan", async () => {
          await context.messages.allow({ from: planner, to: architect, purpose: "Ask." });
          await planner.run({ prompt: "Plan.", schema: VERDICT });
        });
        await planner.run({ prompt: "Again.", schema: VERDICT });
        return context.usage().map((record) => record.cause?.message.from ?? null);
      },
    );
    // The architect's message operation ran inside the stage, before it ended.
    expect(outcome).toEqual({ ok: true, value: [null, "planner", null] });
    expect(afterStage).toMatchObject({
      kind: "rejected",
      code: "closed",
      error: "the route to architect closed when its stage plan ended.",
    });
  });

  test("stopping an agent closes its routes and fails what it owed", async () => {
    const { outcome } = await run(
      {
        asker: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "peer", text: "Q?", awaitReply: true });
            return {};
          },
          async (turn) => {
            expect(turn.authored?.messages).toEqual([
              {
                kind: "no-reply",
                from: "peer",
                reason: 'it stopped ("not needed") before replying',
              },
            ]);
            await result(turn, { verdict: "alone" });
            return {};
          },
        ],
        peer: [async (turn) => sleep(200, turn.signal)],
      },
      async (context) => {
        const asker = await open(context, "asker");
        const peer = await open(context, "peer");
        await context.messages.allow({ from: asker, to: peer, purpose: "Ask." });
        const asked = asker.run({ prompt: "Ask.", schema: VERDICT });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await context.agents.stop("peer", "not needed");
        return (await asked).outcome.kind;
      },
    );
    expect(outcome).toEqual({ ok: true, value: "answered" });
  });

  test("a message operation whose harness fails stops the agent and fails its stage", async () => {
    const { outcome } = await run(
      {
        sender: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "broken", text: "hi" });
            await result(turn, { verdict: "sent" });
            return {};
          },
        ],
        broken: [async () => ({ state: "failed", detail: "harness crashed" })],
      },
      async (context) => {
        const sender = await open(context, "sender");
        const broken = await open(context, "broken");
        await context.stage("talk", async () => {
          await context.messages.allow({ from: sender, to: broken, purpose: "Talk." });
          await sender.run({ prompt: "Send.", schema: VERDICT });
        });
        return "unreachable";
      },
    );
    expect(outcome.ok).toBe(false);
    expect(String((outcome as { error: WorkflowRunError }).error.cause)).toContain(
      "message operation failed: harness crashed",
    );
  });

  test("outside any stage the attempt owns a message operation, and the workflow's value waits for it", async () => {
    let handled = false;
    const { outcome } = await run(
      {
        sender: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "listener", text: "note" });
            await result(turn, { verdict: "sent" });
            return {};
          },
        ],
        listener: [
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            handled = true;
            return {};
          },
        ],
      },
      async (context) => {
        const sender = await open(context, "sender");
        const listener = await open(context, "listener");
        await context.messages.allow({ from: sender, to: listener, purpose: "Notes." });
        await sender.run({ prompt: "Send.", schema: VERDICT });
        return "returned";
      },
    );
    expect(outcome).toEqual({ ok: true, value: "returned" });
    expect(handled).toBe(true);
  });

  test("outside any stage, a message operation that fails ends the run failed, value or not", async () => {
    const { outcome } = await run(
      {
        sender: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "broken", text: "hi" });
            await result(turn, { verdict: "sent" });
            return {};
          },
        ],
        broken: [async () => ({ state: "failed", detail: "harness crashed" })],
      },
      async (context) => {
        const sender = await open(context, "sender");
        const broken = await open(context, "broken");
        await context.messages.allow({ from: sender, to: broken, purpose: "Talk." });
        await sender.run({ prompt: "Send.", schema: VERDICT });
        return "returned";
      },
    );
    expect(outcome.ok).toBe(false);
  });

  test("a message cuts a check-in's wf waiting short", async () => {
    const started = Date.now();
    const { outcome } = await run(
      {
        worker: [
          async () => ({}),
          async (turn) => {
            // The check-in: it asks for time, then a message continues it long before then.
            expect(turn.kind).toBe("nudge");
            await wf(turn, {
              command: "waiting",
              operationId: turn.binding!.operationId,
              reason: "deploying",
              timeoutMs: 600_000,
            });
            return {};
          },
          async (turn) => {
            expect(turn.kind).toBe("deliver");
            await result(turn, { verdict: "told" });
            return {};
          },
        ],
        notifier: [
          async (turn) => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            await wf(turn, { command: "send", peer: "worker", text: "Deploy is done." });
            await result(turn, { verdict: "sent" });
            return {};
          },
        ],
      },
      async (context) => {
        const worker = await open(context, "worker");
        const notifier = await open(context, "notifier");
        await context.messages.allow({
          from: notifier,
          to: worker,
          purpose: "Say when it deploys.",
        });
        const [done] = await Promise.all([
          worker.run({ prompt: "Wait for the deploy.", schema: VERDICT }),
          notifier.run({ prompt: "Tell the worker.", schema: VERDICT }),
        ]);
        return done.outcome.kind;
      },
      { supportsWaiting: true },
    );
    expect(outcome).toEqual({ ok: true, value: "answered" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a question continues an asker waiting on its own answer, which then waits again", async () => {
    const answered = Promise.withResolvers<void>();
    const { outcome, adapter } = await run(
      {
        a: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "b", text: "Q-a?", awaitReply: true });
            return {};
          },
          async (turn) => {
            // c's question continues it while b's answer is still due.
            expect(turn.authored?.messages).toEqual([
              { kind: "message", from: "c", text: "Q-c?", asks: true },
            ]);
            await wf(turn, { command: "reply", peer: "c", text: "A-c." });
            answered.resolve();
            return {};
          },
          async (turn) => {
            expect(turn.authored?.messages).toEqual([
              { kind: "message", from: "b", text: "A-a.", answers: true },
            ]);
            await result(turn, { verdict: "both" });
            return {};
          },
        ],
        b: [
          async (turn) => {
            // b answers only once a has answered c, so a waits again in between.
            await answered.promise;
            await wf(turn, { command: "reply", peer: "a", text: "A-a." });
            return {};
          },
        ],
        c: [
          async (turn) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            await wf(turn, { command: "send", peer: "a", text: "Q-c?", awaitReply: true });
            return {};
          },
          async (turn) => {
            expect(turn.authored?.messages).toEqual([
              { kind: "message", from: "a", text: "A-c.", answers: true },
            ]);
            await result(turn, { verdict: "answered" });
            return {};
          },
        ],
      },
      async (context) => {
        const a = await open(context, "a");
        const b = await open(context, "b");
        const c = await open(context, "c");
        await context.messages.allow({ from: a, to: b, purpose: "Ask b." });
        await context.messages.allow({ from: c, to: a, purpose: "Ask a." });
        const [first, third] = await Promise.all([
          a.run({ prompt: "Ask b.", schema: VERDICT }),
          c.run({ prompt: "Ask a.", schema: VERDICT }),
        ]);
        return [first.outcome.kind, third.outcome.kind];
      },
    );
    expect(outcome).toEqual({ ok: true, value: ["answered", "answered"] });
    expect(adapter.turns.filter((turn) => turn.activation.key === "a").map((t) => t.kind)).toEqual([
      "turn",
      "deliver",
      "deliver",
    ]);
  });

  test("a message operation that times out stops its agent and fails its stage", async () => {
    let stoppedAfter: unknown;
    const { outcome } = await run(
      {
        sender: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "slow", text: "Take your time." });
            await result(turn, { verdict: "sent" });
            return {};
          },
        ],
        slow: [async () => ({ state: "timed-out", detail: "deadline passed" })],
      },
      async (context) => {
        const sender = await open(context, "sender");
        const slow = await open(context, "slow");
        const failed = await context
          .stage("talk", async () => {
            await context.messages.allow({ from: sender, to: slow, purpose: "Talk." });
            await sender.run({ prompt: "Send.", schema: VERDICT });
          })
          .then(() => "stage succeeded")
          .catch((error: Error) => error.message);
        stoppedAfter = await slow
          .run({ prompt: "Again.", timeoutMs: 1_000 })
          .then((r) => r.outcome.kind)
          .catch((error: Error) => error.message);
        return failed;
      },
    );
    expect(outcome).toEqual({
      ok: true,
      value: "agent slow's message operation timed-out: deadline passed",
    });
    expect(stoppedAfter).toBe("logical agent is closed");
  });

  test("a stage that throws cancels the message operations it owns", async () => {
    let aborted = false;
    const { outcome } = await run(
      {
        sender: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "listener", text: "Work on this." });
            await result(turn, { verdict: "sent" });
            return {};
          },
        ],
        listener: [
          async (turn) => {
            await sleep(5_000, turn.signal);
            aborted = turn.signal.aborted;
            return {};
          },
        ],
      },
      async (context) => {
        const sender = await open(context, "sender");
        const listener = await open(context, "listener");
        return context
          .stage("talk", async () => {
            await context.messages.allow({ from: sender, to: listener, purpose: "Talk." });
            await sender.run({ prompt: "Send.", schema: VERDICT });
            await new Promise((resolve) => setTimeout(resolve, 50));
            throw new Error("the stage gave up");
          })
          .then(() => "succeeded")
          .catch((error: Error) => error.message);
      },
    );
    expect(outcome).toEqual({ ok: true, value: "the stage gave up" });
    expect(aborted).toBe(true);
  });

  test("a send to an agent that has stopped is refused, naming why", async () => {
    let refused: unknown;
    const { outcome } = await run(
      {
        sender: [
          async (turn) => {
            refused = await wf(turn, { command: "send", peer: "gone", text: "Still there?" });
            await result(turn, { verdict: "done" });
            return {};
          },
        ],
      },
      async (context) => {
        const sender = await open(context, "sender");
        const gone = await open(context, "gone");
        await context.messages.allow({ from: sender, to: gone, purpose: "Talk." });
        await context.agents.stop("gone", "finished early");
        return (await sender.run({ prompt: "Send.", schema: VERDICT })).outcome.kind;
      },
    );
    expect(outcome).toEqual({ ok: true, value: "answered" });
    expect(refused).toMatchObject({
      code: "peer-stopped",
      error: 'gone has stopped ("finished early").',
    });
  });

  test("without nudges, a pane's turn that ends owing still gets its one reminder", async () => {
    const asked = Promise.withResolvers<void>();
    const { adapter, outcome } = await run(
      {
        asker: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "owner", text: "Why?", awaitReply: true });
            asked.resolve();
            return {};
          },
          async (turn) => {
            await result(turn, { verdict: "told" });
            return {};
          },
        ],
        owner: [
          async () => {
            await asked.promise;
            return {};
          },
          async () => ({}),
          async (turn) => {
            expect(turn.prompt).toStartWith("You owe asker a reply");
            await wf(turn, { command: "reply", peer: "asker", text: "Because." });
            await result(turn, { verdict: "done" });
            return {};
          },
        ],
      },
      async (context) => {
        const asker = await open(context, "asker");
        const owner = await open(context, "owner");
        await context.messages.allow({ from: asker, to: owner, purpose: "Ask." });
        const [o, a] = await Promise.all([
          owner.run({ prompt: "Work.", schema: VERDICT, nudge: false }),
          asker.run({ prompt: "Ask.", schema: VERDICT }),
        ]);
        return [o.outcome.kind, a.outcome.kind];
      },
      { supportsWaiting: true },
    );
    expect(outcome).toEqual({ ok: true, value: ["answered", "answered"] });
    expect(adapter.turns.filter((turn) => turn.activation.key === "owner")).toHaveLength(3);
  });

  test("a result drops the wait; the question it had not shown is withdrawn", async () => {
    const { outcome, adapter, log } = await run(
      {
        asker: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "busy", text: "Q?", awaitReply: true });
            await result(turn, { verdict: "found it myself" });
            return {};
          },
        ],
        busy: [async (turn) => sleep(150, turn.signal)],
      },
      async (context) => {
        const asker = await open(context, "asker");
        const busy = await open(context, "busy");
        await context.messages.allow({ from: asker, to: busy, purpose: "Ask." });
        const working = busy.run({ prompt: "Work.", nudge: false });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const asked = await asker.run({ prompt: "Ask.", schema: VERDICT });
        await working;
        return asked.outcome.kind;
      },
    );
    expect(outcome).toEqual({ ok: true, value: "answered" });
    // The busy agent never saw the withdrawn question.
    expect(adapter.turns.filter((turn) => turn.activation.key === "busy")).toHaveLength(1);
    expect((await log()).filter((line) => line.kind === "message-undelivered")).toMatchObject([
      { reason: "withdrawn" },
    ]);
  });

  test("a route's ends are refs this run issued: a spread of one is refused", async () => {
    const { outcome } = await run({}, async (context) => {
      const a = await open(context, "a");
      const b = await open(context, "b");
      const forged = { ...b, key: "b" } as AgentRef;
      return context.messages
        .allow({ from: a, to: forged, purpose: "x" })
        .then(() => "granted")
        .catch((error: Error) => error.message);
    });
    expect(outcome).toEqual({
      ok: true,
      value: "a route's ends are agents this workflow opened; b is not one",
    });
  });

  test("wf waiting while an answer is awaited is acknowledged and changes nothing", async () => {
    const asked = Promise.withResolvers<void>();
    const { outcome } = await run(
      {
        asker: [
          async (turn) => {
            await wf(turn, { command: "send", peer: "peer", text: "Q?", awaitReply: true });
            const waiting = await wf(turn, {
              command: "waiting",
              operationId: turn.binding!.operationId,
              reason: "waiting on peer",
            });
            expect(waiting).toMatchObject({
              kind: "awaiting-reply",
              peer: "peer",
              notice: expect.stringContaining("you already await peer's reply"),
            });
            expect(waiting).not.toHaveProperty("owing");
            asked.resolve();
            return {};
          },
          async (turn) => {
            await result(turn, { verdict: "answered" });
            return {};
          },
        ],
        peer: [
          async (turn) => {
            await asked.promise;
            await wf(turn, { command: "reply", peer: "asker", text: "A." });
            return {};
          },
        ],
      },
      async (context) => {
        const asker = await open(context, "asker");
        const peer = await open(context, "peer");
        await context.messages.allow({ from: asker, to: peer, purpose: "Ask." });
        const { outcome } = await asker.run({ prompt: "Ask.", schema: VERDICT });
        return outcome.kind === "answered" ? outcome.kind : `${outcome.kind}: ${outcome.reason}`;
      },
      { supportsWaiting: true },
    );
    expect(outcome).toEqual({ ok: true, value: "answered" });
  });
});
