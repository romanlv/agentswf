import { defineWorkflow, type ExecutionConfig } from "agentswf/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/** Cheap, and in its TUI, whose pane is what is being placed. */
const RUNTIME: ExecutionConfig = { harness: "codex", model: "gpt-6-luna" };

const NAMED = outputSchema(Type.Object({ name: Type.String() }, { additionalProperties: false }));

export type PaneLayoutResult = { answered: string[] };

/**
 * The design's picture (docs/design/pane-layout.md): a lead in a tab of its own, brought to the
 * front, and two reviewers stacked right of it, each forked from the lead. Where the tab opens and
 * whether the panes stay are the operator's: `awf run examples/pane-layout/workflow.ts --workspace
 * origin --keep-panes always`.
 */
export const paneLayout = defineWorkflow<null, PaneLayoutResult>({
  meta: {
    name: "pane-layout",
    description:
      "Place a lead and two reviewers in one tab, two columns with the right one stacked, the lead in front.",
  },
  async run(wf) {
    const steps = { timeout: "5m" } as const;
    const ask = {
      prompt: "Reply with your name: one word you make up. Do not run any code.",
      schema: NAMED,
      ...steps,
    };
    const lead = await wf.agents.open({
      key: "lead",
      runtime: RUNTIME,
      pane: { tab: "review", front: true },
    });
    const first = await lead.run(ask);
    if (!first.outcome.answered) throw new Error(`the lead did not answer: ${first.outcome.kind}`);
    const security = await lead.fork({
      key: "security",
      pane: { beside: "lead", side: "right" },
    });
    const style = await lead.fork({
      key: "style",
      pane: { beside: "security", side: "below" },
    });
    const answers = await wf.parallel([security, style], (agent) => agent.run(ask));
    return {
      answered: [first, ...answers].flatMap(({ outcome }) =>
        outcome.answered ? [outcome.value.name] : [],
      ),
    };
  },
});

export default paneLayout;
