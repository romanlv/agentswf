import { describe, expect, test } from "bun:test";
import type {
  ExternalParticipantRef,
  JsonValue,
  WorkflowContext,
  WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { answer, reply, testWorkflow } from "./index";

const PURPOSE = "report findings that hold up; ask when the logs can't settle it";

/** An investigator with a route both ways to a coordinator; `beside` runs once the route is open. */
function investigate(
  options: {
    timeoutMs?: number;
    beside?: (workflow: WorkflowContext, coordinator: ExternalParticipantRef) => Promise<unknown>;
    run?: boolean;
  } = {},
): WorkflowDefinition<null, JsonValue> {
  return {
    meta: { name: "investigate", description: "watches checkout-api" },
    async run(workflow) {
      const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
      const coordinator = await workflow.participants.connect({
        key: "coordinator",
        labels: { audience: "operator" },
      });
      await workflow.messages.allow({
        between: [investigator, coordinator],
        purpose: PURPOSE,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      const side = options.beside?.(workflow, coordinator);
      if (options.run === false) {
        await side;
        return "returned";
      }
      const { outcome } = await investigator.run({ prompt: "Check the checkout-api logs." });
      await side;
      return outcome.kind === "answered" ? outcome.value : outcome.kind;
    },
  };
}

/** The investigator reports, then asks, and returns what the answer said. */
const asks = answer(async (turn) => {
  await turn.send("coordinator", "5xx at 4× since 09:12.");
  const answered = await turn.send("coordinator", "Merge with 10-14, or keep two?", {
    awaitReply: true,
  });
  return answered.kind === "replied" ? answered.text : `no answer: ${answered.kind}`;
});

describe("a coordinator in a workflow's test", () => {
  test("a report, and a question answered in the same session", async () => {
    const seen: string[] = [];
    const run = await testWorkflow(investigate(), null, {
      agents: { investigator: [asks] },
      coordinators: {
        coordinator: async (event) => {
          seen.push(
            event.kind === "route"
              ? `route ${event.agent} ${event.direction}`
              : `${event.id} ${event.from}${event.asks ? " asks" : ""}`,
          );
          if (event.kind === "message" && event.asks) {
            expect(await event.reply("Keep two, and link them.")).toEqual({
              code: "delivered",
              id: event.id,
            });
          }
        },
      },
    });
    expect(run.value).toBe("Keep two, and link them.");
    expect(seen).toEqual(["route investigator both", "1.1 investigator", "1.2 investigator asks"]);
    expect(run.messagesOf("coordinator")).toEqual([
      { from: "investigator", awaitReply: false, end: "delivered" },
      { from: "investigator", awaitReply: true, end: "replied" },
    ]);
    expect(run.messagesOf("investigator")).toEqual([
      { from: "coordinator", awaitReply: false, end: "delivered" },
    ]);
    // The answer resumes the same call: a turn of its own, sharing its number.
    expect(run.turnsOf("investigator").map(({ n, outcome }) => ({ n, outcome }))).toEqual([
      { n: 1, outcome: "awaiting-reply" },
      { n: 1, outcome: "answered" },
    ]);
    expect(run.turnsOf("investigator")[1]?.messages).toEqual([
      { from: "coordinator", text: "Keep two, and link them.", answers: true },
    ]);
  });

  test("a question closes at its route's timeoutMs", async () => {
    const run = await testWorkflow(investigate({ timeoutMs: 50 }), null, {
      agents: { investigator: [asks] },
      coordinators: { coordinator: () => undefined },
    });
    expect(run.value).toBe("no answer: failed");
    expect(run.messagesOf("coordinator")[1]).toEqual({
      from: "investigator",
      awaitReply: true,
      end: "failed",
      reason: "timed-out",
    });
  });

  test("an agent's shorter --timeout closes its question first", async () => {
    const run = await testWorkflow(investigate({ timeoutMs: 60 * 60_000 }), null, {
      agents: {
        investigator: [
          answer(async (turn) => {
            const answered = await turn.send("coordinator", "Merge?", {
              awaitReply: true,
              timeoutMs: 50,
            });
            return answered.kind;
          }),
        ],
      },
      coordinators: { coordinator: () => undefined },
    });
    expect(run.value).toBe("failed");
    expect(run.messagesOf("coordinator")).toEqual([
      { from: "investigator", awaitReply: true, end: "failed", reason: "timed-out" },
    ]);
  });

  test("a question on a stage's route keeps the stage open until it is answered", async () => {
    const order: string[] = [];
    const staged: WorkflowDefinition<null, JsonValue> = {
      meta: { name: "staged", description: "a stage's route" },
      async run(workflow) {
        const investigator = await workflow.agents.open({ key: "investigator", runtime: "claude" });
        const coordinator = await workflow.participants.connect({ key: "coordinator" });
        await workflow.stage("triage", async () => {
          await workflow.messages.allow({ between: [investigator, coordinator], purpose: PURPOSE });
          await investigator.run({ prompt: "Ask." });
        });
        order.push("stage ended");
        return order;
      },
    };
    const run = await testWorkflow(staged, null, {
      agents: { investigator: [asks] },
      coordinators: {
        coordinator: async (event) => {
          if (event.kind === "message" && event.asks) {
            await Bun.sleep(30);
            order.push("answered");
            await event.reply("Keep two.");
          }
        },
      },
    });
    expect(run.value).toEqual(["answered", "stage ended"]);
  });

  test("releasing the coordinator ends its open question", async () => {
    const asked = Promise.withResolvers<void>();
    const run = await testWorkflow(
      investigate({
        beside: async (_, coordinator) => {
          await asked.promise;
          expect(await coordinator.release("investigation done")).toBe(true);
          expect(await coordinator.release()).toBe(false);
        },
      }),
      null,
      {
        agents: { investigator: [asks] },
        coordinators: {
          coordinator: (event) => {
            if (event.kind === "message" && event.asks) asked.resolve();
          },
        },
      },
    );
    expect(run.value).toBe("no answer: failed");
    expect(run.messagesOf("coordinator")[1]).toMatchObject({ end: "failed", reason: "released" });
  });

  test("a script that never answers ends the attempt instead of hanging", async () => {
    const run = await testWorkflow(investigate(), null, {
      stallMs: 200,
      agents: { investigator: [asks] },
      coordinators: { coordinator: () => undefined },
    });
    expect(() => run.value).toThrow();
    expect(run.messagesOf("coordinator")[1]).toEqual({
      from: "investigator",
      awaitReply: true,
      end: "failed",
      reason: "attempt-ended",
    });
  });

  test("the coordinator sends first, to an idle agent and to one between turns", async () => {
    const run = await testWorkflow(investigate(), null, {
      agents: {
        investigator: [
          answer(async (turn) => {
            if (turn.messages.length > 0) return turn.messages.map((each) => each.text).join(" / ");
            await turn.send("coordinator", "Started.");
            return reply.waiting("waiting for the coordinator");
          }),
        ],
      },
      coordinators: {
        coordinator: async (event) => {
          if (event.kind === "message")
            expect(await event.send("investigator", "Also check the 09:12 deploy.")).toMatchObject({
              code: "delivered",
            });
        },
      },
    });
    expect(run.value).toBe("Also check the 09:12 deploy.");

    const woken = Promise.withResolvers<void>();
    const idle = await testWorkflow(
      investigate({ run: false, beside: () => woken.promise }),
      null,
      {
        messages: {
          investigator: (message) => {
            woken.resolve();
            return message.silent();
          },
        },
        coordinators: {
          coordinator: (event) =>
            event.kind === "route" ? event.send("Look at the pool.") : undefined,
        },
      },
    );
    expect(idle.value).toBe("returned");
    expect(idle.turnsOf("investigator").map((turn) => turn.cause)).toEqual([
      { message: { from: "coordinator" } },
    ]);
  });

  test("a question open when the workflow returns keeps the run open until it is answered", async () => {
    const asked = Promise.withResolvers<void>();
    const run = await testWorkflow(investigate({ run: false, beside: () => asked.promise }), null, {
      messages: {
        investigator: async (message) => {
          const answered = await message.send("coordinator", "Merge or keep two?", {
            awaitReply: true,
          });
          expect(answered).toEqual({ kind: "replied", text: "Keep two." });
          return message.silent();
        },
      },
      coordinators: {
        coordinator: async (event) => {
          if (event.kind === "route") return event.send("Go.");
          if (event.asks) {
            // Answered once the workflow has returned.
            asked.resolve();
            await Bun.sleep(50);
            return event.reply("Keep two.");
          }
        },
      },
    });
    expect(run.value).toBe("returned");
    expect(run.messagesOf("coordinator")).toEqual([
      { from: "investigator", awaitReply: true, end: "replied" },
    ]);
  });

  test("reserved keys, taken keys, and timeoutMs between agents are refused", async () => {
    const refusals: WorkflowDefinition<null, JsonValue> = {
      meta: { name: "refusals", description: "keys" },
      async run(workflow) {
        const errors: string[] = [];
        const tried = async (attempt: () => Promise<unknown>) =>
          attempt().then(
            () => errors.push("accepted"),
            (error: Error) => errors.push(error.message),
          );
        await tried(() => workflow.participants.connect({ key: "operator" }));
        await tried(() => workflow.participants.connect({ key: "System" }));
        await tried(() => workflow.agents.open({ key: "user", runtime: "claude" }));
        const a = await workflow.agents.open({ key: "a", runtime: "claude" });
        const b = await workflow.agents.open({ key: "b", runtime: "claude" });
        await tried(() => workflow.participants.connect({ key: "a" }));
        await workflow.participants.connect({ key: "coordinator" });
        await tried(() => workflow.agents.open({ key: "coordinator", runtime: "claude" }));
        await tried(() =>
          workflow.messages.allow({ between: [a, b], purpose: "Talk.", timeoutMs: 1 }),
        );
        expect(await workflow.participants.get("coordinator")).toMatchObject({
          key: "coordinator",
        });
        expect(await workflow.participants.get("a")).toBe(a);
        expect(await workflow.participants.get("nobody")).toBeNull();
        return errors;
      },
    };
    const run = await testWorkflow(refusals, null, { coordinators: { coordinator: () => {} } });
    expect(run.value).toEqual([
      "operator is reserved: an agent could read a message from it as authority; a participant takes another key",
      "System is reserved: an agent could read a message from it as authority; a participant takes another key",
      "user is reserved: an agent could read a message from it as authority; an agent takes another key",
      "a is an agent's key; a participant takes a key of its own",
      "coordinator is a participant outside the run; an agent takes another key",
      "timeoutMs is only for a route an agent asks an outside participant over: between them, or to it",
    ]);
  });

  test("a route to a coordinator with no script fails the test", async () => {
    await expect(
      testWorkflow(investigate({ run: false }), null, { coordinators: {} }),
    ).rejects.toThrow(
      'a route reached coordinator "coordinator", which has no script under coordinators',
    );
  });
});
