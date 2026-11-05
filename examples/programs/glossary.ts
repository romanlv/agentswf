import { typed } from "agentswf/typebox";
import { defineWorkflow, type OutputSchema } from "agentswf/workflow";
import Type from "typebox";
import { RUNTIME } from "./runtime";

const Term = Type.Object({ term: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const TERM: OutputSchema<Type.Static<typeof Term>> = Term;
export const CLOSE: OutputSchema<null> = Type.Null();
const DEFINITION = typed(
  Type.Object({ definition: Type.String() }, { additionalProperties: false }),
);

/** A run per glossary: each term it is sent is defined and posted, until it is closed. */
export default defineWorkflow({
  meta: {
    name: "glossary",
    description: "Defines each term it is sent, posting each definition, until it is closed.",
  },
  file: import.meta.path,
  events: { term: TERM, close: CLOSE },
  starts: ["term"],
  async run(wf) {
    const thread = await wf.participants.connect({ key: "thread" });
    const writer = await wf.agents.open({ key: "writer", runtime: RUNTIME });
    // Each attempt runs from the top and takes the events not yet taken, so the run keeps nothing
    // in memory: what it made is in its posts.
    for await (const next of wf.select(
      { term: wf.signal("term"), close: wf.signal("close") },
      { label: "waiting for a term" },
    )) {
      if (next.close) return "closed";
      if (!next.term) continue;
      const { term } = next.term.data;
      const { outcome } = await writer.run({
        prompt: `Define "${term}" in one plain sentence, for someone new to the field.`,
        schema: DEFINITION,
      });
      await thread.post(
        outcome.answered
          ? `${term}: ${outcome.value.definition}`
          : `${term}: no definition (${outcome.kind})`,
      );
    }
    return "closed";
  },
});
