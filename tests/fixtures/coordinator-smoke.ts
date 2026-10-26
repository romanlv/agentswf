import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type OutputSchema,
} from "../../packages/contract/src/workflow";

/**
 * Story 032's coordinator smoke. Each investigator reports to a coordinator outside the run, then
 * asks it for a codeword with `wf send --await-reply` and ends its turn; the coordinator's answer
 * continues the same call, which returns what it was told. Headless, one agent per harness.
 */
const HEADLESS = {
  claude: { harness: "claude", model: "claude-sonnet-5-5", placement: "headless", metered: true },
  codex: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
  pi: { harness: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", placement: "headless" },
} satisfies Record<string, ExecutionConfig>;
export const HEADLESS_NAMES = ["claude", "codex"];

/** What only the coordinator knows: the answer comes only through it. */
export const CODEWORD = "OSPREY-5120";

const ANSWER: OutputSchema<{ codeword: string }> = {
  type: "object",
  properties: { codeword: { type: "string" } },
  required: ["codeword"],
  additionalProperties: false,
};

export type CoordinatorSmokeResult = { runtime: string; outcome: string; codeword?: string }[];

/** `--timeout-ms {n}` bounds each investigator's operation, which a late answer outlasts. */
export default defineExecutableWorkflow<
  { runtimes: string[]; timeoutMs: number },
  CoordinatorSmokeResult
>({
  definition: {
    meta: {
      name: "coordinator-smoke",
      description: "Agents report to a coordinator outside the run and ask it for a codeword.",
    },
    async run(workflow, { runtimes, timeoutMs }) {
      const coordinator = await workflow.participants.connect({
        key: "coordinator",
        labels: { audience: "eval" },
      });
      return workflow.parallel(runtimes, async (runtime) => {
        const investigator = await workflow.agents.open({
          key: `investigator:${runtime}`,
          runtime: HEADLESS[runtime as keyof typeof HEADLESS],
        });
        await workflow.messages.allow({
          between: [investigator, coordinator],
          purpose: "Report what you find; ask the coordinator what only it knows.",
          timeoutMs: 5 * 60_000,
        });
        const { outcome } = await investigator.run({
          prompt: [
            "A coordinator outside this run keeps a codeword you need.",
            "First send it a one-line report that you are starting, without waiting for an answer.",
            "Then ask it for the codeword, waiting for its reply, and return the codeword it gives you. Do not guess it.",
          ].join(" "),
          schema: ANSWER,
          timeoutMs,
        });
        return isAnswered(outcome)
          ? { runtime, outcome: outcome.kind, codeword: outcome.value.codeword }
          : { runtime, outcome: `${outcome.kind}: ${outcome.reason}` };
      });
    },
  },
  prepare({ argv }) {
    const at = argv.indexOf("--timeout-ms");
    const timeoutMs = at < 0 ? 5 * 60_000 : Number(argv[at + 1]);
    const given = at < 0 ? argv : argv.filter((_, index) => index !== at && index !== at + 1);
    const names = given.length === 0 ? HEADLESS_NAMES : given;
    for (const name of names) {
      if (!Object.hasOwn(HEADLESS, name))
        throw new Error(`unknown runtime ${name}; expected ${Object.keys(HEADLESS).join(", ")}`);
    }
    return { runtimes: [...names], timeoutMs };
  },
});
