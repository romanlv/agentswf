import {
  type AgentPlacement,
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/**
 * Each harness and placement that forks (story 016). A runtime named with
 * `:compact` compacts its worker before the fork, and one named with `>pane` or `>headless` forks
 * into that placement instead of its worker's.
 */
export const RUNTIMES = {
  claude: { harness: "claude", model: "claude-sonnet-5-5" },
  "claude-headless": {
    harness: "claude",
    model: "claude-sonnet-5-5",
    placement: "headless",
    metered: true,
  },
  codex: { harness: "codex", model: "gpt-6-luna" },
  "codex-headless": { harness: "codex", model: "gpt-6-luna", placement: "headless" },
} as const satisfies Record<string, ExecutionConfig>;

type RuntimeName = keyof typeof RUNTIMES;

export type ForkCase = { runtime: RuntimeName; compact: boolean; into?: AgentPlacement };

export type ForkArgs = { cases: ForkCase[]; codename: string; release: string };

const NOTED = outputSchema(Type.Object({ noted: Type.Boolean() }, { additionalProperties: false }));
const RECALLED = outputSchema(
  Type.Object({ codename: Type.String(), release: Type.String() }, { additionalProperties: false }),
);

type Recalled = { codename: string; release: string };

export type ForkCheck = {
  name: string;
  /** What the fork recalled: the codename from its parent, and not the release told after. */
  fork?: Recalled;
  /** What the worker recalled: both. */
  worker?: Recalled;
  problem?: string;
};

const MINUTE = 60_000;
const RECALL =
  "Without running any command or reading any file: what is this project's codename, and what is its next release? Answer unknown for what you do not know.";

const executable = defineExecutableWorkflow<ForkArgs, ForkCheck[]>({
  definition: {
    meta: {
      name: "fork",
      description: "Fork one worker per harness and placement, then ask each what it knows.",
      whenToUse:
        "Use to check that a fork starts from its parent's context, compacted or not, and that neither sees the other's turns after it.",
    },
    run: (workflow, args) =>
      workflow.parallel(
        args.cases,
        async (item): Promise<ForkCheck> => {
          const name = caseName(item);
          const worker = await workflow.agents.open({
            key: `worker:${name}`,
            runtime: RUNTIMES[item.runtime],
          });
          const note = async (prompt: string) => {
            const { outcome } = await worker.run({ prompt, schema: NOTED, timeoutMs: 4 * MINUTE });
            return isAnswered(outcome) ? undefined : `${outcome.kind}: ${outcome.reason}`;
          };
          const recall = async (agent: typeof worker) => {
            const { outcome } = await agent.run({
              prompt: RECALL,
              schema: RECALLED,
              timeoutMs: 4 * MINUTE,
            });
            return isAnswered(outcome) ? outcome.value : `${outcome.kind}: ${outcome.reason}`;
          };
          const problem = await note(
            `For later: this project's codename is ${args.codename}. Answer noted: true.`,
          );
          if (problem) return { name, problem };
          if (item.compact) {
            const compacted = await worker.compact({
              prompt: "Keep the project's codename.",
              timeoutMs: 5 * MINUTE,
            });
            if (!isAnswered(compacted)) {
              return { name, problem: `compaction ${compacted.kind}: ${compacted.reason}` };
            }
          }
          // A fork its host refuses rejects, as an agent that will not open does, and fails the run.
          const fork = await worker.fork({
            key: `fork:${name}`,
            ...(item.into ? { placement: item.into, metered: true } : {}),
          });
          const later = await note(
            `Also for later: its next release is ${args.release}. Answer noted: true.`,
          );
          if (later) return { name, problem: later };
          const [forked, worked] = await Promise.all([recall(fork), recall(worker)]);
          return {
            name,
            ...(typeof forked === "string" ? {} : { fork: forked }),
            ...(typeof worked === "string" ? {} : { worker: worked }),
            ...(typeof forked === "string"
              ? { problem: `fork: ${forked}` }
              : typeof worked === "string"
                ? { problem: `worker: ${worked}` }
                : {}),
          };
        },
        { label: "Forks" },
      ),
  },
  prepare: parseArgs,
  present: (checks) =>
    checks
      .map((check) =>
        check.problem
          ? `${check.name}: ${check.problem}`
          : `${check.name}: the fork recalled ${check.fork?.codename} and ${check.fork?.release}, the worker ${check.worker?.codename} and ${check.worker?.release}`,
      )
      .join("\n"),
});

function caseName(item: ForkCase): string {
  return `${item.runtime}${item.compact ? ":compact" : ""}${item.into ? `>${item.into}` : ""}`;
}

function parseArgs(invocation: WorkflowInvocation): ForkArgs {
  const names = invocation.argv.length === 0 ? Object.keys(RUNTIMES) : invocation.argv;
  const cases = names.map((name): ForkCase => {
    const match = /^([^:>]+)(:compact)?(?:>(pane|headless))?$/.exec(name);
    if (!match || !Object.hasOwn(RUNTIMES, match[1]!)) {
      throw new Error(
        `unknown case ${name}; expected a runtime, ${Object.keys(RUNTIMES).join(", ")}, with :compact or >pane or >headless`,
      );
    }
    return {
      runtime: match[1] as RuntimeName,
      compact: match[2] !== undefined,
      ...(match[3] ? { into: match[3] as AgentPlacement } : {}),
    };
  });
  if (new Set(cases.map(caseName)).size !== cases.length) throw new Error("name each case once");
  const code = () => `${Math.floor(1000 + Math.random() * 9000)}`;
  return { cases, codename: `HERON-${code()}`, release: `R${code()}` };
}

export const fork = executable.definition;
export default executable;
