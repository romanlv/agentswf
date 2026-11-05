import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const NOTES = typed(
  Type.Object(
    { notes: Type.String(), breaking: Type.Boolean() },
    { additionalProperties: false },
  ),
);
export const CHECK = typed(
  Type.Object(
    { breaking: Type.Boolean(), why: Type.String() },
    { additionalProperties: false },
  ),
);

export type ReleaseNotes = {
  notes: string;
  breaking: boolean;
  checked: boolean;
};

export default defineWorkflow({
  meta: {
    name: "release-notes",
    description:
      "Draft release notes; a second agent checks a claimed breaking change.",
  },
  prepare: ({ argv }) => ({ range: argv[0] ?? "origin/main...HEAD" }),
  async run(wf, args: { range: string }): Promise<ReleaseNotes> {
    const writer = await wf.agents.open({ key: "writer", runtime: "claude" });
    const draft = await writer.run({
      prompt: `Write release notes for the commits in ${args.range}.`,
      schema: NOTES,
    });
    if (!draft.outcome.answered)
      return wf.stop(`no notes: ${draft.outcome.reason}`);
    const { notes, breaking } = draft.outcome.value;
    if (!breaking) return { notes, breaking, checked: false };

    const checker = await wf.agents.open({ key: "checker", runtime: "codex" });
    const check = await checker.run({
      prompt:
        `These notes call ${args.range} a breaking change. ` +
        `Read its diff and say whether it is.\n\n${notes}`,
      schema: CHECK,
    });
    if (!check.outcome.answered) return { notes, breaking, checked: false };
    return { notes, breaking: check.outcome.value.breaking, checked: true };
  },
});
