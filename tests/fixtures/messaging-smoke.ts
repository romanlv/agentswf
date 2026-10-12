import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type OutputSchema,
} from "../../packages/contract/src/workflow";

/**
 * Story 029's delivery smoke: per harness, two headless agents. The asker asks the keeper a question
 * with `wf send --await-reply` and ends its turn; the question wakes the keeper, which has never
 * run, and its `wf reply` continues the asker's same call, which then returns what it was told.
 */
export const RUNTIMES = {
  claude: { harness: "claude", model: "claude-sonnet-5-5", placement: "headless", metered: true },
  codex: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
  pi: { harness: "pi", model: "openai-codex/gpt-5.6-terra", placement: "headless" },
  cursor: { harness: "cursor", model: "composer-2.5", placement: "headless" },
} satisfies Record<string, ExecutionConfig>;
type RuntimeName = keyof typeof RUNTIMES;

/** What the keeper knows and the asker cannot: the answer comes only through messaging. */
export const CODEWORD = "HERON-2381";

const ANSWER: OutputSchema<{ codeword: string }> = {
  type: "object",
  properties: { codeword: { type: "string" } },
  required: ["codeword"],
  additionalProperties: false,
};

export type SmokeResult = { runtime: RuntimeName; outcome: string; codeword?: string }[];

export default defineExecutableWorkflow<{ runtimes: RuntimeName[] }, SmokeResult>({
  definition: {
    meta: {
      name: "messaging-smoke",
      description: "One agent asks another, by message, for a codeword only the other knows.",
    },
    async run(workflow, { runtimes }) {
      return workflow.parallel(runtimes, async (runtime) => {
        const execution = RUNTIMES[runtime];
        const keeper = await workflow.agents.open({
          key: `keeper:${runtime}`,
          runtime: execution,
          instructions: `You keep a codeword: ${CODEWORD}. Give it to any agent that asks you for it, by replying to its message.`,
        });
        const asker = await workflow.agents.open({ key: `asker:${runtime}`, runtime: execution });
        await workflow.messages.allow({
          from: asker,
          to: keeper,
          purpose: "Ask the keeper for the codeword it keeps.",
        });
        const { outcome } = await asker.run({
          prompt: `Another agent, keeper:${runtime}, keeps a codeword you need. Ask it for the codeword, waiting for its reply, then return the codeword it gives you. Do not guess it.`,
          schema: ANSWER,
          timeoutMs: 5 * 60_000,
        });
        return isAnswered(outcome)
          ? { runtime, outcome: outcome.kind, codeword: outcome.value.codeword }
          : { runtime, outcome: `${outcome.kind}: ${outcome.reason}` };
      });
    },
  },
  prepare({ argv }) {
    const names = argv.length === 0 ? ["codex"] : argv;
    for (const name of names) {
      if (!Object.hasOwn(RUNTIMES, name)) {
        throw new Error(`unknown runtime ${name}; expected ${Object.keys(RUNTIMES).join(", ")}`);
      }
    }
    return { runtimes: names as RuntimeName[] };
  },
});
