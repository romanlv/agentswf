import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/** The agent the calling session's number is checked by: cheap, and headless so it opens no tab. */
const HELPER: ExecutionConfig = { harness: "codex", model: "gpt-6-luna", placement: "headless" };

const PICKED = outputSchema(
  Type.Object(
    { number: Type.Integer({ minimum: 1000, maximum: 9999 }) },
    { additionalProperties: false },
  ),
);
const DOUBLED = outputSchema(
  Type.Object({ answer: Type.Integer() }, { additionalProperties: false }),
);
const RECALLED = outputSchema(
  Type.Object({ number: Type.Integer(), agrees: Type.Boolean() }, { additionalProperties: false }),
);

export type CallingSessionArgs = { helper: boolean };

export type CallingSessionResult = {
  harness: string;
  picked: number;
  doubled?: number;
  recalled: number;
  agrees: boolean;
};

const executable = defineExecutableWorkflow<CallingSessionArgs, CallingSessionResult>({
  definition: {
    meta: {
      name: "calling-session",
      description:
        "Drive the session awf run --here was started from through dependent steps, with a second agent checking its work.",
      whenToUse:
        "Use to check that a session can be taken over: run it with awf run --here from claude, codex, pi or cursor in a Herdr pane.",
    },
    async run(workflow, args) {
      const author = await workflow.agents.caller({ key: "author" });
      if (!author) {
        throw new Error(
          "no calling session: start this workflow with awf run --here from an agent",
        );
      }
      const steps = { timeoutMs: 5 * 60_000 };
      const { outcome: picked } = await author.run({
        prompt:
          "Pick a whole number between 1000 and 9999 and remember it; a later step asks for it. Do not run any code to pick it.",
        schema: PICKED,
        ...steps,
      });
      if (!isAnswered(picked)) throw new Error(`no number: ${picked.kind}`);
      const { number } = picked.value;
      let doubled: number | undefined;
      if (args.helper) {
        const helper = await workflow.agents.open({ key: "helper", runtime: HELPER });
        const { outcome } = await helper.run({
          prompt: `What is ${number} multiplied by 2? Work it out yourself; do not run any code.`,
          schema: DOUBLED,
          ...steps,
        });
        if (isAnswered(outcome)) doubled = outcome.value.answer;
      }
      const { outcome: recalled } = await author.run({
        prompt: [
          "What number did you pick a step ago? Answer from memory.",
          doubled === undefined
            ? "Set agrees to true."
            : `Another agent says it doubles to ${doubled}; set agrees to whether that is right.`,
        ].join(" "),
        schema: RECALLED,
        ...steps,
      });
      if (!isAnswered(recalled)) throw new Error(`no recall: ${recalled.kind}`);
      return {
        harness: author.execution.harness,
        picked: number,
        ...(doubled === undefined ? {} : { doubled }),
        recalled: recalled.value.number,
        agrees: recalled.value.agrees,
      };
    },
  },
  prepare: parseArgs,
  present: (ending) => {
    if (ending.kind !== "completed") return undefined;
    const result = ending.value;
    return [
      `${result.harness}: picked ${result.picked}, recalled ${result.recalled} (${result.picked === result.recalled ? "right" : "wrong"})`,
      ...(result.doubled === undefined
        ? []
        : [
            `helper doubled it to ${result.doubled}; the session ${result.agrees ? "agrees" : "disagrees"}`,
          ]),
    ].join("\n");
  },
});

function parseArgs(invocation: WorkflowInvocation): CallingSessionArgs {
  const [first, ...rest] = invocation.argv;
  if (rest.length > 0 || (first !== undefined && first !== "--no-helper")) {
    throw new Error("the only argument is --no-helper");
  }
  return { helper: first === undefined };
}

export const callingSession = executable.definition;
export default executable;
