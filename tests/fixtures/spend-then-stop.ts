import {
  defineWorkflow,
  type OutputSchema,
} from "../../packages/contract/src/workflow";

/**
 * One headless codex agent answers a question, so the run has spent something, and then the run
 * ends badly: `crash` throws, `cancel` starts a long second turn for the caller to interrupt.
 */
type Mode = "crash" | "cancel";

const ANSWER: OutputSchema<{ answer: number }> = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
  additionalProperties: false,
};

export default defineWorkflow<{ mode: Mode }, null>({
  meta: {
    name: "spend-then-stop",
    description: "Spend on one agent, then fail or wait to be cancelled.",
  },
  async run(wf, { mode }) {
    const agent = await wf.agents.open({
      key: "spender",
      runtime: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
    });
    const first = await agent.run({
      prompt: "What is 17 multiplied by 23? Work it out yourself; do not run any code.",
      schema: ANSWER,
      timeout: "3m",
    });
    if (!first.outcome.answered) throw new Error(`no first answer: ${first.outcome.reason}`);
    wf.log("answered");
    if (mode === "crash") throw new Error("variant crashed after spending");
    await agent.run({
      prompt:
        "Write out every integer from 1 to 2000 in English words, one per line, then answer 0. Do not run any code.",
      schema: ANSWER,
      timeout: "3m",
    });
    throw new Error("the second turn finished before the eval cancelled the run");
  },
  prepare({ argv }) {
    const [mode] = argv;
    if (mode !== "crash" && mode !== "cancel") throw new Error("expected crash or cancel");
    return { mode };
  },
});
