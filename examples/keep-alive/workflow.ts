import { defineWorkflow } from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

export const Note = outputSchema(Type.Object({ text: Type.String() }));

/** Short, so the live check waits minutes rather than claude's cache hour, the default. */
export const WINDOW_MS = 90_000;

/** What onTimeout asks the compaction to keep: the notes, which a later wake recalls. */
export const FOCUS = "Keep every note's text exactly, in order; drop everything else.";

/**
 * An agent kept alive between events (story 036): each `note` is a turn for the same claude pane
 * while its window is open; once the window passes, `onTimeout` compacts it and the run parks. The
 * next `note` wakes it on the compacted session.
 */
export default defineWorkflow({
  meta: { name: "keep-alive", description: "Notes kept by one claude kept alive between them." },
  file: import.meta.path,
  events: { note: Note },
  async run(workflow) {
    const noter = await workflow.agents.open({
      key: "noter",
      runtime: { harness: "claude", model: "claude-haiku-5-5" },
      instructions: "You keep notes. Each turn gives you one; remember every one you are given.",
      keepAlive: {
        timeoutMs: WINDOW_MS,
        onTimeout: async (agent) => {
          await agent.compact({ prompt: FOCUS });
        },
      },
    });
    for (;;)
      for (const e of await workflow.receive({ label: "notes" }))
        if (e.name === "note")
          await noter.run({
            prompt: `A new note: ${e.data.text}\nAnswer with every note you have, in the order given, one per line, and nothing else.`,
          });
  },
});
