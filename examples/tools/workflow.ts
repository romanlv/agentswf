import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  tool,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import { outputSchema } from "../output-schema";
import { RUNTIMES } from "../quick-check/workflow";

type RuntimeName = keyof typeof RUNTIMES;

/** The backlog the agent works through; only its tools change it. */
type Item = { id: string; title: string; status: "open" | "done" | "wontfix"; why?: string };

const ITEMS: readonly Omit<Item, "status">[] = [
  { id: "a1", title: "The login page shows the old logo" },
  { id: "b2", title: "Nightly backup fails on Sundays; cron wrote '$HOME/backup' unexpanded" },
];

const CloseInput = outputSchema(
  Type.Object({
    id: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("done"), Type.Literal("wontfix")]),
    why: Type.String({ minLength: 1 }),
  }),
);

const Summary = outputSchema(
  Type.Object({ closed: Type.Integer({ minimum: 0 }), summary: Type.String({ minLength: 1 }) }),
);

export type ToolsArgs = { runtime: RuntimeName };
export type ToolsResult = { items: Item[]; summary?: string };

const executable = defineExecutableWorkflow<ToolsArgs, ToolsResult>({
  definition: {
    meta: {
      name: "tools",
      description: "An agent closes backlog items through the workflow's tools.",
      whenToUse: "Use to check that an agent calls a workflow's tools from its prompt alone.",
    },
    async run(workflow, args) {
      const items: Item[] = ITEMS.map((item) => ({ ...item, status: "open" }));
      const execution: ExecutionConfig = RUNTIMES[args.runtime];
      const agent = await workflow.agents.open({
        key: "triager",
        runtime: execution,
        tools: {
          list_open: tool({
            description: "The items still open, one per line: their id, then their title.",
            handler: () =>
              items
                .filter((item) => item.status === "open")
                .map((item) => `${item.id}  ${item.title}`)
                .join("\n") || "Nothing is open.",
          }),
          close_item: tool({
            description: "Close an open item as done or won't fix, saying why.",
            input: CloseInput,
            handler: ({ id, status, why }) => {
              const item = items.find((each) => each.id === id && each.status === "open");
              if (!item) throw new Error(`no open item ${id}; list_open shows the open ones`);
              item.status = status;
              item.why = why;
              return `Closed ${id}.`;
            },
          }),
        },
      });
      const { outcome } = await agent.run({
        prompt: [
          "Work through the open backlog items.",
          "Close the logo item as done: it was fixed yesterday.",
          "Close the backup item as wontfix, giving the item's title word for word as the reason.",
          "Then say how many items you closed.",
        ].join("\n"),
        schema: Summary,
        timeoutMs: 5 * 60_000,
      });
      return { items, ...(isAnswered(outcome) ? { summary: outcome.value.summary } : {}) };
    },
  },
  prepare: (invocation) => {
    const name = invocation.argv[0] ?? "codex";
    if (!Object.hasOwn(RUNTIMES, name)) {
      throw new Error(`unknown runtime ${name}; expected ${Object.keys(RUNTIMES).join(", ")}`);
    }
    return { runtime: name as RuntimeName };
  },
  present: ({ items, summary }) =>
    [
      ...items.map((item) => `${item.id} ${item.status}${item.why ? `: ${item.why}` : ""}`),
      ...(summary ? [summary] : []),
    ].join("\n"),
});

export const tools = executable.definition;
export default executable;
