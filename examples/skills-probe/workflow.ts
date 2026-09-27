import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type WorkflowInvocation,
} from "@wf/contract/workflow";
import Type from "typebox";
import Value from "typebox/value";
import { outputSchema } from "../output-schema";

/**
 * Agents given one probe skill each, which holds a word only it knows, on the host and in one srt
 * sandbox (story 007). Each reports the word and every skill it can see, so the host can check it
 * had exactly what it was given: its own probe, not the other, and none of the operator's.
 */
const CODEX = { harness: "codex", model: "gpt-6-luna", placement: "headless" } as const;
const PI = { harness: "pi", model: "openai-codex/gpt-5.6-terra", placement: "headless" } as const;
const CLAUDE = { harness: "claude", model: "claude-haiku-4-5" } as const;

export const AGENTS = {
  "host-codex": { runtime: CODEX, probe: "a", sandboxed: false },
  "host-pi": { runtime: PI, probe: "b", sandboxed: false },
  "host-claude": { runtime: CLAUDE, probe: "a", sandboxed: false },
  "box-codex": { runtime: CODEX, probe: "b", sandboxed: true },
  "box-pi": { runtime: PI, probe: "a", sandboxed: true },
} as const satisfies Record<
  string,
  { runtime: ExecutionConfig; probe: "a" | "b"; sandboxed: boolean }
>;

export type AgentName = keyof typeof AGENTS;

const PLAN = Type.Object({
  probes: Type.Object({ a: Type.String(), b: Type.String() }, { description: "Skill paths." }),
  agents: Type.Array(Type.String(), { description: "Which of AGENTS to run." }),
});

export type SkillsPlan = Type.Static<typeof PLAN>;

const REPORT = outputSchema(
  Type.Object(
    {
      word: Type.String({ description: "The probe word your skill gives, or empty." }),
      skills: Type.Array(Type.String(), { description: "The name of every skill you can use." }),
    },
    { additionalProperties: false },
  ),
);

export type SkillsReport = {
  agent: string;
  outcome: string;
  word?: string;
  skills?: string[];
  reason?: string;
};

const executable = defineExecutableWorkflow<SkillsPlan, { reports: SkillsReport[] }>({
  definition: {
    meta: {
      name: "skills-probe",
      description: "Give agents one probe skill each and ask what they can see.",
      whenToUse: "Use to check that each harness has exactly the skills a workflow names.",
    },
    async run(workflow, plan) {
      const box = await workflow.sandboxes.open({ key: "box", srt: {} });
      const reports = await workflow.parallel(
        plan.agents as AgentName[],
        async (name): Promise<SkillsReport> => {
          const given = AGENTS[name];
          const agent = await workflow.agents.open({
            key: name,
            runtime: given.runtime,
            skills: [{ path: plan.probes[given.probe] }],
            ...(given.sandboxed ? { sandbox: box } : {}),
          });
          const { outcome } = await agent.run({
            prompt: [
              "One of your skills gives a probe word. Use that skill to find the word; do not guess.",
              "Then list the name of every skill you can use, exactly as each is named, whether you",
              "used it or not. Leave the word empty if no skill gives one.",
            ].join(" "),
            schema: REPORT,
            timeoutMs: 4 * 60_000,
          });
          return isAnswered(outcome)
            ? { agent: name, outcome: outcome.kind, ...outcome.value }
            : { agent: name, outcome: outcome.kind, reason: outcome.reason };
        },
        { label: "Skills probe" },
      );
      return { reports };
    },
  },
  prepare: parsePlan,
  present: ({ reports }) =>
    reports
      .map((report) =>
        report.word === undefined
          ? `${report.agent}: ${report.outcome}: ${report.reason}`
          : `${report.agent}: ${report.word}; ${report.skills?.join(", ")}`,
      )
      .join("\n"),
});

/** One argument: the plan, as JSON. The host writes it, with the probes it made. */
function parsePlan(invocation: WorkflowInvocation): SkillsPlan {
  const [json] = invocation.argv;
  if (!json) throw new Error("pass the skills plan as one JSON argument");
  const plan: unknown = JSON.parse(json);
  if (!Value.Check(PLAN, plan)) throw new Error("not a skills plan");
  for (const name of plan.agents) {
    if (!Object.hasOwn(AGENTS, name)) throw new Error(`unknown agent ${name}`);
  }
  return plan;
}

export default executable;
