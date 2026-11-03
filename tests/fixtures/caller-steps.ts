import {
  defineWorkflow,
  type OutputSchema,
} from "../../packages/contract/src/workflow";

/**
 * The calling-session eval's steps: a number picked, a long step the eval interrupts, and the number
 * recalled, so the session is shown to go on after its operator stopped a step.
 */
const PICKED: OutputSchema<{ number: number }> = {
  type: "object",
  properties: { number: { type: "integer", minimum: 1000, maximum: 9999 } },
  required: ["number"],
  additionalProperties: false,
};
const RECALLED: OutputSchema<{ number: number }> = {
  type: "object",
  properties: { number: { type: "integer" } },
  required: ["number"],
  additionalProperties: false,
};

export type CallerSteps = {
  harness: string;
  picked?: number;
  /** How the step the eval interrupts ended. */
  interrupted: string;
  recalled?: number;
};

export default defineWorkflow<null, CallerSteps>({
  meta: { name: "caller-steps", description: "The calling-session eval's three steps." },
  async run(wf) {
    const author = await wf.agents.caller({ key: "author" });
    if (!author) throw new Error("start this with awf run --here");
    const timeout = "4m";
    const { outcome: picked } = await author.run({
      prompt: "Pick a whole number between 1000 and 9999 and remember it. Do not run any code to pick it.",
      schema: PICKED,
      timeout,
    });
    const { outcome: slept } = await author.run({
      prompt:
        "Write an essay of at least 1500 words on the history of computer terminals, in your reply itself and without running any tools, then answer with the word written.",
      timeout,
    });
    const { outcome: recalled } = await author.run({
      prompt: "The previous essay step was cancelled. Do not resume or complete it. What number did you pick two steps ago? Answer from memory using wfa result, then end your turn immediately. No other work.",
      schema: RECALLED,
      timeout,
    });
    return {
      harness: author.execution.harness,
      ...(picked.answered ? { picked: picked.value.number } : {}),
      interrupted: slept.kind,
      ...(recalled.answered ? { recalled: recalled.value.number } : {}),
    };
  },
  prepare: () => null,
});
