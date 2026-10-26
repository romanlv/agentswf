import { describe, expect, test } from "bun:test";
import { tool, type WorkflowDefinition } from "@agentswf/contract/workflow";
import { answer, testWorkflow } from "@agentswf/engine/workflow-testing";
import Type from "typebox";
import { outputSchema } from "../output-schema";
import { Summary, tools } from "./workflow";

describe("tools", () => {
  test("the agent closes items through its tools, and the workflow sees them closed", async () => {
    const run = await testWorkflow(
      tools,
      { runtime: "codex" },
      {
        agents: {
          triager: answer(Summary, async (turn) => {
            const open = await turn.tool("list_open");
            expect(open).toEqual({
              kind: "result",
              output: expect.stringContaining("a1  The login page shows the old logo"),
            });
            await turn.tool("close_item", { id: "a1", status: "done", why: "Fixed yesterday." });
            return { closed: 1, summary: "Closed the logo item." };
          }),
        },
      },
    );
    expect(run.value.items).toEqual([
      {
        id: "a1",
        title: "The login page shows the old logo",
        status: "done",
        why: "Fixed yesterday.",
      },
      expect.objectContaining({ id: "b2", status: "open" }),
    ]);
  });

  test("input that doesn't fit is refused and leaves the item open; a handler's throw is a failure", async () => {
    const seen: unknown[] = [];
    const run = await testWorkflow(
      tools,
      { runtime: "codex" },
      {
        agents: {
          triager: answer(Summary, async (turn) => {
            seen.push(await turn.tool("close_item", { id: "a1", status: "maybe", why: "?" }));
            seen.push(await turn.tool("close_item", { id: "zz", status: "done", why: "gone" }));
            return { closed: 0, summary: "Nothing closed." };
          }),
        },
      },
    );
    expect(seen).toEqual([
      { kind: "refused", code: "invalid-input", error: expect.stringContaining("value.status") },
      {
        kind: "failed",
        outcome: "failed",
        error: "no open item zz; list_open shows the open ones",
      },
    ]);
    expect(run.value.items.every((item) => item.status === "open")).toBe(true);
  });

  test("a scripted message turn's call closes an item too", async () => {
    const closed: string[] = [];
    const handoff: WorkflowDefinition<null, string[]> = {
      meta: {
        name: "handoff",
        description: "A message hands an item to the agent that closes it.",
      },
      async run(workflow) {
        const lead = await workflow.agents.open({ key: "lead", runtime: "codex" });
        const closer = await workflow.agents.open({
          key: "closer",
          runtime: "codex",
          tools: {
            close: tool({
              description: "Close an item.",
              input: outputSchema(Type.Object({ id: Type.String() })),
              handler: (input) => {
                closed.push(input.id);
                return "Closed.";
              },
            }),
          },
        });
        await workflow.messages.allow({
          from: lead,
          to: closer,
          purpose: "Hand over items to close.",
        });
        await lead.run({ prompt: "Hand over a1." });
        return closed;
      },
    };
    const run = await testWorkflow(handoff, null, {
      agents: {
        lead: answer(async (turn) => {
          await turn.send("closer", "Close a1.");
          return "handed over";
        }),
      },
      messages: {
        closer: async (message) => {
          expect(await message.tool("close", { id: "a1" })).toEqual({
            kind: "result",
            output: "Closed.",
          });
          return message.silent();
        },
      },
    });
    expect(run.value).toEqual(["a1"]);
  });
});
