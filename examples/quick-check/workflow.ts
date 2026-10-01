import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type JsonValue,
  type TurnOutcome,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/**
 * A cheap model for each, so a check costs cents. Codex and pi run headless, and pi in a pane as
 * well; claude stays in a pane, because headless it is billed per token even on a subscription.
 */
export const RUNTIMES = {
  codex: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
  pi: { harness: "pi", model: "openai-codex/gpt-5.6-terra", placement: "headless" },
  "pi-pane": { harness: "pi", model: "openai-codex/gpt-5.6-terra" },
  claude: { harness: "claude", model: "claude-haiku-4-5" },
} as const satisfies Record<string, ExecutionConfig>;

type RuntimeName = keyof typeof RUNTIMES;

const ANSWER_SCHEMA = outputSchema(
  Type.Object({ answer: Type.Integer() }, { additionalProperties: false }),
);
/**
 * The follow-up names no number, so only an agent that kept the first question's context can get it
 * right: a headless agent's resumed session, or a pane agent's same pane.
 */
const QUESTIONS = [
  {
    prompt: "What is 17 multiplied by 23? Work it out yourself; do not run any code.",
    expected: 17 * 23,
  },
  {
    prompt: "Add 9 to the number you gave in your last answer. Do not run any code.",
    expected: 17 * 23 + 9,
  },
] as const;

export type QuickCheckArgs = { runtimes: RuntimeName[] };

export type QuickAnswer = {
  outcome: TurnOutcome<JsonValue>["kind"];
  expected: number;
  answer?: number;
  reason?: string;
};

export type QuickCheck = { runtime: RuntimeName; answers: QuickAnswer[] };

export type QuickCheckResult = { checks: QuickCheck[] };

const executable = defineExecutableWorkflow<QuickCheckArgs, QuickCheckResult>({
  definition: {
    meta: {
      name: "quick-check",
      description: "Ask one agent per runtime questions with known answers.",
      whenToUse:
        "Use to smoke-test a harness, its result channel, a follow-up in the same session, and the run's accounting, for a few cents.",
    },
    async run(workflow, args) {
      const checks = await workflow.parallel(
        args.runtimes,
        async (runtime): Promise<QuickCheck> => {
          const execution: ExecutionConfig = RUNTIMES[runtime];
          const agent = await workflow.agents.open({ key: `check:${runtime}`, runtime: execution });
          const answers: QuickAnswer[] = [];
          for (const { prompt, expected } of QUESTIONS) {
            const { outcome } = await agent.run({
              prompt,
              schema: ANSWER_SCHEMA,
              timeoutMs: 3 * 60_000,
            });
            if (!isAnswered(outcome)) {
              answers.push({ outcome: outcome.kind, expected, reason: outcome.reason });
              break;
            }
            answers.push({ outcome: outcome.kind, expected, answer: outcome.value.answer });
          }
          return { runtime, answers };
        },
        { label: "Quick check" },
      );
      return { checks };
    },
  },
  prepare: parseRuntimes,
  present: ({ checks }) =>
    checks
      .map(
        ({ runtime, answers }) =>
          `${runtime}: ${answers
            .map((step) =>
              step.answer === undefined
                ? `${step.outcome}: ${step.reason}`
                : `${step.answer === step.expected ? "right" : "wrong"} (${step.answer})`,
            )
            .join(", then ")}`,
      )
      .join("\n"),
});

function parseRuntimes(invocation: WorkflowInvocation): QuickCheckArgs {
  const names = invocation.argv.length === 0 ? ["codex"] : invocation.argv;
  for (const name of names) {
    if (!Object.hasOwn(RUNTIMES, name)) {
      throw new Error(`unknown runtime ${name}; expected ${Object.keys(RUNTIMES).join(", ")}`);
    }
  }
  if (new Set(names).size !== names.length) throw new Error("name each runtime once");
  return { runtimes: names as RuntimeName[] };
}

export const quickCheck = executable.definition;
export default executable;
