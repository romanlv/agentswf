import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const NOTES = Type.Object(
  { notes: Type.String(), breaking: Type.Boolean() },
  { additionalProperties: false },
);
export const CHECK = Type.Object(
  { breaking: Type.Boolean(), why: Type.String() },
  { additionalProperties: false },
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
    const draft = await writer.run<Type.Static<typeof NOTES>>({
      prompt: `Write release notes for the commits in ${args.range}.`,
      schema: NOTES,
    });
    if (!isAnswered(draft.outcome))
      return wf.stop(`no notes: ${draft.outcome.reason}`);
    const { notes, breaking } = draft.outcome.value;
    if (!breaking) return { notes, breaking, checked: false };

    const checker = await wf.agents.open({ key: "checker", runtime: "codex" });
    const check = await checker.run<Type.Static<typeof CHECK>>({
      prompt:
        `These notes call ${args.range} a breaking change. ` +
        `Read its diff and say whether it is.\n\n${notes}`,
      schema: CHECK,
    });
    if (!isAnswered(check.outcome)) return { notes, breaking, checked: false };
    return { notes, breaking: check.outcome.value.breaking, checked: true };
  },
});
