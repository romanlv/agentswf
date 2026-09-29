import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type WorkflowInvocation,
} from "@agentswf/contract/workflow";
import Type from "typebox";
import Value from "typebox/value";
import { outputSchema } from "../output-schema";

/**
 * Agents given one of two probe skills each, on the host and in one srt sandbox (story 007). The
 * prompt never mentions skills: it asks for a release stamp and an audit seal of a build, and each
 * probe's description claims one of them. Only the script inside a probe can make its value, from
 * a secret no `SKILL.md` holds, so an agent that answers found the skill by its description and ran
 * its own copy of it. Each also lists every skill it can see, so the host can check it had exactly
 * what it was given.
 */
const CODEX = { harness: "codex", model: "gpt-6-luna", placement: "headless" } as const;
const PI = { harness: "pi", model: "openai-codex/gpt-5.6-terra", placement: "headless" } as const;
const CLAUDE = { harness: "claude", model: "claude-haiku-4-5" } as const;

/** Which probe makes which value. */
export const PROBE_FIELD = { a: "stamp", b: "seal" } as const;

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

const SOURCE = Type.Union([
  Type.Object({ path: Type.String() }),
  Type.Object({ repo: Type.String(), skill: Type.String() }),
]);

const PLAN = Type.Object({
  probes: Type.Object({ a: SOURCE, b: SOURCE }, { description: "Each probe's skill source." }),
  builds: Type.Record(Type.String(), Type.String(), { description: "Each agent's build id." }),
  agents: Type.Array(Type.String(), { description: "Which of AGENTS to run." }),
});

export type SkillsPlan = Type.Static<typeof PLAN>;

const REPORT = outputSchema(
  Type.Object(
    {
      stamp: Type.String({ description: "The build's release stamp, or empty." }),
      seal: Type.String({ description: "The build's audit seal, or empty." }),
      skills: Type.Array(Type.String(), { description: "The name of every skill you can use." }),
    },
    { additionalProperties: false },
  ),
);

export type SkillsReport = {
  agent: string;
  outcome: string;
  stamp?: string;
  seal?: string;
  skills?: string[];
  reason?: string;
};

const executable = defineExecutableWorkflow<SkillsPlan, { reports: SkillsReport[] }>({
  definition: {
    meta: {
      name: "skills-probe",
      description: "Give agents one probe skill each and ask for what only a probe can make.",
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
            skills: [plan.probes[given.probe]],
            ...(given.sandboxed ? { sandbox: box } : {}),
          });
          const build = plan.builds[name];
          if (!build) throw new Error(`no build id for ${name}`);
          const { outcome } = await agent.run({
            prompt: [
              `Build ${build} is ready. Give its release stamp and its audit seal.`,
              "Each has to be made properly, with what you have available; if you have no way to",
              "make one, give an empty string for it. Never invent or guess one.",
              "Then list the name of every skill you can use, exactly as each is named, whether you",
              "used it or not.",
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
        report.skills === undefined
          ? `${report.agent}: ${report.outcome}: ${report.reason}`
          : `${report.agent}: stamp ${report.stamp || "-"}, seal ${report.seal || "-"}; ${report.skills.join(", ")}`,
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
    if (!plan.builds[name]) throw new Error(`no build id for ${name}`);
  }
  return plan;
}

export default executable;
