import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

const RECALLED = typed(Type.Object({ working_on: Type.String() }, { additionalProperties: false }));

export type ForkCallerResult = { model: string; workingOn: string };

/**
 * A fork of the session `awf run` was started from, asked what that session was working on: only a
 * copy of its context can say. The session waits on the run and reads the answer as its output.
 */
export const forkCaller = defineWorkflow<null, ForkCallerResult>({
  meta: {
    name: "fork-caller",
    description: "Fork the agent session awf run was started from, and ask the fork what it knows.",
  },
  async run(wf) {
    const fork = await wf.agents.forkCaller({ key: "fork" });
    if (!fork) {
      throw new Error("no session to fork; the run's output says why");
    }
    const { outcome } = await fork.run({
      prompt:
        "In one sentence, what was this session working on just before it ran awf? Answer from what you remember; do not run any commands.",
      schema: RECALLED,
      timeout: "5m",
    });
    if (!outcome.answered) throw new Error(`the fork did not answer: ${outcome.kind}`);
    return { model: fork.execution.model, workingOn: outcome.value.working_on };
  },
  present: (result) => `the fork, on ${result.model}, says the session was: ${result.workingOn}`,
});

export default forkCaller;
