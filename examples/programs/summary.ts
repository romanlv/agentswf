import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";
import { RUNTIME } from "./runtime";

const SUMMARY = outputSchema(
  Type.Object({ summary: Type.String() }, { additionalProperties: false }),
);

/**
 * One paragraph that introduces a glossary's definitions. A program starts it with its args;
 * `awf run` takes each definition as an argument.
 */
export default defineWorkflow<{ definitions: string[] }, string>({
  meta: {
    name: "glossary-summary",
    description: "Writes one paragraph introducing a glossary's definitions.",
  },
  file: import.meta.path,
  prepare: ({ argv }) => ({ definitions: [...argv] }),
  async run(wf, { definitions }) {
    if (definitions.length === 0) return wf.stop("no definitions to summarize");
    const editor = await wf.agents.open({ key: "editor", runtime: RUNTIME });
    const { outcome } = await editor.run({
      prompt: `Write one short paragraph that introduces these terms to a newcomer, in this order:\n${definitions.join("\n")}`,
      schema: SUMMARY,
    });
    return outcome.answered ? outcome.value.summary : wf.stop(`no summary: ${outcome.kind}`);
  },
});
