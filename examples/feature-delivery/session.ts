// This workflow's own helper, not awf's API: copy it and change it.
import type { AgentRef, JsonValue, OutputSchema, WorkflowContext } from "agentswf/workflow";

export type Session = ReturnType<typeof session>;

/** An agent whose turns answer or stop the run; a stop it causes carries its name. */
export function session(wf: WorkflowContext, agent: AgentRef, name: string = agent.key) {
  const stop = (reason: string): never => wf.stop(`${name}: ${reason}`);
  return {
    agent,
    stop,
    async ask<T extends JsonValue>(
      schema: OutputSchema<T>,
      turn: { label: string; prompt: string },
    ): Promise<T> {
      const { outcome } = await agent.run({ schema, ...turn });
      return outcome.answered ? outcome.value : stop(outcome.reason);
    },
  };
}
