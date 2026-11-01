import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const DONE = Type.Object({ summary: Type.String() }, { additionalProperties: false });
export const VERDICT = Type.Object(
  { approved: Type.Boolean(), findings: Type.Array(Type.String()) },
  { additionalProperties: false },
);
type Done = Type.Static<typeof DONE>;
type Verdict = Type.Static<typeof VERDICT>;

export type Result =
  | { approved: true; rounds: number }
  | { approved: false; rounds: number; open: string[] };

// #region bound
const MAX_ROUNDS = 4;
const TURN_MS = 20 * 60_000;
// #endregion bound

export default defineWorkflow({
  meta: {
    name: "fix-until-approved",
    description:
      "Implement a task, then fix what a reviewer on another model finds, until it approves.",
  },
  prepare: ({ argv }) => ({ task: argv.join(" ") }),
  async run(wf, { task }: { task: string }): Promise<Result> {
    const reviewer = await wf.agents.open({
      key: "reviewer",
      runtime: { harness: "codex", model: "gpt-6-luna" },
      instructions: "You review changes. Report what is wrong; never edit the code yourself.",
    });

    // #region branch
    let implementer = await wf.agents.open({ key: "implementer", runtime: "claude" });
    let replacements = 0;

    async function implement(prompt: string, open: string[]): Promise<Done> {
      const { outcome } = await implementer.run<Done>({ prompt, schema: DONE, timeoutMs: TURN_MS });
      switch (outcome.kind) {
        case "answered":
          return outcome.value;
        case "failed":
        case "timed-out": {
          // Either one closes the agent. A missing login fails every agent on its harness alike.
          if (outcome.kind === "failed" && outcome.login) return wf.stop(outcome.reason);
          if (replacements === 1) return wf.stop(`implementer ${outcome.kind}: ${outcome.reason}`);
          replacements++;
          implementer = await wf.agents.open({ key: "implementer#2", runtime: "claude" });
          return implement(handover(task, open), open);
        }
        default:
          // unanswered, blocked or cancelled: say why, and leave the run to be continued.
          return wf.stop(`implementer ${outcome.kind}: ${outcome.reason}`);
      }
    }
    // #endregion branch

    // #region loop
    let open: string[] = [];
    let done = await implement(`Implement this task: ${task}`, open);
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const { outcome } = await reviewer.run<Verdict>({
        prompt:
          round === 1
            ? `Review the uncommitted change for this task: ${task}\nIts author says: ${done.summary}`
            : `The author says it addressed your findings: ${done.summary}\nCheck each one, then the rest of the change.`,
        schema: VERDICT,
        timeoutMs: TURN_MS,
      });
      if (!isAnswered(outcome)) return wf.stop(`reviewer ${outcome.kind}: ${outcome.reason}`);
      if (outcome.value.approved) return { approved: true, rounds: round };

      open = outcome.value.findings;
      if (round === MAX_ROUNDS) break;
      done = await implement(`Fix what the reviewer found:\n- ${open.join("\n- ")}`, open);
    }
    return { approved: false, rounds: MAX_ROUNDS, open };
    // #endregion loop
  },
});

/** A fresh agent has no session: everything it needs is in the prompt. */
function handover(task: string, open: string[]): string {
  return [
    `Another agent was working on this task and stopped: ${task}`,
    "Its uncommitted change is in the working tree; read it before you continue.",
    ...(open.length > 0 ? [`A reviewer asked for these fixes:\n- ${open.join("\n- ")}`] : []),
  ].join("\n");
}
