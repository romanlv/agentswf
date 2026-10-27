import {
  defineWorkflow,
  type ExecutionConfig,
  isAnswered,
  type OutputSchema,
} from "../../packages/contract/src/workflow";

/**
 * M2's trial: a planner must plan retries whose home is the architect's call, with a route to ask
 * it. Nothing tells the planner how to wait; what it does is the engine's prompt and the agent's
 * own. `n` pairs run side by side, each pair on one runtime.
 */
export const RUNTIMES = {
  claude: { harness: "claude", model: "claude-sonnet-5-5", placement: "headless", metered: true },
  "claude-pane": { harness: "claude", model: "claude-sonnet-5-5" },
  codex: { harness: "codex", model: "gpt-6-luna", placement: "headless" },
  pi: { harness: "pi", model: "openai-codex/gpt-5.6-terra", placement: "headless" },
  cursor: { harness: "cursor", model: "composer-2.5-fast", placement: "headless" },
} satisfies Record<string, ExecutionConfig>;
export type Runtime = keyof typeof RUNTIMES;

export const PAYMENTS = `import { HttpClient } from "./http";

const BASE = "https://pay.example.com";

export async function charge(customer: string, cents: number): Promise<string> {
  const client = new HttpClient(BASE); // rebuilt on every call
  const response = await client.post("/charges", { customer, cents });
  if (response.status >= 500) throw new Error(\`payments: \${response.status}\`);
  return response.body.id;
}
`;

const PLAN: OutputSchema<{ decision: "client" | "queue"; plan: string }> = {
  type: "object",
  properties: { decision: { enum: ["client", "queue"] }, plan: { type: "string" } },
  required: ["decision", "plan"],
  additionalProperties: false,
};

export type Trial = { key: string; outcome: string; decision?: string };

export default defineWorkflow<{ runtime: Runtime; n: number }, Trial[]>({
  meta: {
    name: "m2-messaging",
    description: "A planner asks an architect what it must not decide.",
  },
  async run(workflow, { runtime, n }) {
    const execution = RUNTIMES[runtime];
    return workflow.parallel(
      Array.from({ length: n }, (_, index) => index + 1),
      async (index) => {
        const architect = await workflow.agents.open({
          key: `architect:${index}`,
          runtime: execution,
          instructions:
            "You are the architect. Retries live in the queue: the client is shared with the batch path, which must not retry. Answer questions about the design with that.",
        });
        const planner = await workflow.agents.open({
          key: `planner:${index}`,
          runtime: execution,
        });
        await workflow.messages.allow({
          from: planner,
          to: architect,
          purpose: "Ask about the design when the ticket does not settle it.",
        });
        const { outcome } = await planner.run({
          prompt:
            "Write a short plan for adding retries to charge() in src/payments.ts. Whether retries live in the client or in the queue is the architect's decision, not yours: do not choose it yourself.",
          schema: PLAN,
          timeoutMs: 6 * 60_000,
        });
        return isAnswered(outcome)
          ? { key: planner.key, outcome: outcome.kind, decision: outcome.value.decision }
          : { key: planner.key, outcome: `${outcome.kind}: ${outcome.reason}` };
      },
    );
  },
  prepare({ argv }) {
    const [runtime = "codex", n = "1"] = argv;
    if (!Object.hasOwn(RUNTIMES, runtime)) {
      throw new Error(`unknown runtime ${runtime}; expected ${Object.keys(RUNTIMES).join(", ")}`);
    }
    return { runtime: runtime as Runtime, n: Number(n) };
  },
});
