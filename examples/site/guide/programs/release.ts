import { defineWorkflow } from "agentswf/workflow";

export default defineWorkflow({
  meta: { name: "release", description: "Writes the notes for a version." },
  file: import.meta.path,
  prepare: ({ argv }) => ({
    version: argv[0] ?? "",
    dryRun: argv.includes("--dry"),
  }),
  async run(wf, { version, dryRun }) {
    const writer = await wf.agents.open({ key: "writer", runtime: "claude" });
    const { outcome } = await writer.run({
      prompt: `Write the release notes for ${version} from the commits since the last tag.${dryRun ? " Print them; commit nothing." : ""}`,
    });
    return outcome.answered
      ? String(outcome.value)
      : wf.stop(`no notes: ${outcome.kind}`);
  },
});
