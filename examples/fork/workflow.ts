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
  "claude-headless": {
    harness: "claude",
    model: "claude-sonnet-5-5",
    placement: "headless",
    metered: true,
  },
} as const satisfies Record<string, ExecutionConfig>;

type RuntimeName = keyof typeof RUNTIMES;

export type ForkCase = { runtime: RuntimeName; compact: boolean; into?: AgentPlacement };

export type ForkArgs = { cases: ForkCase[]; vault: string; gate: string };

const NOTED = outputSchema(Type.Object({ noted: Type.Boolean() }, { additionalProperties: false }));
const RECALLED = outputSchema(
  Type.Object({ vault: Type.String(), gate: Type.String() }, { additionalProperties: false }),
);

type Recalled = { vault: string; gate: string };

export type ForkCheck = {
  name: string;
  /** What the fork recalled: the vault code from its parent, and not the gate code told after. */
  fork?: Recalled;
  /** What the worker recalled: both. */
  worker?: Recalled;
  problem?: string;
};

const MINUTE = 60_000;
const RECALL =
  "Without running any command or reading any file: what is the vault code, and what is the gate code? Answer unknown for what you do not know.";

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
            `Remember this for later: the vault code is ${args.vault}. Answer noted: true.`,
          );
          if (problem) return { name, problem };
          if (item.compact) {
            const compacted = await worker.compact({
              prompt: "Keep the vault code.",
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
            `Remember this too: the gate code is ${args.gate}. Answer noted: true.`,
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
          : `${check.name}: the fork recalled ${check.fork?.vault} and ${check.fork?.gate}, the worker ${check.worker?.vault} and ${check.worker?.gate}`,
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
  return { cases, vault: `V-${code()}`, gate: `G-${code()}` };
}

export const fork = executable.definition;
export default executable;
