import type { SkillRef, WorkflowContext } from "agentswf/workflow";
import type { AdditionalReviewer, FeatureArgs, Role } from "./schema";
import { session } from "./session";

const ROLES = {
  planner: {
    instructions:
      "Own the ticket document. Verify current behavior and keep the document implementation-ready.",
    skills: [{ path: new URL("./skills/ticket-doc", import.meta.url) }],
  },
  implementer: {
    instructions: "Implement the approved ticket doc and keep it current as the decision record.",
  },
  reviewer: {
    instructions:
      "Gate both the ticket doc and implementation. Be specific when requesting changes.",
  },
} satisfies Record<Role, { instructions: string; skills?: SkillRef[] }>;

/**
 * Opens the planner and the reviewer, and returns how to open the implementer, not needed until the
 * plan is approved, and each additional reviewer. Each attempt opens its agents afresh.
 */
export async function openTeam(wf: WorkflowContext, args: FeatureArgs) {
  const open = async (role: Role) =>
    session(
      wf,
      await wf.agents.open({
        ...ROLES[role],
        key: role,
        runtime: args.runtimes[role],
      }),
    );

  const planner = await open("planner");
  const reviewer = await open("reviewer");
  if (reviewer.agent.execution.model === planner.agent.execution.model) {
    throw new Error("feature-delivery: the planner and primary reviewer must use different models");
  }
  return {
    planner,
    reviewer,
    implementer: () => open("implementer"),
    additionalReviewer: async ({ name, runtime }: AdditionalReviewer) =>
      session(
        wf,
        await wf.agents.open({
          key: `additional-reviewer-${name}`,
          runtime,
          instructions:
            "Independently review the implementation. Do not defer judgment to prior reviewers.",
        }),
        name,
      ),
  };
}
