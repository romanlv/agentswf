import {
  defineWorkflow,
  type ExecutionConfig,
  type OutputSchema,
  type WorkflowInvocation,
} from "../../packages/contract/src/workflow";

/**
 * Many TUI agents at once (story concurrent-agents): every agent prompted together, twice, the
 * second turn needing the first's context, so each turn must start, end and be released in its own
 * pane while the rest are busy. `codex=12 claude=6 cursor=4` names how many of each.
 */
const RUNTIMES = {
  codex: { harness: "codex", model: "gpt-6-luna" },
  claude: { harness: "claude", model: "claude-sonnet-5-5" },
  cursor: { harness: "cursor", model: "composer-2.5" },
} satisfies Record<string, ExecutionConfig>;
type Runtime = keyof typeof RUNTIMES;

const ANSWER: OutputSchema<{ answer: number }> = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
  additionalProperties: false,
};

export type FanOutAnswer = {
  agent: string;
  expected: number[];
  answers: number[];
  outcomes: string[];
  reasons: string[];
};

export default defineWorkflow<{ agents: { runtime: Runtime; index: number }[] }, FanOutAnswer[]>({
  meta: {
    name: "fan-out",
    description: "Prompt many TUI agents at once, twice each, with answers known.",
  },
  async run(wf, { agents }) {
    return wf.parallel(agents, async ({ runtime, index }) => {
      const key = `fan-${runtime}-${index}`;
      const agent = await wf.agents.open({ key, runtime: RUNTIMES[runtime] });
      const base = 101 + index;
      const steps = [
        {
          prompt: `What is ${base} multiplied by 7? Work it out yourself; do not run any code.`,
          expected: base * 7,
        },
        {
          prompt: "Add 9 to the number you gave in your last answer. Do not run any code.",
          expected: base * 7 + 9,
        },
      ];
      const result: FanOutAnswer = {
        agent: key,
        expected: steps.map((step) => step.expected),
        answers: [],
        outcomes: [],
        reasons: [],
      };
      for (const step of steps) {
        const { outcome } = await agent.run({ prompt: step.prompt, schema: ANSWER, timeout: "4m" });
        result.outcomes.push(outcome.kind);
        if (!outcome.answered) {
          result.reasons.push(outcome.reason);
          break;
        }
        result.answers.push(outcome.value.answer);
      }
      return result;
    });
  },
  prepare(invocation: WorkflowInvocation) {
    const counts =
      invocation.argv.length > 0 ? invocation.argv : ["codex=12", "claude=6", "cursor=4"];
    const agents: { runtime: Runtime; index: number }[] = [];
    for (const count of counts) {
      const [runtime, n] = count.split("=");
      if (
        !runtime ||
        !Object.hasOwn(RUNTIMES, runtime) ||
        !n ||
        !Number.isInteger(Number(n)) ||
        Number(n) < 1
      ) {
        throw new Error(`expected {runtime}={count}, runtime one of ${Object.keys(RUNTIMES)}`);
      }
      for (let index = 0; index < Number(n); index++) {
        agents.push({ runtime: runtime as Runtime, index });
      }
    }
    return { agents };
  },
});
