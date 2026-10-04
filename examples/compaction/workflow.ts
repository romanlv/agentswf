import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";

/**
 * Every harness and placement, on its cheapest model. pi summarizes only what is older than its
 * last 20k tokens, so its agent is given an inventory to skim after the facts: without it, pi has
 * nothing to compact. A short turn goes between them, because pi takes the turn just before the cut
 * for a split one when an extension logged an entry there, and summarizes that without the focus.
 */
export const RUNTIMES = {
  claude: { execution: { harness: "claude", model: "claude-sonnet-5-5" } },
  "claude-headless": {
    execution: {
      harness: "claude",
      model: "claude-sonnet-5-5",
      placement: "headless",
      metered: true,
    },
  },
  codex: { execution: { harness: "codex", model: "gpt-6-luna" } },
  "codex-headless": {
    execution: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
  },
  pi: {
    execution: { harness: "pi", model: "openai-codex/gpt-5.6-terra", placement: "headless" },
    inventoryLines: 2_000,
  },
  "pi-pane": {
    execution: { harness: "pi", model: "openai-codex/gpt-5.6-terra" },
    inventoryLines: 2_000,
  },
  cursor: { execution: { harness: "cursor", model: "composer-2.5" } },
  "cursor-headless": {
    execution: { harness: "cursor", model: "composer-2.5", placement: "headless" },
  },
} as const satisfies Record<string, { execution: ExecutionConfig; inventoryLines?: number }>;

type RuntimeName = keyof typeof RUNTIMES;

const NOTED = outputSchema(Type.Object({ noted: Type.Boolean() }, { additionalProperties: false }));
const RECALLED = outputSchema(
  Type.Object({ codename: Type.String(), colour: Type.String() }, { additionalProperties: false }),
);

export type CompactionArgs = { runtimes: RuntimeName[]; colour: string; codename: string };

export type CompactionCheck = {
  runtime: RuntimeName;
  /** How the compaction ended; `failed` with its reason where the harness has none. */
  compacted: string;
  reason?: string;
  /** The summary the harness wrote, where it shows one. */
  summary?: string;
  /** What the agent recalled afterwards: the codename was only ever in the compaction's focus. */
  recalled?: { codename: string; colour: string };
  problem?: string;
};

/** The codename and colour the agents were checked against, beside their checks. */
export type CompactionResult = { codename: string; colour: string; checks: CompactionCheck[] };

const MINUTE = 60_000;

const executable = defineExecutableWorkflow<CompactionArgs, CompactionResult>({
  definition: {
    meta: {
      name: "compaction",
      description: "Compact one agent per harness with a focus, then ask what it kept.",
      whenToUse:
        "Use to check that each harness compacts natively, that the focus reaches its compaction, and that the agent goes on afterwards in the same session.",
    },
    async run(workflow, args) {
      const checks = await workflow.parallel(
        args.runtimes,
        async (runtime): Promise<CompactionCheck> => {
          const { execution, ...rest } = RUNTIMES[runtime];
          const agent = await workflow.agents.open({
            key: `compact:${runtime}`,
            runtime: execution,
          });
          const ask = async (prompt: string) => {
            const { outcome } = await agent.run({ prompt, schema: NOTED, timeoutMs: 4 * MINUTE });
            return isAnswered(outcome) ? undefined : `${outcome.kind}: ${outcome.reason}`;
          };
          const problem =
            (await ask(
              `Remember this for later: the shed is ${args.colour}. Answer noted: true.`,
            )) ??
            ("inventoryLines" in rest
              ? ((await ask("Nothing to do this time. Answer noted: true.")) ??
                (await ask(inventory(rest.inventoryLines as number))))
              : undefined);
          if (problem) return { runtime, compacted: "not run", problem };

          const compacted = await agent.compact({
            prompt: `Record in the summary that the project codename is ${args.codename}, and keep the shed's colour.`,
            timeoutMs: 5 * MINUTE,
          });
          const { outcome } = await agent.run({
            prompt:
              "Without running any command or reading any file: what is the project codename, and what colour is the shed? Answer unknown for what you do not know.",
            schema: RECALLED,
            timeoutMs: 4 * MINUTE,
          });
          return {
            runtime,
            compacted: compacted.kind,
            ...(isAnswered(compacted)
              ? { summary: compacted.value }
              : { reason: compacted.reason }),
            ...(isAnswered(outcome)
              ? { recalled: outcome.value }
              : { problem: `${outcome.kind}: ${outcome.reason}` }),
          };
        },
        { label: "Compaction" },
      );
      return { codename: args.codename, colour: args.colour, checks };
    },
  },
  prepare: parseArgs,
  present: (ending) => {
    if (ending.kind !== "completed") return undefined;
    const { checks } = ending.value;
    return checks
      .map(
        (check) =>
          `${check.runtime}: compaction ${check.compacted}${check.reason ? ` (${check.reason})` : ""}, ${
            check.recalled
              ? `then recalled ${check.recalled.codename} and ${check.recalled.colour}`
              : (check.problem ?? "")
          }`,
      )
      .join("\n");
  },
});

/** Filler the agent reads and forgets, so pi has history older than its last 20k tokens. */
function inventory(lines: number): string {
  const rows = Array.from(
    { length: lines },
    (_, i) => `inventory line ${i + 1}: a clay pot, a rake, a bag of soil`,
  );
  return `Skim this inventory; nothing in it matters later. Answer noted: true.\n\n${rows.join("\n")}`;
}

function parseArgs(invocation: WorkflowInvocation): CompactionArgs {
  const names = invocation.argv.length === 0 ? Object.keys(RUNTIMES) : invocation.argv;
  for (const name of names) {
    if (!Object.hasOwn(RUNTIMES, name)) {
      throw new Error(`unknown runtime ${name}; expected ${Object.keys(RUNTIMES).join(", ")}`);
    }
  }
  if (new Set(names).size !== names.length) throw new Error("name each runtime once");
  const colours = ["teal", "amber", "violet", "ochre"];
  return {
    runtimes: names as RuntimeName[],
    colour: colours[Math.floor(Math.random() * colours.length)]!,
    codename: `HERON-${Math.floor(1000 + Math.random() * 9000)}`,
  };
}

export const compaction = executable.definition;
export default executable;
