import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const CHANGE = Type.Object(
  { summary: Type.String(), files: Type.Array(Type.String()) },
  { additionalProperties: false },
);

export default defineWorkflow({
  meta: {
    name: "ask-the-architect",
    description: "An implementer adds retries, and may ask an architect about the design.",
  },
  async run(wf) {
    // #region open
    // Headless codex can wait for a reply; a codex pane can't yet.
    const runtime = { alias: "codex", placement: "headless" } as const;
    const implementer = await wf.agents.open({ key: "implementer", runtime });
    const architect = await wf.agents.open({
      key: "architect",
      runtime,
      instructions: "You own this service's design. Answer questions about it in a few lines.",
    });

    await wf.messages.allow({
      from: implementer,
      to: architect,
      purpose: "Ask about the design when the code does not settle it.",
      maxMessages: 6,
    });
    // #endregion open

    // #region run
    const { outcome } = await implementer.run<Type.Static<typeof CHANGE>>({
      prompt: "Add retries to the HTTP client in src/http.ts.",
      schema: CHANGE,
    });
    if (!isAnswered(outcome)) return wf.stop(`implementer: ${outcome.reason}`);

    const questions = wf
      .usage()
      .filter((operation) => operation.agent === "architect" && operation.cause).length;
    return { ...outcome.value, questions };
    // #endregion run
  },
});
