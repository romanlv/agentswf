import {
  defineWorkflow,
  type ExecutionConfig,
  type OutputSchema,
  type WorkflowInvocation,
} from "../../packages/contract/src/workflow";
import { SCRIPTED_MODELS } from "../../packages/harness/src/testing/scripted-model";

/**
 * One headless agent on the named harness, against the scripted model, asked twice: the second
 * turn is answered right only from the first one's history, so it holds only if the harness
 * resumed the same session.
 */
const RUNTIMES = {
  pi: { harness: "pi", model: SCRIPTED_MODELS.pi, placement: "headless" },
  codex: { harness: "codex", model: SCRIPTED_MODELS.codex, placement: "headless" },
  claude: {
    harness: "claude",
    model: SCRIPTED_MODELS.claude,
    placement: "headless",
    metered: true,
  },
} as const satisfies Record<string, ExecutionConfig>;
type Runtime = keyof typeof RUNTIMES;

const ANSWER: OutputSchema<{ answer: number }> = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
  additionalProperties: false,
};

export const PROMPTS = ["Report the number 17.", "Add 9 to the number you reported."] as const;

export type ScriptedAnswers = { outcomes: string[]; answers: number[]; reasons: string[] };

export default defineWorkflow<Runtime, ScriptedAnswers>({
  meta: { name: "scripted-model", description: "Two turns of one agent on a scripted model." },
  async run(wf, runtime) {
    const agent = await wf.agents.open({ key: runtime, runtime: RUNTIMES[runtime] });
    const result: ScriptedAnswers = { outcomes: [], answers: [], reasons: [] };
    for (const prompt of PROMPTS) {
      const { outcome } = await agent.run({ prompt, schema: ANSWER, timeout: "1m" });
      result.outcomes.push(outcome.kind);
      if (!outcome.answered) {
        result.reasons.push(outcome.reason);
        break;
      }
      result.answers.push(outcome.value.answer);
    }
    return result;
  },
  prepare(invocation: WorkflowInvocation): Runtime {
    const [runtime] = invocation.argv;
    if (!runtime || !Object.hasOwn(RUNTIMES, runtime)) {
      throw new Error(`name one runtime: ${Object.keys(RUNTIMES).join(", ")}`);
    }
    return runtime as Runtime;
  },
});
