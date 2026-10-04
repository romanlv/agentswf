import {
  type AgentExecution,
  defineExecutableWorkflow,
  type Effort,
  type ExecutionConfig,
  isAnswered,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/**
 * Every harness and placement that switches, on cheap models: each opens at one effort, is set to
 * another, then to another model, and is asked between them. claude switches to opus rather than
 * haiku, which takes no effort and would show none. cursor is left out: any cursor run on
 * another model rewrites the operator's `~/.cursor/cli-config.json` (story 020, M3).
 */
export const RUNTIMES = {
  claude: {
    execution: { harness: "claude", model: "claude-sonnet-5-5", effort: "low" },
    switched: { effort: "high", model: "claude-opus-5-5" },
  },
  "claude-headless": {
    execution: {
      harness: "claude",
      model: "claude-sonnet-5-5",
      effort: "low",
      placement: "headless",
      metered: true,
    },
    switched: { effort: "high", model: "claude-opus-5-5" },
  },
  codex: {
    execution: { harness: "codex", model: "gpt-6-luna", effort: "low" },
    switched: { effort: "high", model: "gpt-5.6-luna" },
  },
  "codex-headless": {
    execution: { harness: "codex", model: "gpt-6-luna", effort: "low", placement: "headless" },
    switched: { effort: "high", model: "gpt-5.6-luna" },
  },
  pi: {
    execution: { harness: "pi", model: "openai-codex/gpt-5.6-terra", effort: "low" },
    switched: { effort: "high", model: "openai-codex/gpt-5.6-luna" },
  },
  "pi-headless": {
    execution: {
      harness: "pi",
      model: "openai-codex/gpt-5.6-terra",
      effort: "low",
      placement: "headless",
    },
    switched: { effort: "high", model: "openai-codex/gpt-5.6-luna" },
  },
} as const satisfies Record<
  string,
  { execution: ExecutionConfig; switched: { effort: Effort; model: string } }
>;

type RuntimeName = keyof typeof RUNTIMES;

const ANSWER = outputSchema(
  Type.Object({ word: Type.String(), shell: Type.String() }, { additionalProperties: false }),
);

export type EffortArgs = { runtimes: RuntimeName[]; word: string };

/** One operation of a check, as its record says it ran. */
export type EffortStep = {
  /** `turn` or `set`. */
  kind: string;
  outcome: string;
  execution: AgentExecution;
  sessions: string[];
  /** A turn's answer: the word it gave, and what its shell said of its model and level. */
  word?: string;
  shell?: string;
};

export type EffortCheck = { runtime: RuntimeName; steps: EffortStep[]; problem?: string };

export type EffortResult = { word: string; checks: EffortCheck[] };

const MINUTE = 60_000;
/** pi names its model and level to its shell; elsewhere the line comes back empty. */
const SHELL = 'Run `echo "$PI_MODEL $PI_REASONING_LEVEL"` and give its output as `shell`.';

const executable = defineExecutableWorkflow<EffortArgs, EffortResult>({
  definition: {
    meta: {
      name: "effort",
      description: "Open one agent per harness at an effort, switch its effort, then its model.",
      whenToUse:
        "Use to check that each harness runs at the effort and model awf sets, and that set switches them in the same session.",
    },
    async run(workflow, args) {
      const checks = await workflow.parallel(
        args.runtimes,
        async (runtime): Promise<EffortCheck> => {
          const { execution, switched: then } = RUNTIMES[runtime];
          const agent = await workflow.agents.open({
            key: `effort:${runtime}`,
            runtime: execution,
          });
          const steps: EffortStep[] = [];
          const ask = async (prompt: string) => {
            const { outcome } = await agent.run({
              prompt: `${prompt} ${SHELL}`,
              schema: ANSWER,
              timeoutMs: 4 * MINUTE,
            });
            steps.push({
              kind: "turn",
              outcome: outcome.kind,
              execution: outcome.usage.execution,
              sessions: outcome.usage.sessions.map(({ id }) => id),
              ...(isAnswered(outcome) ? outcome.value : {}),
            });
            return isAnswered(outcome) ? undefined : `${outcome.kind}: ${outcome.reason}`;
          };
          const set = async (spec: { effort?: Effort; model?: string }) => {
            const outcome = await agent.set({ ...spec, timeoutMs: 3 * MINUTE });
            steps.push({
              kind: "set",
              outcome: outcome.kind,
              execution: outcome.usage.execution,
              sessions: outcome.usage.sessions.map(({ id }) => id),
            });
            return isAnswered(outcome) ? undefined : `set ${outcome.kind}: ${outcome.reason}`;
          };
          const problem =
            (await ask(`Remember this word for later: ${args.word}. Answer it as \`word\`.`)) ??
            (await set({ effort: then.effort })) ??
            (await ask("Answer `word` with the word ok.")) ??
            (await set({ model: then.model })) ??
            (await ask(
              "Without running any other command or reading any file: what word were you told to remember? Answer it as `word`, or unknown.",
            ));
          return { runtime, steps, ...(problem ? { problem } : {}) };
        },
        { label: "Effort" },
      );
      return { word: args.word, checks };
    },
  },
  prepare: parseArgs,
  present: ({ checks }) =>
    checks
      .map(
        (check) =>
          `${check.runtime}: ${check.steps
            .map(
              (step) =>
                `${step.kind} ${step.outcome} ${step.execution.model}@${step.execution.effort ?? "-"}`,
            )
            .join(", ")}${check.problem ? ` (${check.problem})` : ""}`,
      )
      .join("\n"),
});

function parseArgs(invocation: WorkflowInvocation): EffortArgs {
  const names = invocation.argv.length === 0 ? Object.keys(RUNTIMES) : invocation.argv;
  for (const name of names) {
    if (!Object.hasOwn(RUNTIMES, name)) {
      throw new Error(`unknown runtime ${name}; expected ${Object.keys(RUNTIMES).join(", ")}`);
    }
  }
  if (new Set(names).size !== names.length) throw new Error("name each runtime once");
  const words = ["pelican", "lantern", "quarry", "saffron"];
  return {
    runtimes: names as RuntimeName[],
    word: words[Math.floor(Math.random() * words.length)]!,
  };
}

export const effort = executable.definition;
export default executable;
