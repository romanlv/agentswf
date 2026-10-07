import { defineExecutableWorkflow, isAnswered } from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

const RECALLED = outputSchema(
  Type.Object({ working_on: Type.String() }, { additionalProperties: false }),
);

export type ForkCallerResult = { model: string; workingOn: string };

/**
 * A fork of the session `awf run` was started from, asked what that session was working on: only a
 * copy of its context can say. The session waits on the run and reads the answer as its output.
 */
const executable = defineExecutableWorkflow<null, ForkCallerResult>({
  definition: {
    meta: {
      name: "fork-caller",
      description:
        "Fork the agent session awf run was started from, and ask the fork what it knows.",
      whenToUse:
        "Use to check forkCaller live: run it with awf run, not --here, from a claude, codex or pi session.",
    },
    async run(workflow) {
      const fork = await workflow.agents.forkCaller({ key: "fork" });
      if (!fork) {
        throw new Error("no session to fork; the run's output says why");
      }
      const { outcome } = await fork.run({
        prompt:
          "In one sentence, what was this session working on just before it ran awf? Answer from what you remember; do not run any commands.",
        schema: RECALLED,
        timeoutMs: 5 * 60_000,
      });
      if (!isAnswered(outcome)) throw new Error(`the fork did not answer: ${outcome.kind}`);
      return { model: fork.execution.model, workingOn: outcome.value.working_on };
    },
  },
  prepare: () => null,
  present: (result) => `the fork, on ${result.model}, says the session was: ${result.workingOn}`,
});

export const forkCaller = executable.definition;
export default executable;
