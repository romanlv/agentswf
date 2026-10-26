import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type OutputSchema,
} from "../../packages/contract/src/workflow";

/**
 * Story 029's delivery smoke. The asker asks the keeper a question with `wf send --await-reply` and
 * ends its turn; the question wakes the keeper, which has never run, and its `wf reply` continues
 * the asker's same call, which then returns what it was told. Headless, both agents run one
 * harness. In a pane, the keeper is the pane; a claude asker waits in its pane too, where the others
 * cannot wait and ask from headless.
 */
const HEADLESS = {
  claude: { harness: "claude", model: "claude-sonnet-5-5", placement: "headless", metered: true },
  codex: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
  pi: { harness: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", placement: "headless" },
  cursor: { harness: "cursor", model: "composer-2.5", placement: "headless" },
} satisfies Record<string, ExecutionConfig>;
const pane = (execution: ExecutionConfig): ExecutionConfig => {
  const { placement: _placement, metered: _metered, ...rest } = execution;
  return rest;
};
type Pair = { asker: ExecutionConfig; keeper: ExecutionConfig };
export const HEADLESS_NAMES = Object.keys(HEADLESS);
export const RUNTIMES: Record<string, Pair> = {
  ...Object.fromEntries(
    Object.entries(HEADLESS).map(([name, execution]) => [name, { asker: execution, keeper: execution }]),
  ),
  "claude-pane": { asker: pane(HEADLESS.claude), keeper: pane(HEADLESS.claude) },
  "codex-pane": { asker: HEADLESS.codex, keeper: pane(HEADLESS.codex) },
  "pi-pane": { asker: HEADLESS.pi, keeper: pane(HEADLESS.pi) },
  "cursor-pane": { asker: HEADLESS.cursor, keeper: pane(HEADLESS.cursor) },
};
type RuntimeName = string;

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
        const { asker: askerRuntime, keeper: keeperRuntime } = RUNTIMES[runtime]!;
        const keeper = await workflow.agents.open({
          key: `keeper:${runtime}`,
          runtime: keeperRuntime,
          instructions: `You keep a codeword: ${CODEWORD}. Give it to any agent that asks you for it, by replying to its message.`,
        });
        const asker = await workflow.agents.open({
          key: `asker:${runtime}`,
          runtime: askerRuntime,
        });
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
