import { defineWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";

export const PLAN = Type.Object(
  { doc: Type.String() },
  { additionalProperties: false },
);
export const BUILT = Type.Object(
  { branch: Type.String(), summary: Type.String() },
  { additionalProperties: false },
);
type Plan = Type.Static<typeof PLAN>;
type Built = Type.Static<typeof BUILT>;

export default defineWorkflow({
  meta: {
    name: "ship-ticket",
    description: "Plan a ticket, then build it.",
    version: "1.0.0",
  },
  prepare: ({ argv }) => ({ ticket: argv[0] ?? "" }),
  id: ({ ticket }) => ticket, // the run's id: one run per ticket
  async run(wf, { ticket }: { ticket: string }) {
    const plan = await wf.stage(
      "plan",
      { result: PLAN, summary: (p) => p.doc },
      async () => {
        const planner = await wf.agents.open({
          key: "planner",
          runtime: "claude",
        });
        const { outcome } = await planner.run<Plan>({
          prompt: `Write an implementation plan for ${ticket} in docs/${ticket}.md.`,
          schema: PLAN,
        });
        if (!isAnswered(outcome)) return wf.stop(`planner: ${outcome.reason}`);
        return outcome.value;
      },
    );

    return wf.stage(
      "build",
      { result: BUILT, summary: (b) => b.branch },
      async () => {
        const builder = await wf.agents.open({
          key: "builder",
          runtime: "codex",
        });
        const { outcome } = await builder.run<Built>({
          // A fresh agent: the prompt names the plan.
          prompt: `Implement ${plan.doc} on a new branch.`,
          schema: BUILT,
        });
        if (!isAnswered(outcome)) return wf.stop(`builder: ${outcome.reason}`);
        return outcome.value;
      },
    );
  },
});
