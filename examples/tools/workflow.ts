import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type JsonValue,
  type TurnOutcome,
  tool,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";
import { RUNTIMES as QUICK } from "../quick-check/workflow";

/** quick-check's cheap models, and a codex pane: every harness in a pane, and all but claude headless. */
export const RUNTIMES = {
  ...QUICK,
  "codex-pane": { harness: "codex", model: "gpt-6-luna" },
} as const satisfies Record<string, ExecutionConfig>;

type RuntimeName = keyof typeof RUNTIMES;

/** The backlog each agent works through; only its tools change it. */
export type Item = {
  id: string;
  title: string;
  status: "open" | "done" | "wontfix";
  why?: string;
  labels?: string[];
};

export const ITEMS: readonly Pick<Item, "id" | "title">[] = [
  { id: "a1", title: "The login page shows the old logo" },
  { id: "b2", title: "Nightly backup fails on Sundays; cron wrote '$HOME/backup' unexpanded" },
];

/** Taught as flags: strings and an enum. */
const CloseInput = outputSchema(
  Type.Object({
    id: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("done"), Type.Literal("wontfix")]),
    why: Type.String({ minLength: 1 }),
  }),
);

/** Taught as JSON: a list isn't a flag. */
const LabelInput = outputSchema(
  Type.Object({ id: Type.String({ minLength: 1 }), labels: Type.Array(Type.String()) }),
);

export const Summary = outputSchema(
  Type.Object({ closed: Type.Integer({ minimum: 0 }), summary: Type.String({ minLength: 1 }) }),
);

export type ToolsArgs = {
  runtimes: RuntimeName[];
  /** How long `list_open` takes, to check a call past a harness's own limit for a shell command. */
  slowMs?: number;
};

export type Triage = {
  runtime: RuntimeName;
  outcome: TurnOutcome<JsonValue>["kind"];
  items: Item[];
  summary?: string;
  reason?: string;
};

export type ToolsResult = { triages: Triage[] };

const PROMPT = [
  "Work through the open backlog items with your tools.",
  "Close the logo item as done: it was fixed yesterday.",
  'Label the backup item "ops" and "cron", then close it as wontfix, giving the item\'s title word',
  "for word as the reason.",
  "Then say how many items you closed.",
].join("\n");

const executable = defineExecutableWorkflow<ToolsArgs, ToolsResult>({
  definition: {
    meta: {
      name: "tools",
      description: "An agent closes backlog items through the workflow's tools.",
      whenToUse: "Use to check that agents call a workflow's tools from their prompt alone.",
    },
    async run(workflow, args) {
      const triages = await workflow.parallel(
        args.runtimes,
        async (runtime): Promise<Triage> => {
          const items: Item[] = ITEMS.map((item) => ({ ...item, status: "open" }));
          const open = (id: string) => {
            const item = items.find((each) => each.id === id && each.status === "open");
            if (!item) throw new Error(`no open item ${id}; list_open shows the open ones`);
            return item;
          };
          const agent = await workflow.agents.open({
            key: `triager:${runtime}`,
            runtime: RUNTIMES[runtime],
            tools: {
              list_open: tool({
                description: "The items still open, one per line: their id, then their title.",
                // Slowed past every limit on purpose, so only the turn's deadline bounds it.
                ...(args.slowMs ? { timeoutMs: false as const } : {}),
                handler: async () => {
                  if (args.slowMs) await new Promise((resolve) => setTimeout(resolve, args.slowMs));
                  const left = items.filter((item) => item.status === "open");
                  return left.map((item) => `${item.id}  ${item.title}`).join("\n") || "Nothing.";
                },
              }),
              close_item: tool({
                description: "Close an open item as done or won't fix, saying why.",
                input: CloseInput,
                handler: ({ id, status, why }) => {
                  Object.assign(open(id), { status, why });
                  return `Closed ${id}.`;
                },
              }),
              label_item: tool({
                description: "Set an open item's labels.",
                input: LabelInput,
                handler: ({ id, labels }) => {
                  open(id).labels = labels;
                  return `Labelled ${id}.`;
                },
              }),
            },
          });
          const { outcome } = await agent.run({
            prompt: PROMPT,
            schema: Summary,
            timeoutMs: 5 * 60_000,
          });
          return {
            runtime,
            outcome: outcome.kind,
            items,
            ...(isAnswered(outcome)
              ? { summary: outcome.value.summary }
              : { reason: outcome.reason }),
          };
        },
        { label: "Triage" },
      );
      return { triages };
    },
  },
  prepare: parseArgs,
  present: ({ triages }) =>
    triages
      .map(({ runtime, outcome, items, summary, reason }) =>
        [
          `${runtime}: ${outcome}${summary ? `, ${summary}` : reason ? `: ${reason}` : ""}`,
          ...items.map(
            (item) =>
              `  ${item.id} ${item.status}${item.labels ? ` [${item.labels.join(", ")}]` : ""}${item.why ? `: ${item.why}` : ""}`,
          ),
        ].join("\n"),
      )
      .join("\n"),
});

function parseArgs(invocation: WorkflowInvocation): ToolsArgs {
  const slow = invocation.argv.find((arg) => arg.startsWith("--slow="));
  const names = invocation.argv.filter((arg) => arg !== slow);
  const runtimes = names.length === 0 ? ["codex"] : names;
  for (const name of runtimes) {
    if (!Object.hasOwn(RUNTIMES, name)) {
      throw new Error(`unknown runtime ${name}; expected ${Object.keys(RUNTIMES).join(", ")}`);
    }
  }
  if (new Set(runtimes).size !== runtimes.length) throw new Error("name each runtime once");
  const slowMs = slow === undefined ? undefined : Number(slow.slice("--slow=".length));
  if (slowMs !== undefined && !(Number.isSafeInteger(slowMs) && slowMs > 0)) {
    throw new Error("--slow= takes milliseconds");
  }
  return {
    runtimes: runtimes as RuntimeName[],
    ...(slowMs === undefined ? {} : { slowMs }),
  };
}

export const tools = executable.definition;
export default executable;
