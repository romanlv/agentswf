// #region file
import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const CHECK = Type.Object(
  { problems: Type.Array(Type.String()) },
  { additionalProperties: false },
);

export default defineWorkflow({
  meta: { name: "check-docs", description: "Check each doc file against the code." },

  prepare: ({ argv }) => {
    if (argv.length === 0) throw new Error("name the files to check, after --");
    return { files: [...argv] };
  },

  async run(wf, args) {
    const checker = await wf.agents.open({ key: "checker", runtime: "codex" });
    const checked: { file: string; problems: string[] }[] = [];
    for (const file of args.files) {
      const { outcome } = await checker.run<Type.Static<typeof CHECK>>({
        prompt: `Check every command and API that ${file} shows against the code.`,
        schema: CHECK,
      });
      if (!isAnswered(outcome)) return wf.stop(`${file}: ${outcome.kind}: ${outcome.reason}`);
      checked.push({ file, problems: outcome.value.problems });
    }
    return { checked };
  },

  present: (result) =>
    result.checked
      .map(({ file, problems }) => `${file}: ${problems.length === 0 ? "ok" : problems.length}`)
      .join("\n"),

  report: (result, ending) => {
    if (result) {
      const lines = result.checked.flatMap(({ file, problems }) => [
        `## ${file}`,
        ...(problems.length === 0 ? ["No problems."] : problems.map((p) => `- ${p}`)),
      ]);
      return ["# Docs checked", ...lines].join("\n\n");
    }
    if (ending.kind === "completed" || ending.kind === "parked") return undefined;
    return `# Check ${ending.kind}\n\n${ending.reason}\n\nTo go on: \`${ending.continue}\`\n`;
  },
});
// #endregion file
