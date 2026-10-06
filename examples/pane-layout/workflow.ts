import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type PaneWorkspace,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/** Cheap, and in a pane, which is what is being placed. */
const RUNTIME: ExecutionConfig = { harness: "codex", model: "gpt-6-luna" };

const NAMED = outputSchema(Type.Object({ name: Type.String() }, { additionalProperties: false }));

export type PaneLayoutArgs = { workspace: PaneWorkspace };

export type PaneLayoutResult = { answered: string[] };

/**
 * The design's picture (docs/design/pane-layout.md): a lead in a tab of its own, two reviewers
 * stacked right of it, each forked from the lead. The lead's pane is kept once the run ends.
 */
const executable = defineExecutableWorkflow<PaneLayoutArgs, PaneLayoutResult>({
  definition: {
    meta: {
      name: "pane-layout",
      description:
        "Place a lead and two reviewers in one tab, two columns with the right one stacked, and keep the lead's pane.",
      whenToUse:
        'Use to see pane layout live: run it from a Herdr pane, and its tab opens there ("origin"), or pass run or a workspace name.',
    },
    async run(workflow, args) {
      const steps = { timeoutMs: 5 * 60_000 };
      const ask = {
        prompt: "Reply with your name: one word you make up. Do not run any code.",
        schema: NAMED,
        ...steps,
      };
      const lead = await workflow.agents.open({
        key: "lead",
        runtime: RUNTIME,
        layout: { workspace: args.workspace, tab: "review" },
        keepPane: "always",
      });
      const first = await lead.run(ask);
      if (!isAnswered(first.outcome))
        throw new Error(`the lead did not answer: ${first.outcome.kind}`);
      const security = await lead.fork({
        key: "security",
        layout: { beside: "lead", side: "right" },
      });
      const style = await lead.fork({
        key: "style",
        layout: { beside: "security", side: "below" },
      });
      const answers = await workflow.parallel([security, style], (agent) => agent.run(ask));
      return {
        answered: [first, ...answers].flatMap(({ outcome }) =>
          isAnswered(outcome) ? [outcome.value.name] : [],
        ),
      };
    },
  },
  prepare: parseArgs,
});

function parseArgs(invocation: WorkflowInvocation): PaneLayoutArgs {
  const [where, ...rest] = invocation.argv;
  if (rest.length > 0) throw new Error("the only argument is where the lead's tab opens");
  if (where === undefined || where === "origin") return { workspace: "origin" };
  if (where === "run") return { workspace: "run" };
  return { workspace: { name: where } };
}

export const paneLayout = executable.definition;
export default executable;
